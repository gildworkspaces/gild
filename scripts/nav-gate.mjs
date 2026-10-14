// Navigation gate: clicks through the repository tabs of a disposable local
// forge (compiled OpenNext Worker, local D1/DOs/Git) in headless Chrome and
// asserts, per hop: no full document reload, visual feedback < 100 ms, and
// settled < 600 ms. Prints a table (and appends it to the CI job summary).
//
//   node scripts/nav-gate.mjs [--chrome <path>] [--ttfb] [--report-only]
//
// --chrome     a Chrome/Chromium binary instead of the installed Google Chrome
// --ttfb       also time direct document requests for each tab (median of 15)
// --report-only  print the table, exit 0 even when a hop fails
//
// Visual feedback is the target tab becoming aria-current="page", or a
// navigation progress indicator: any [data-nav-pending] element, or the
// repository nav with aria-busy="true".
import { forgeFixture } from './forge-fixture.mjs'
import { launchChrome } from './chrome.mjs'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const FEEDBACK_MS = 100, SETTLED_MS = 600, QUIET_MS = 300, HOP_TIMEOUT_MS = 15000
const base = '/avatest/glance-test'
const hops = ['', '/issues', '/pulls', '/actions', '/agents', '', '/issues']
const name = (path) => path.slice(1) || 'code'

const f = await forgeFixture()
let browser, failed = false
try {
  const deadline = Date.now() + 120000
  while (true) {
    try { if ((await fetch(f.origin + base, { signal: AbortSignal.timeout(5000) })).status === 200) break } catch {}
    if (Date.now() > deadline) throw Error('Fixture startup: ' + f.logs.slice(-3000))
    await new Promise((r) => setTimeout(r, 250))
  }
  // Publish the public pages as the production queue would, then make first
  // hits (route compiles, isolates, DOs): the gate measures navigation, not that.
  await fetch(f.origin + '/__fixture/scheduled')
  for (let i = 0; i < 3; i++) await (await fetch(f.origin + '/__fixture/public-pages')).arrayBuffer()
  for (const p of new Set(hops)) {
    const end = Date.now() + 60000
    while ((await fetch(f.origin + base + p)).status !== 200) {
      if (Date.now() > end) throw Error(`${base + p} never returned 200`)
      await new Promise((r) => setTimeout(r, 250))
    }
    for (let i = 0; i < 2; i++) await (await fetch(f.origin + base + p)).arrayBuffer()
  }

  // Direct requests per tab: the document and the RSC payload a soft
  // navigation fetches. A public repo's tabs are published pages; a private
  // repo, read by its owner, renders the repository layout on every request.
  // Median of 15 each.
  const ttfb = []
  if (process.argv.includes('--ttfb')) {
    const median = async (path, headers) => {
      const samples = []
      for (let i = 0; i < 15; i++) {
        const t0 = performance.now(), r = await fetch(f.origin + path, { headers })
        const first = performance.now() - t0
        await r.arrayBuffer()
        const timing = r.headers.get('server-timing') ?? ''
        samples.push({ first, status: r.status, timing, server: Number((/w-total;dur=([\d.]+)/.exec(timing) ?? /total;dur=([\d.]+)/.exec(timing))?.[1] ?? NaN) })
      }
      samples.sort((a, b) => a.first - b.first)
      const m = samples[7]
      // Worker stages that took 1 ms or more, for the detail list under the table.
      const slow = m.timing.split(/,\s*/).filter((e) => /^w-/.test(e) && !/^w-total/.test(e) && Number(/dur=([\d.]+)/.exec(e)?.[1]) >= 1).map((e) => e.replace(/;dur=/, ' ')).join(', ')
      return { ttfb: Math.round(m.first), server: Number.isNaN(m.server) ? '-' : Math.round(m.server), status: m.status, slow }
    }
    for (const p of new Set(hops)) ttfb.push({ tab: name(p), doc: await median(base + p, {}), rsc: await median(base + p, { rsc: '1' }) })
    const repo = '/settingstest/demo', owner = { cookie: 'gild_session=' + f.cookie('avatest') }
    const flip = await fetch(f.origin + '/api/v1/repos' + repo + '/visibility', { method: 'PATCH', headers: { authorization: 'Bearer ' + f.tokens.avatest, 'content-type': 'application/json' }, body: JSON.stringify({ visibility: 'private' }) })
    if (!flip.ok) throw Error('private fixture: ' + flip.status + ' ' + (await flip.text()))
    for (const p of new Set(hops)) {
      for (let i = 0; i < 2; i++) await (await fetch(f.origin + repo + p, { headers: owner })).arrayBuffer()
      ttfb.push({ tab: 'private ' + name(p), doc: await median(repo + p, owner), rsc: await median(repo + p, { ...owner, rsc: '1' }) })
    }
  }

  browser = await launchChrome({ executablePath: arg('--chrome') })
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  // Feedback is timestamped in the page on the epoch clock, so it survives a
  // full reload: the target lives in sessionStorage, observed from document start.
  await page.addInitScript(() => {
    const check = () => {
      const key = sessionStorage.getItem('navGateTarget')
      if (!key || sessionStorage.getItem('navGateFeedback')) return
      if (document.querySelector(`nav[aria-label=Repository] a[data-tab="${key}"][aria-current=page], [data-nav-pending], nav[aria-label=Repository][aria-busy=true]`))
        sessionStorage.setItem('navGateFeedback', String(performance.timeOrigin + performance.now()))
    }
    new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true })
    check()
  })
  let documents = 0, last = Date.now()
  const open = new Map()
  const quiet = (r) => ['eventsource', 'websocket'].includes(r.resourceType())
  page.on('request', (r) => {
    if (quiet(r)) return
    if (r.resourceType() === 'document' && r.frame() === page.mainFrame()) documents++
    open.set(r, Date.now()); last = Date.now()
  })
  for (const e of ['requestfinished', 'requestfailed']) page.on(e, (r) => { if (open.delete(r)) last = Date.now() })

  await page.goto(f.origin + base + hops[0], { waitUntil: 'load' })
  const rows = []
  for (const path of hops.slice(1)) {
    const href = base + path, key = name(path)
    await page.waitForTimeout(QUIET_MS)
    await page.evaluate((k) => { window.__navGate = 'same-document'; sessionStorage.setItem('navGateTarget', k); sessionStorage.removeItem('navGateFeedback') }, key)
    const docs = documents, t0 = Date.now()
    await page.locator(`nav[aria-label=Repository] a[data-tab="${key}"]`).first().click({ timeout: HOP_TIMEOUT_MS }).catch(async (e) => {
      mkdirSync('.tmp/nav-gate', { recursive: true })
      writeFileSync('.tmp/nav-gate/failure.html', await page.content())
      await page.screenshot({ path: '.tmp/nav-gate/failure.png' })
      throw Error(`${page.url()}: no ${key} tab (page saved in .tmp/nav-gate)`, { cause: e })
    })
    let settled = null, feedback = null
    while (Date.now() - t0 < HOP_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 10))
      const state = await page.evaluate((k) => ({
        path: location.pathname,
        active: !!document.querySelector(`nav[aria-label=Repository] a[data-tab="${k}"][aria-current=page]`),
        feedback: sessionStorage.getItem('navGateFeedback'),
      }), key).catch(() => null) // the context is replaced during a full reload
      if (!state) continue
      if (state.feedback) feedback = Number(state.feedback) - t0
      const busy = [...open.values()].some((at) => Date.now() - at < 3000)
      if (state.path === href && state.active && !busy && Date.now() - last >= QUIET_MS) { settled = Math.round(Math.max(last, t0 + (feedback ?? 0)) - t0); break }
    }
    const soft = documents === docs && (await page.evaluate(() => window.__navGate).catch(() => null)) === 'same-document'
    const ok = { reload: soft, feedback: feedback !== null && feedback < FEEDBACK_MS, settled: settled !== null && settled < SETTLED_MS }
    if (!ok.reload || !ok.feedback || !ok.settled) failed = true
    rows.push({ hop: key, reload: soft ? 'none' : 'FULL', feedback: feedback === null ? 'none' : Math.round(feedback), settled: settled === null ? 'timeout' : settled, ok })
  }
  const mark = (pass, v) => (pass ? `${v}` : `**${v}** ✗`)
  const table = [
    `### Repository tab navigation (local, ${process.platform})`,
    '',
    `Budgets: no full reload · feedback < ${FEEDBACK_MS} ms · settled < ${SETTLED_MS} ms`,
    '',
    '| hop | document reload | feedback ms | settled ms |',
    '|---|---|---|---|',
    ...rows.map((r, i) => `| ${i ? rows[i - 1].hop : name(hops[0])} → ${r.hop} | ${mark(r.ok.reload, r.reload)} | ${mark(r.ok.feedback, r.feedback)} | ${mark(r.ok.settled, r.settled)} |`),
    ...(ttfb.length ? ['', '| tab (direct GET, median of 15) | document TTFB ms | document server-timing ms | RSC TTFB ms | RSC server-timing ms |', '|---|---|---|---|---|', ...ttfb.map((t) => `| ${t.tab} | ${t.doc.ttfb} (${t.doc.status}) | ${t.doc.server} | ${t.rsc.ttfb} (${t.rsc.status}) | ${t.rsc.server} |`),
      '', 'Worker stages >= 1 ms (server-timing `w-*`, median sample):', '', ...ttfb.flatMap((t) => [`- ${t.tab} document: ${t.doc.slow || '-'}`, `- ${t.tab} RSC: ${t.rsc.slow || '-'}`])] : []),
    '',
    failed ? '**FAIL**: at least one hop is over budget.' : '**PASS**',
  ].join('\n')
  console.log(table)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table + '\n')
} finally {
  await browser?.close()
  f.worker.kill('SIGTERM')
  await new Promise((r) => (f.worker.exitCode !== null ? r() : f.worker.once('exit', r)))
  await new Promise((r) => f.server.close(r))
}
if (failed && !process.argv.includes('--report-only')) process.exit(1)
