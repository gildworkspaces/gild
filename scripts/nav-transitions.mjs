// Deterministic production-worker acceptance: every directed tab pair, delayed
// payloads, browser history, bounded prefetch/Save-Data, and live islands.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { forgeFixture } from './forge-fixture.mjs'
import { publishRepoTabs } from './nav-fixture.mjs'
import { verifySignedInShell, verifyServerIdentity } from './signed-in-shell.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
let f = await forgeFixture({ renderBuild: false, staticReview: true })
const base = '/avatest/nav-test',
  tabs = ['code', 'issues', 'pulls', 'actions', 'agents', 'score']
const seed = () => f.seedRepo('u-avatest', 'nav-test', [
  {
    path: 'README.md',
    text:
      '# Navigation fixture\n\n' +
      Array.from(
        { length: 90 },
        (_, i) => `## Paragraph ${i}\n\nContent for scroll restoration.\n\n`,
      ).join(''),
  },
  {
    path: '.github/workflows/ci.yml',
    text: 'name: Fixture\non: workflow_dispatch\njobs:\n  test:\n    runs-on: self-hosted\n    steps:\n      - run: echo hello\n',
  },
])
seed()
const path = (tab) => base + (tab === 'code' ? '' : '/' + tab)
mkdirSync('.tmp/nav-review', { recursive: true })
let browser
const evidence = []
try {
  await publishRepoTabs(f, base)
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  for (const width of process.argv.includes('--warm-only')
    ? []
    : process.argv.includes('--cls-only')
      ? [400]
      : [1400, 400]) {
    const ctx = await browser.newContext({ viewport: { width, height: 1000 } })
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'connection', {
        value: { saveData: true, effectiveType: '4g' },
      })
      window.__shifts = []
      new PerformanceObserver((l) =>
        window.__shifts.push(
          ...l.getEntries().map((e) => ({
            value: e.value,
            recent: e.hadRecentInput,
            at: e.startTime,
            sources: e.sources?.map((s) => ({
              node: s.node?.outerHTML?.slice(0, 300),
              previous: s.previousRect.toJSON(),
              current: s.currentRect.toJSON(),
            })),
          })),
        ),
      ).observe({ type: 'layout-shift', buffered: true })
    })
    const page = await ctx.newPage(),
      errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    for (const from of process.argv.includes('--cls-only')
      ? ['code', 'score']
      : tabs)
      for (const to of process.argv.includes('--cls-only')
        ? [from === 'code' ? 'issues' : 'code']
        : tabs.filter((t) => t !== from)) {
        await page.goto(f.origin + path(from))
        await page.waitForFunction(
          () => document.documentElement.dataset.fragmentRouter === 'ready',
        )
        await page.evaluate(() => document.fonts.ready)
        await page.waitForTimeout(150)
        const marker = await page.evaluate(
            () => (window.__documentMarker = Math.random()),
          ),
          documents = []
        const onRequest = (req) => {
          if (req.isNavigationRequest() && req.frame() === page.mainFrame())
            documents.push(req.url())
        }
        page.on('request', onRequest)
        let release,
          requested = 0
        const gate = new Promise((r) => (release = r))
        await page.route(f.origin + path(to) + '*', async (route) => {
          if (route.request().resourceType() !== 'fetch')
            return route.continue()
          requested++
          await gate
          await route.continue()
        })
        const result = await page.evaluate((href) => {
          const link = [
              ...document.querySelectorAll('nav[aria-label=Repository] a'),
            ].find((a) => new URL(a.href).pathname === href),
            start = performance.now()
          link.click()
          return {
            ms: performance.now() - start,
            selected: link.getAttribute('aria-current'),
            pending: document.querySelector('[data-navigation-pending]')
              ?.dataset.navigationPending,
            skeleton: !!document.querySelector('[data-tab-skeleton]'),
            url: location.pathname,
          }
        }, path(to))
        assert.equal(
          result.selected,
          'page',
          `${from} -> ${to}: selected synchronously`,
        )
        assert.equal(
          result.pending,
          to,
          `${from} -> ${to}: pending synchronously`,
        )
        assert.equal(
          result.skeleton,
          true,
          `${from} -> ${to}: skeleton before fetch`,
        )
        assert.equal(result.url, path(to), 'URL same click')
        assert.ok(
          result.ms < 100,
          'same-frame feedback <100ms: ' + JSON.stringify(result),
        )
        await page.waitForTimeout(800)
        assert.equal(
          requested >= 1,
          true,
          'test must delay the actual payload fetch',
        )
        assert.ok(
          await page.locator('[data-tab-skeleton]').count(),
          'skeleton remains while response held',
        )
        if (width === 1400 && from === 'code' && to === 'issues') {
          await page.evaluate(() =>
            document.dispatchEvent(new Event('gild:tip-changed')),
          )
          const deadline = Date.now() + 10000
          while (requested < 2 && Date.now() < deadline)
            await page.waitForTimeout(50)
          assert.equal(
            requested,
            2,
            'tip changes restart the pending payload instead of committing a stale response',
          )
        }
        if (from === 'code' && to === 'issues')
          await page.screenshot({
            path: `.tmp/nav-review/skeleton-${width}.png`,
          })
        release()
        await page.waitForFunction(
          (href) =>
            document.documentElement.dataset.navigationReady?.startsWith(href),
          path(to),
        )
        await page.unroute(f.origin + path(to) + '*')
        assert.equal(
          await page.evaluate((m) => window.__documentMarker === m, marker),
          true,
          'document survives transition',
        )
        assert.deepEqual(
          documents,
          [],
          `${from} -> ${to}: no document navigation`,
        )
        if (from === 'code' && to === 'issues')
          await page.screenshot({
            path: `.tmp/nav-review/content-${width}.png`,
          })
        await page.waitForTimeout(150)
        const cls = await page.evaluate(() =>
          window.__shifts
            .filter((s) => !s.recent)
            .reduce((n, s) => n + s.value, 0),
        )
        assert.ok(cls < 0.01, `${width}px ${from} -> ${to}: CLS ${cls}`)
        evidence.push({
          width,
          from,
          to,
          feedbackMs: result.ms,
          cls,
          documents: documents.length,
        })
        writeFileSync(
          '.tmp/nav-review/evidence.json',
          JSON.stringify(evidence, null, 2),
        )
        page.off('request', onRequest)
      }
    // Clicking the already selected tab must preserve the document and scroll.
    for (const tab of tabs) {
      await page.goto(
        f.origin +
          path(tab) +
          (['code', 'score'].includes(tab) ? '?ref=main' : ''),
      )
      await page.waitForFunction(
        () => document.documentElement.dataset.fragmentRouter === 'ready',
      )
      const marker = await page.evaluate(
        () => (window.__documentMarker = Math.random()),
      )
      const docs = []
      const record = (r) => {
        if (r.isNavigationRequest() && r.frame() === page.mainFrame())
          docs.push(r.url())
      }
      page.on('request', record)
      await page.locator('[data-tab=' + tab + ']').evaluate((a) => a.click())
      await page.waitForTimeout(100)
      assert.deepEqual(docs, [], tab + ': selected tab click must not reload')
      assert.equal(
        await page.evaluate((m) => window.__documentMarker === m, marker),
        true,
      )
      page.off('request', record)
    }
    // Back/forward must use held payloads, even with the network disconnected.
    await page.goto(f.origin + base)
    await page.waitForFunction(
      () => document.documentElement.dataset.fragmentRouter === 'ready',
    )
    await page.evaluate(() => scrollTo(0, 640))
    await page.waitForTimeout(80)
    await page.locator('[data-tab=issues]').evaluate((a) => a.click())
    await page.waitForFunction(() =>
      document.documentElement.dataset.navigationReady?.includes('/issues'),
    )
    await page.setViewportSize({ width, height: 300 })
    await page.evaluate(() => scrollTo(0, 100))
    await page.waitForTimeout(80)
    const issuesY = await page.evaluate(() => scrollY)
    await page.locator('[data-tab=code]').evaluate((a) => a.click())
    await page.waitForFunction(
      () =>
        document.documentElement.dataset.navigationReady ===
        location.pathname + location.search + location.hash,
    )
    await ctx.setOffline(true)
    await page.goBack()
    await page.waitForFunction(
      () =>
        location.pathname.endsWith('/issues') &&
        document.documentElement.dataset.navigationReady?.includes('/issues'),
    )
    assert.equal(
      await page.evaluate(() => scrollY),
      issuesY,
      'back restores Issues entry',
    )
    await page.goBack()
    await page.waitForFunction(
      () =>
        !location.pathname.endsWith('/issues') &&
        document.documentElement.dataset.navigationReady ===
          location.pathname + location.search + location.hash,
    )
    assert.equal(
      await page.evaluate(() => scrollY),
      640,
      'back restores original Code entry',
    )
    await page.goForward()
    await page.waitForFunction(
      () =>
        location.pathname.endsWith('/issues') &&
        document.documentElement.dataset.navigationReady?.includes('/issues'),
    )
    assert.equal(
      await page.evaluate(() => scrollY),
      issuesY,
      'forward restores Issues entry',
    )
    assert.deepEqual(errors, [], 'no browser exceptions')
    await ctx.close()
    console.log(
      'PASS every directed tab transition + delayed response + CLS + offline history at ' +
        width +
        'px',
    )
  }
  // The all-pairs stress deliberately enters Agents repeatedly and can consume
  // the anonymous API read allowance. Prove live islands against a fresh real
  // forge; retain production rate limits in both fixtures.
  if (!process.argv.includes('--warm-only')) {
    f.worker.kill('SIGTERM')
    await new Promise((resolve) =>
      f.worker.exitCode !== null ? resolve() : f.worker.once('exit', resolve),
    )
    f.server.closeAllConnections()
    await new Promise((resolve) => f.server.close(resolve))
    f = await forgeFixture({ renderBuild: false, staticReview: true })
    seed()
    await publishRepoTabs(f, base)
  }
  // Real controls after soft navigation: Actions filtering and channel fetch,
  // connection/cleanup are provided by the existing React islands.
  const ctx = await browser.newContext(),
    page = await ctx.newPage(),
    requests = []
  page.on('request', (r) =>
    requests.push({ url: r.url(), type: r.resourceType() }),
  )
  const prefetches = new Set()
  let prefetchTotal = 0,
    prefetchPeak = 0,
    currentCodePrefetches = 0
  page.on('request', (r) => {
    if (r.headers()['x-gild-prefetch'] !== 'repo-tab') return
    prefetches.add(r)
    prefetchTotal++
    if (new URL(r.url()).pathname === base) currentCodePrefetches++
    prefetchPeak = Math.max(prefetchPeak, prefetches.size)
  })
  for (const event of ['requestfinished', 'requestfailed'])
    page.on(event, (r) => prefetches.delete(r))
  await page.addInitScript(() => {
    window.__prefetched = []
    window.__channelPrefetched = []
    document.addEventListener('gild:channel-prefetched', e => window.__channelPrefetched.push(e.detail))
    document.addEventListener('gild:prefetched', (e) =>
      window.__prefetched.push(new URL(e.detail).pathname),
    )
  })
  let releasePrefetch
  const prefetchGate = new Promise((resolve) => (releasePrefetch = resolve))
  const tabPattern = new RegExp(
    '/avatest/nav-test/(issues|pulls|actions|agents|score)(?:\\?|$)',
  )
  await page.route(tabPattern, async (route) => {
    if (route.request().resourceType() === 'fetch') await prefetchGate
    await route.continue()
  })
  await page.goto(f.origin + base)
  await page.waitForFunction(
    () => document.documentElement.dataset.fragmentRouter === 'ready',
  )
  const styleAddresses = await page.evaluate(() =>
    JSON.parse(document.querySelector('#gild-tab-styles').textContent),
  )
  assert.ok(
    styleAddresses.length > 0,
    "Code has the completed build's tab stylesheet addresses",
  )
  await page.waitForFunction(
    (styles) =>
      styles.every((url) =>
        [...document.querySelectorAll('link[rel=stylesheet]')].some(
          (link) => new URL(link.href).pathname === url && link.sheet,
        ),
      ),
    styleAddresses,
  )
  releasePrefetch()
  // Explicit intent warms the non-adjacent tabs; automatic page-load work is
  // limited to neighbors so it does not compete with the current page.
  await page.locator('nav[aria-label=Repository] a[data-tab]').evaluateAll(links => {
    for (const link of links) link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
  await page.waitForFunction(
    (base) =>
      ['issues', 'pulls', 'actions', 'agents', 'score'].every((tab) =>
        window.__prefetched.includes(base + '/' + tab),
      ),
    base,
  )
  await page.unroute(tabPattern)
  await page.waitForFunction(repository => window.__channelPrefetched.includes(repository), base.slice(1))
  assert.ok(
    prefetchPeak <= 2,
    'speculative tab fetches are bounded to two concurrent requests',
  )
  assert.ok(
    prefetchTotal <= 6,
    'idle tab prefetch is bounded to this repository/ref',
  )
  assert.equal(currentCodePrefetches, 0, 'tab warmup reuses the painted Code document for its explicit current-ref link')
  for (const tab of tabs.slice(1).concat('code')) {
    const before = requests.length,
      result = await page.locator('[data-tab=' + tab + ']').evaluate((a) => {
        const start = performance.now()
        a.click()
        return {
          ms: performance.now() - start,
          ready:
            document.documentElement.dataset.navigationReady ===
            location.pathname + location.search + location.hash,
          pending: !!document.querySelector('[data-navigation-pending]'),
        }
      })
    assert.ok(
      result.ready && !result.pending,
      'warm tab content commits in the click: ' + tab,
    )
    assert.ok(result.ms < 300, 'warm content <300ms: ' + JSON.stringify(result))
    assert.ok(
      !requests
        .slice(before)
        .some(
          (r) =>
            r.type === 'document' ||
            (r.type === 'script' && r.url.includes('/_next/')),
        ),
      'no Next/document waterfall on warm click',
    )
    evidence.push({ warm: true, tab, contentMs: result.ms })
    writeFileSync(
      '.tmp/nav-review/evidence.json',
      JSON.stringify(evidence, null, 2),
    )
  }
  await page.locator('[data-tab=actions]').evaluate((a) => a.click())
  await page.getByRole('button', { name: 'ci.yml', exact: true }).click()
  await page.getByRole('heading', { name: 'Fixture', exact: true }).waitFor()
  const participantReads = () => requests.filter(r => new URL(r.url).pathname.endsWith('/channel/participants')).length
  const primedParticipants = participantReads()
  const initialPresence = new Promise(resolve => page.on('websocket', socket => {
    if (!new URL(socket.url()).pathname.endsWith('/channel/stream')) return
    socket.on('framereceived', frame => { if (JSON.parse(String(frame.payload)).type === 'presence') resolve() })
  }))
  await page.locator('[data-tab=agents]').evaluate((a) => a.click())
  await page
    .getByRole('status', { name: 'Channel connection' })
    .filter({ hasText: 'live' })
    .waitFor()
  await initialPresence
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(participantReads(), primedParticipants, 'prefetched anonymous snapshot avoids a redundant join-time participants read')
  await page.locator('[data-tab=issues]').evaluate((a) => a.click())
  await page
    .getByRole('link', { name: 'Sign in to open an issue', exact: true })
    .waitFor()
  await ctx.close()
  // A direct private Next entry must enter the same standalone router after
  // authorization, with the rail/search controls still interactive.
  await verifyServerIdentity({ browser, fixture: f, base })
  await verifySignedInShell({ browser, fixture: f, base, visibility: 'public' })
  const privateResponse = await fetch(
    f.origin + '/api/v1/repos/avatest/nav-test/visibility',
    {
      method: 'PATCH',
      headers: {
        authorization: 'Bearer ' + f.tokens.avatest,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ visibility: 'private' }),
    },
  )
  assert.equal(privateResponse.status, 200, await privateResponse.text())
  await verifySignedInShell({ browser, fixture: f, base, visibility: 'private' })
  const owner = await browser.newContext({
    viewport: { width: 400, height: 1000 },
  })
  await owner.addCookies([
    { name: 'gild_session', value: f.cookie('avatest'), url: f.origin },
  ])
  const privatePage = await owner.newPage(),
    privateErrors = []
  privatePage.on('pageerror', (e) => privateErrors.push(e.message))
  await privatePage.goto(f.origin + base + '/issues', { timeout: 120000 })
  await privatePage.waitForFunction(
    () => document.documentElement.dataset.fragmentRouter === 'ready',
  )
  const privateMarker = await privatePage.evaluate(
    () => (window.__privateMarker = Math.random()),
  )
  for (const tab of ['code', 'actions', 'agents', 'pulls', 'issues']) {
    await privatePage.locator('[data-tab=' + tab + ']').click()
    await privatePage.waitForFunction(
      () =>
        document.documentElement.dataset.navigationReady ===
        location.pathname + location.search + location.hash,
    )
    assert.equal(
      await privatePage.evaluate(
        (m) => window.__privateMarker === m,
        privateMarker,
      ),
      true,
      'private tab preserves document: ' + tab,
    )
    if (tab === 'actions') {
      await privatePage.getByRole('button', { name: 'ci.yml', exact: true }).click()
      const dispatch = privatePage.getByRole('button', { name: 'Run workflow', exact: true })
      await dispatch.waitFor()
      assert.equal(await dispatch.isEnabled(), true, 'private Actions island retains owner write controls')
    }
    if (tab === 'issues' || tab === 'pulls') {
      await privatePage.getByRole('link', { name: tab === 'issues' ? 'New issue' : 'New pull request', exact: true }).waitFor()
    }
  }
  await privatePage
    .getByRole('button', { name: 'Search code', exact: true })
    .click()
  await privatePage
    .getByRole('dialog', { name: 'Search code', exact: true })
    .waitFor()
  await privatePage
    .getByRole('button', { name: 'Close search', exact: true })
    .click()
  await privatePage.locator('[data-tab=code]').evaluate((a) => a.click())
  await privatePage.waitForFunction(
    () =>
      document.documentElement.dataset.navigationReady ===
      location.pathname + location.search + location.hash,
  )
  await privatePage.locator('[data-branch]').selectOption('feature')
  await privatePage.waitForFunction(() =>
    document.documentElement.dataset.navigationReady?.includes('ref=feature'),
  )
  assert.equal(
    await privatePage.evaluate(
      (m) => window.__privateMarker === m,
      privateMarker,
    ),
    true,
    'branch selector remains soft after direct Issues -> Code',
  )
  await privatePage.locator('[data-tab=issues]').evaluate((a) => a.click())
  await privatePage.waitForFunction(() =>
    document.documentElement.dataset.navigationReady?.includes('/issues'),
  )
  await privatePage.locator('[data-tab=code]').evaluate((a) => a.click())
  await privatePage.waitForFunction(() =>
    document.documentElement.dataset.navigationReady?.includes('ref=feature'),
  )
  assert.deepEqual(
    privateErrors,
    [],
    'private islands have no competing Next runtime',
  )
  assert.equal(
    (await fetch(f.origin + base + '/issues')).status,
    404,
    'private payload is not available anonymously',
  )
  // Clearing authentication also clears aliases: the outgoing DOM cannot be
  // snapshotted back into the cache and exposed on a later tab visit.
  await owner.clearCookies()
  await privatePage.evaluate(() =>
    document.dispatchEvent(new Event('gild:private-cleared')),
  )
  await privatePage.locator('[data-tab=code]').evaluate((a) => a.click())
  await privatePage
    .getByRole('alert')
    .filter({ hasText: 'Could not load this tab' })
    .waitFor()
  await privatePage.locator('[data-tab=issues]').evaluate((a) => a.click())
  await privatePage
    .getByRole('alert')
    .filter({ hasText: 'Could not load this tab' })
    .waitFor()
  assert.ok(
    !(await privatePage.locator('[data-page-body]').textContent()).includes(
      'Settings fixture issue',
    ),
    'private aliases stay cleared after logout',
  )
  await owner.close()
  console.log(
    'PASS direct private entry, all tabs, search, and anonymous denial',
  )
  writeFileSync(
    '.tmp/nav-review/evidence.json',
    JSON.stringify(evidence, null, 2),
  )
  console.log(
    'PASS live Actions/Agents/Create islands after fragment transitions',
  )
} catch (error) {
  writeFileSync('.tmp/nav-review/worker.log', f.logs)
  writeFileSync('.tmp/nav-review/failure.txt', error.stack ?? String(error))
  for (const [i, page] of (
    browser?.contexts().flatMap((c) => c.pages()) ?? []
  ).entries()) {
    try {
      writeFileSync(`.tmp/nav-review/failure-${i}.html`, await page.content())
      writeFileSync(
        `.tmp/nav-review/failure-${i}.json`,
        JSON.stringify(
          await page.evaluate(() => ({
            url: location.href,
            ready: document.documentElement.dataset.navigationReady,
            shifts: window.__shifts,
          })),
          null,
          2,
        ),
      )
      await page
        .screenshot({ path: `.tmp/nav-review/failure-${i}.png` })
        .catch(() => {})
    } catch {}
  }
  throw error
} finally {
  await browser?.close()
  f.worker.kill('SIGTERM')
  await new Promise((r) =>
    f.worker.exitCode !== null ? r() : f.worker.once('exit', r),
  )
  f.server.closeAllConnections()
  await new Promise((r) => f.server.close(r))
}
