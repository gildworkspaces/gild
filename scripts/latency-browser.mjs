// Page-load latency gate (gild-site perf budget) on the compiled OpenNext
// Worker in local workerd, with every D1/R2/DO/upstream round trip slowed to
// a production-like cost (forgeFixture latency). Real headless Chrome loads
// each key page signed out and signed in, cold (new browser context) and
// warm (reload), and the gate asserts the budget:
//   * no /api/* fetch on page load: per-viewer data arrives in the page's own
//     server response (RSC), never in a post-hydration waterfall;
//   * settled (last response of the load) <= 600 ms cold and <= 300 ms warm.
// Usage: node scripts/latency-browser.mjs [label] [--report-only]
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { launchChrome } from './chrome.mjs'
import { forgeFixture } from './forge-fixture.mjs'
import { publicPageRoute } from '../lib/public-page-route.ts'

const label = process.argv.find((a, i) => i > 1 && !a.startsWith('--')) ?? 'after'
const reportOnly = process.argv.includes('--report-only')
export const ROUND_TRIP_MS = 25
export const BUDGET = { cold: 600, warm: 300 }
// The document's own server time (Worker total) at ROUND_TRIP_MS per round trip.
export const SERVER_BUDGET_MS = 150
const SAMPLES = 3
const repo = 'settingstest/demo', base = '/' + repo
export const PAGES = [base, base + '/issues', base + '/issues/1', base + '/pulls', base + '/actions', base + '/agents', '/settingstest', '/', '/docs/api']

const f = await forgeFixture({ latency: ROUND_TRIP_MS })
let browser
const api = async (path, init = {}) => {
  const r = await fetch(f.origin + path, { ...init, headers: { authorization: 'Bearer ' + f.tokens.avatest, ...init.headers }, signal: AbortSignal.timeout(120000) })
  return { ok: r.ok, status: r.status, text: await r.text() }
}
async function until(what, probe, ms = 180000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (f.worker.exitCode !== null) throw Error('worker exited: ' + f.logs.slice(-3000))
    if (await probe().catch(() => false)) return
    await new Promise((r) => setTimeout(r, 400))
  }
  throw Error('Timed out: ' + what + '\n' + f.logs.slice(-3000))
}
/** One page load: every request it made, when the load settled, and the
 *  document's server-timing. A WebSocket is live updating, not loading. */
async function load(context, path) {
  const page = await context.newPage()
  const response = await page.goto(f.origin + path, { waitUntil: 'networkidle' })
  const trace = response.headers()['x-fixture-io']
  const io = trace ? await (await fetch(f.origin + '/__fixture/io?trace=' + trace)).json() : null
  const r = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0]
    // Settled counts this site's own responses. Third-party images (Gravatar
    // avatars) depend on that service, not on this page, and are reported apart;
    // the browser asks for the favicon on its own schedule, after load.
    const all = performance.getEntriesByType('resource'), resources = all.filter((e) => new URL(e.name).origin === location.origin && !/\/favicon\./.test(e.name))
    const root = '/' + location.pathname.split('/').filter(Boolean).slice(0, 2).join('/')
    const tabs = ['', '/issues', '/pulls', '/actions', '/agents', '/score'].map(tab => root + tab)
    return {
      status: nav.responseStatus,
      tabFetches: resources.filter(e => e.initiatorType === 'fetch' && tabs.includes(new URL(e.name).pathname)).map(e => new URL(e.name).pathname),
      ttfb: Math.round(nav.responseStart),
      settled: Math.round(Math.max(nav.responseEnd, ...resources.map((e) => e.responseEnd))),
      thirdParty: Math.round(Math.max(0, ...all.filter((e) => !resources.includes(e)).map((e) => e.responseEnd))),
      last: [...resources].sort((a, b) => b.responseEnd - a.responseEnd).slice(0, 2).map((e) => `${new URL(e.name).pathname.split('/').pop().slice(0, 24)}@${Math.round(e.startTime)}+${Math.round(e.duration)}`).join(' '),
      server: nav.serverTiming.filter((t) => t.name.startsWith('w-') && t.duration > 0).map((t) => `${t.name}=${Math.round(t.duration)}`).join(' '),
      serverTotal: Math.round(nav.serverTiming.find((t) => t.name === 'w-total')?.duration ?? 0),
      api: resources.filter((e) => new URL(e.name).pathname.startsWith('/api/')).map((e) => ({ path: new URL(e.name).pathname + new URL(e.name).search, ms: Math.round(e.duration) })),
    }
  })
  await page.close()
  return { path, ...r, io: io?.length ?? null, ioTrace: io }
}
try {
  await until('worker start', async () => (await fetch(f.origin + '/api/v1/openapi.json')).ok)
  await fetch(f.origin + '/__fixture/refresh?key=' + repo)
  await until('index ' + repo, async () => (await api('/api/v1/repos/' + repo)).ok)
  await until('history ' + repo, async () => (await (await fetch(f.origin + '/__fixture/history?key=' + repo)).json()).ready)
  await until('public pages', async () => (await fetch(f.origin + '/__fixture/public-pages')).ok)
  // Production publishes every public page (cron and writes); publish each
  // gated page here so signed-out loads measure the stored copy.
  // Code is stitched from fragments; docs use the build-document cache.
  // Only routes handled by the public-page publisher need a published row.
  for (const path of PAGES.filter(path => publicPageRoute(new URL(path, f.origin))))
    await until('publish ' + path, async () => (await (await fetch(f.origin + '/__fixture/public-pages?route=' + encodeURIComponent(path))).json()).published)
  browser = await launchChrome()
  const rows = []
  const contextFor = async (viewer) => {
    const context = await browser.newContext()
    if (viewer === 'signed-in') await context.addCookies([{ name: 'gild_session', value: f.cookie('avatest'), url: f.origin }])
    return context
  }
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  for (const viewer of ['anonymous', 'signed-in']) for (const path of PAGES) {
    // Warm the Worker's isolate and caches for this route first: "cold" is a
    // first visit by this browser, not the first request the Worker sees.
    const first = await contextFor(viewer)
    await load(first, path)
    await first.close()
    // Three samples of each; the gate reads the median (this host is shared).
    const cold = [], warm = []
    for (let i = 0; i < SAMPLES; i++) {
      const context = await contextFor(viewer)
      cold.push(await load(context, path))
      warm.push(await load(context, path))
      await context.close()
    }
    for (const [pass, samples] of [['cold', cold], ['warm', warm]]) {
      const settled = median(samples.map((r) => r.settled)), at = samples.find((r) => r.settled === settled)
      // Server time gates on the best sample: it measures the round trips a page
      // makes, which host contention can only add to; settled uses the median.
      rows.push({ viewer, pass, ...at, settled, samples, serverMedian: median(samples.map(r => r.serverTotal)), serverMax: Math.max(...samples.map(r => r.serverTotal)), settledMax: Math.max(...samples.map(r => r.settled)), serverTotal: Math.min(...samples.map((r) => r.serverTotal)), api: samples.flatMap((r) => r.api) })
    }
  }
  // Only the Worker may hand page reads to the render: a forged header naming
  // another viewer must be discarded at the edge of the Worker.
  const entity = (key) => ({ key, id: key, archived: false, deletedAt: null, moving: false, description: null, defaultBranch: null, previous: [] })
  const forged = encodeURIComponent(JSON.stringify({ address: 'settingstest', states: { settingstest: entity('settingstest') }, access: { id: '', value: null }, aliased: false, ownerAliased: false,
    canonical: { state: entity('settingstest'), stars: 0, starred: false }, role: 'owner', viewer: { name: 'avatest', email: null, profile: null }, ownerKey: 'settingstest', org: null }))
  const asOutsider = await (await fetch(f.origin + '/settingstest', { headers: { cookie: 'gild_session=' + f.cookie('outsider'), 'x-gild-page-reads': forged } })).text()
  assert.match(asOutsider, /data-tip="@outsider"/, 'the page renders for the cookie\'s viewer')
  assert.doesNotMatch(asOutsider, /data-tip="@avatest"/, 'a forged x-gild-page-reads header must not choose the viewer')
  const table = ['| viewer | page | pass | status | TTFB | settled | third-party images done | document round trips | /api fetches | document server-timing | last responses |', '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.viewer} | \`${r.path}\` | ${r.pass} | ${r.status} | ${r.ttfb} | ${r.settled} | ${r.thirdParty || '-'} | ${r.io} | ${r.api.map((a) => `${a.path} (${a.ms})`).join(', ') || 'none'} | ${r.server} | ${r.last} |`)].join('\n')
  mkdirSync('.tmp', { recursive: true })
  writeFileSync(`.tmp/latency-${label}.md`, `round trip ${ROUND_TRIP_MS} ms, median of ${SAMPLES}, budget ${BUDGET.cold}/${BUDGET.warm} ms settled, ${SERVER_BUDGET_MS} ms document server time\n\n` + table + '\n')
  writeFileSync(`.tmp/latency-${label}.json`, JSON.stringify(rows, null, 2))
  console.log(table)
  if (!reportOnly) {
    for (const r of rows) {
      assert.equal(r.status, 200, `${r.viewer} ${r.path}: status ${r.status}`)
      assert.deepEqual(r.api, [], `${r.viewer} ${r.path} (${r.pass}) fetched per-viewer data after load`)
      assert.ok(r.tabFetches.length <= 2, `${r.viewer} ${r.path} (${r.pass}) loads at most two adjacent tabs automatically: ${r.tabFetches.join(', ')}`)
      assert.ok(!r.tabFetches.includes(r.path), `${r.viewer} ${r.path} (${r.pass}) does not refetch the painted tab`)
      assert.ok(r.serverTotal <= SERVER_BUDGET_MS, `${r.viewer} ${r.path} (${r.pass}) document server time ${r.serverTotal} ms (best of ${SAMPLES}) > ${SERVER_BUDGET_MS} ms`)
      assert.ok(r.settled <= BUDGET[r.pass], `${r.viewer} ${r.path} (${r.pass}) settled in ${r.settled} ms (median of ${SAMPLES}) > ${BUDGET[r.pass]} ms`)
    }
    console.log(`PASS latency: ${PAGES.length * 2} pages x cold/warm (median of ${SAMPLES}), no /api fetch on load, document server time <= ${SERVER_BUDGET_MS} ms, settled within ${BUDGET.cold}/${BUDGET.warm} ms at ${ROUND_TRIP_MS} ms per round trip`)
  }
} finally {
  await browser?.close()
  f.worker.kill('SIGTERM')
  await new Promise(resolve => f.worker.exitCode !== null ? resolve() : f.worker.once('exit', resolve))
  await new Promise((r) => f.server.close(r))
}
// Separate evidence: retain every first-request sample and its tail rather
// than describing the warmed median gate as server-cold performance.
if (!reportOnly) execFileSync(process.execPath, ['scripts/latency-server-cold.mjs', f.work], { stdio: 'inherit' })
