import { createHmac } from 'node:crypto'
import { launchChrome } from './chrome.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
export async function browserChecks(origin, get, transferred = () => 0, sourceNavigationOnly = false, pendingRetryOnly = false) {
  const browser = await launchChrome(),
    evidence = { opens: [], delta: [], screenshots: [] }
  const errors = []
  mkdirSync('.tmp/fragments-review', { recursive: true })
  try {
    await get('/__seed?version=1')
    const page = await browser.newPage({
      viewport: { width: 1400, height: 1100 },
    })
    page.on('pageerror', (e) => {
      errors.push(e.message)
      console.log('PAGE ERROR', e.message)
    })
    page.on('requestfailed', (r) =>
      console.log('REQUEST FAILED', r.url(), r.failure()),
    )
    await page.addInitScript(() => {
      window.__prefetched = []
      document.addEventListener('gild:prefetched', (e) =>
        window.__prefetched.push(e.detail),
      )
      window.__navTimes = []
      window.__clickAt = 0
      window.__pendingTransitions = 0
      window.__committedTransitions = 0
      document.addEventListener('gild:tab-pending', () => window.__pendingTransitions++)
      document.addEventListener('gild:navigated', () => window.__committedTransitions++)
      new MutationObserver((rows) => {
        for (const r of rows)
          if (r.attributeName === 'data-navigation-ready' && window.__clickAt)
            window.__navTimes.push(performance.now() - window.__clickAt)
      }).observe(document, { attributes: true, subtree: true })
    })
    // Hold the load event open. A source Worker cannot download the bundle
    // before it exists, so this tests ordering without a timing threshold.
    let releaseLoad,seenLoad
    const loadGate=new Promise(r=>{releaseLoad=r}),loadSeen=new Promise(r=>{seenLoad=r})
    await page.route('**/__hold_load.svg',async route=>{seenLoad();await loadGate;await route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'})})
    await page.addInitScript(()=>{
      window.__sourceWorkers=[]
      const NativeWorker=window.Worker
      window.Worker=class extends NativeWorker {constructor(url,options){super(url,options);window.__sourceWorkers.push(String(url))}}
      document.addEventListener('DOMContentLoaded',()=>{const image=new Image();image.style.position='absolute';image.src='/__hold_load.svg';document.body.append(image)},{once:true})
    })
    const faviconLoaded = page.waitForResponse(r => r.url().endsWith('/favicon.svg'))
    // Observe teardown rejection immediately; the original promise is still
    // awaited below so a missing favicon fails the positive browser check.
    faviconLoaded.catch(() => {})
    try {
      await page.goto(origin + '/acme/demo',{waitUntil:'domcontentloaded'})
      await loadSeen
      await page.waitForFunction(()=>document.documentElement.dataset.fragmentRouter==='ready')
      await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestIdleCallback(r))))))
      assert.deepEqual(await page.evaluate(()=>window.__sourceWorkers),[],'source bundle Worker must wait for the page load event')
    }finally{releaseLoad()}
    await page.waitForLoadState('load')
    await faviconLoaded
    // Playwright routing disables the HTTP cache for the whole page. Remove
    // the load gate and reload before checking immutable asset reuse.
    await page.unroute('**/__hold_load.svg')
    await page.reload()
    await page.waitForFunction(
      () =>
        document.documentElement.dataset.sourceReady === '4'.repeat(40) ||
        document.documentElement.dataset.sourceError,
    )
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.sourceError),
      undefined,
    )
    // Repo-tab removals exercise source navigation in isolation. The default
    // full browser gate retains the Pending retry scenario and its original wait.
    if (!sourceNavigationOnly) {
      // A not-yet-prepared commit is a data state inside this document, not a
      // navigation error or a second document load. Retry the real artifact.
      await page.setViewportSize({ width: 1400, height: 420 })
      await page.evaluate(() => window.scrollTo(0, 120))
      const priorEntry = await page.evaluate(() => ({ url: location.href, scroll: scrollY, length: history.length }))
      assert.ok(priorEntry.scroll > 0, 'real repository chrome provides a nonzero scroll position')
      const commitPath = '/acme/demo/commit/' + '1'.repeat(40)
      await page.route('**/api/fragments/acme/demo*', async route => {
        if (new URL(route.request().url()).searchParams.get('page') !== 'commit') return route.continue()
        return route.fulfill({ status: 202, contentType: 'application/json', headers: { 'x-gild-state': 'pending' }, body: JSON.stringify({ state: 'pending', retryAfter: 3 }) })
      })
      const marker = await page.evaluate(path => {
        window.__pendingDocument = Math.random()
        const link = document.createElement('a')
        link.href = path
        document.body.append(link)
        link.click()
        link.remove()
        return window.__pendingDocument
      }, commitPath)
      await page.locator('[data-artifact-pending]').waitFor()
      assert.equal(await page.evaluate(() => window.__pendingDocument), marker, 'Pending retains the current document')
      assert.equal(await page.locator('[data-repository]').getAttribute('data-repository'), 'acme/demo', 'Pending retains repository chrome')
      assert.match(await page.locator('[data-artifact-pending]').innerText(), /Pending/)
      assert.equal(await page.locator('[role="alert"]').count(), 0, 'Pending is not presented as an error')
      const pendingEntry = await page.evaluate(() => {
        History.prototype.replaceState.call(history, { ...history.state, retryFixtureToken: 'same-entry' }, '')
        return { length: history.length, url: location.href }
      })
      assert.equal(pendingEntry.length, priorEntry.length + 1, 'initial commit navigation creates one history entry')
      for (let i = 0; i < 2; i++) {
        const before = await page.evaluate(() => {
          window.scrollTo(0, 120)
          const previous = { scroll: scrollY, transitions: window.__pendingTransitions, marker: window.__pendingDocument }
          document.querySelector('[data-pending-retry]').click()
          return previous
        })
        assert.ok(before.scroll > 0, 'Pending retry starts at a real nonzero scroll position')
        await page.waitForFunction(previous => window.__pendingDocument !== previous.marker || window.__pendingTransitions > previous.transitions, before)
        assert.equal(await page.evaluate(() => window.__pendingDocument), marker, 'manual Pending retry retains the current document immediately after click')
        const after = await page.evaluate(() => ({ length: history.length, scroll: scrollY, token: history.state?.retryFixtureToken, savedScroll: history.state?.gildScrollY }))
        assert.equal(after.length, pendingEntry.length, 'still-Pending retry preserves history length')
        assert.equal(after.scroll, before.scroll, 'still-Pending retry preserves scroll')
        assert.equal(after.savedScroll, before.scroll, 'still-Pending retry preserves the current entry scroll record')
        assert.equal(after.token, 'same-entry', 'still-Pending retry retains opaque history state')
      }
      await page.unroute('**/api/fragments/acme/demo*')
      const retryEvidence = { requests: [], responses: [], errors, before: null, after: null }
      const retryReads = []
      const beforeRetry = () => page.evaluate(() => ({
        url: location.href, marker: window.__pendingDocument ?? null,
        router: document.documentElement.dataset.fragmentRouter ?? null,
        navigationReady: document.documentElement.dataset.navigationReady ?? null,
        pending: !!document.querySelector('[data-artifact-pending]'),
        error: document.querySelector('[data-navigation-error]')?.textContent ?? null,
        retryHref: document.querySelector('[data-pending-retry]')?.getAttribute('href') ?? null,
        pointer: JSON.parse(document.querySelector('#gild-pointer')?.textContent ?? 'null'),
        historyLength: history.length, scroll: scrollY, historyState: history.state,
      }))
      const retryRequest = request => { if (retryEvidence.requests.length < 80) retryEvidence.requests.push({ url: request.url(), type: request.resourceType(), navigation: request.isNavigationRequest() }) }
      const retryResponse = response => {
        if (retryEvidence.responses.length < 80) retryEvidence.responses.push({ url: response.url(), status: response.status(), state: response.headers()['x-gild-state'] ?? null, calls: response.headers()['x-fixture-calls'] ?? null })
        if (response.status() === 200 && response.url().includes('/api/fragments/') && new URL(response.url()).searchParams.get('page') === 'commit')
          retryReads.push(response.json().then(pointer => { retryEvidence.preparedPointer = pointer }).catch(error => { retryEvidence.pointerReadError = error.message }))
      }
      page.on('request', retryRequest)
      page.on('response', retryResponse)
      await page.evaluate(() => window.scrollTo(0, 120))
      retryEvidence.before = await beforeRetry()
      try {
        await page.evaluate(() => document.querySelector('[data-pending-retry]').click())
        assert.equal(await page.evaluate(() => window.__pendingDocument), marker, 'manual Pending retry retains the current document immediately after click')
        await page.waitForFunction(() => document.documentElement.dataset.navigationReady === location.pathname + location.search + location.hash)
      } finally {
        retryEvidence.after = await beforeRetry().catch(error => ({ unavailable: error.message }))
        page.off('request', retryRequest)
        page.off('response', retryResponse)
        await Promise.all(retryReads)
        writeFileSync('.tmp/fragments-review/manual-pending-retry.json', JSON.stringify(retryEvidence, null, 2))
        console.log('MANUAL PENDING RETRY', JSON.stringify(retryEvidence))
      }
      assert.equal(await page.locator('[data-artifact-pending]').count(), 0, 'manual retry reads the real prepared commit')
      assert.equal(await page.evaluate(() => window.__pendingDocument), marker, 'Pending retry does not reload the page')
      assert.ok(retryEvidence.requests.some(request => request.url.includes('/api/fragments/') && new URL(request.url).searchParams.get('page') === 'commit'), 'manual retry actually requests the selected commit pointer')
      assert.ok(retryEvidence.responses.some(response => response.url.includes('/api/fragments/') && response.status === 200), 'manual retry consumes the prepared pointer')
      assert.equal(retryEvidence.requests.some(request => request.navigation), false, 'manual retry makes no document request')
      assert.equal(retryEvidence.preparedPointer?.selected.hash, '1'.repeat(40), 'prepared selected commit remains exact')
      assert.equal(retryEvidence.after.historyLength, pendingEntry.length, 'successful Pending retry preserves history length')
      assert.equal(retryEvidence.after.scroll, retryEvidence.before.scroll, 'successful Pending retry preserves scroll')
      assert.equal(retryEvidence.after.historyState.retryFixtureToken, 'same-entry', 'successful retry retains opaque history state')
      await page.goBack()
      await page.waitForFunction(url => location.href === url && document.documentElement.dataset.navigationReady === location.pathname + location.search + location.hash, priorEntry.url)
      assert.equal(await page.evaluate(() => scrollY), priorEntry.scroll, 'one Back restores the preceding repository entry and scroll')
      assert.equal(await page.evaluate(() => window.__pendingDocument), marker, 'Back after retries retains the document')
      console.log('PASS source/commit Pending: available chrome, no error or document reload, real artifact on manual retry')
      // The real index resolves this unique abbreviated SHA. Retry canonicalizes
      // its URL by replacing the current entry, retaining query/hash and scroll.
      await page.route('**/api/fragments/acme/demo*', async route => {
        if (new URL(route.request().url()).searchParams.get('page') !== 'commit') return route.continue()
        return route.fulfill({ status: 202, contentType: 'application/json', headers: { 'x-gild-state': 'pending' }, body: JSON.stringify({ state: 'pending', retryAfter: 3 }) })
      })
      await page.evaluate(() => {
        const link = document.createElement('a')
        link.href = '/acme/demo/commit/11111111?ref=main#L1'
        document.body.append(link); link.click(); link.remove()
      })
      await page.locator('[data-artifact-pending]').waitFor()
      const canonicalBefore = await page.evaluate(() => {
        window.scrollTo(0, 120)
        History.prototype.replaceState.call(history, { ...history.state, retryFixtureToken: 'canonical-entry' }, '')
        return { length: history.length, scroll: scrollY, committed: window.__committedTransitions }
      })
      await page.unroute('**/api/fragments/acme/demo*')
      await page.evaluate(() => document.querySelector('[data-pending-retry]').click())
      await page.waitForFunction(previous => window.__committedTransitions > previous, canonicalBefore.committed)
      const canonicalAfter = await page.evaluate(() => ({ path: location.pathname, search: location.search, hash: location.hash,
        length: history.length, scroll: scrollY, state: history.state, ready: document.documentElement.dataset.navigationReady }))
      assert.equal(canonicalAfter.path, commitPath, 'Pending retry replaces the abbreviated URL with the canonical commit')
      assert.equal(canonicalAfter.search, '?ref=main')
      assert.equal(canonicalAfter.hash, '#L1')
      assert.equal(canonicalAfter.length, canonicalBefore.length, 'canonical retry replaces the same history entry')
      assert.equal(canonicalAfter.scroll, canonicalBefore.scroll, 'canonical retry preserves scroll')
      assert.equal(canonicalAfter.state.retryFixtureToken, 'canonical-entry')
      assert.equal(canonicalAfter.ready, commitPath + '?ref=main#L1')
      await page.goBack()
      await page.waitForFunction(url => location.href === url && document.documentElement.dataset.navigationReady === location.pathname + location.search + location.hash, priorEntry.url)
      writeFileSync('.tmp/fragments-review/pending-retry-history.json', JSON.stringify({ priorEntry, pendingEntry, canonicalBefore, canonicalAfter }, null, 2))
      console.log('PASS Pending retry history: repeated pending and prepared preserve entry/scroll; canonical replace/query/hash; one Back')
      await page.setViewportSize({ width: 1400, height: 1100 })
      if (pendingRetryOnly) return
      await page.goto(origin + '/acme/demo')
      await page.waitForFunction(() => document.documentElement.dataset.sourceReady === '4'.repeat(40))
    }
    const initialFavicons = transferred('favicon.svg')
    // Repo-tab HTML warming is independent of source bundle file/folder reads.
    // Keep every source/document/fragment request in the zero-network assertion.
    const tabPrefetch = r => /^\/acme\/demo\/(code|issues|pulls|actions|agents|score)$/.test(new URL(r.url()).pathname) && r.headers()['x-gild-prefetch'] === 'repo-tab'
    const tabRequests = [], folderRequests = []
    page.on('request', r => { if (tabPrefetch(r)) tabRequests.push(r.url()) })
    page.on('request', (r) => { if (!r.url().endsWith('/favicon.svg') && !tabPrefetch(r)) folderRequests.push(r.url()) })
    await page.locator('[data-tree-root] [data-kind=tree] > a').click()
    await page.locator('[data-tree-root] a[href*="file19"]').waitFor()
    assert.deepEqual(
      folderRequests,
      [],
      'bundle manifest opens folders locally',
    )
    const network = []
    page.on('request', (r) => { if (!r.url().endsWith('/favicon.svg') && !tabPrefetch(r)) network.push(r.url()) })
    // Intent hover on a local file, then twenty distinct file opens. OPFS reads
    // and DOM swaps are timed in the page, outside Playwright's round trip.
    await page.locator('[data-tree-root] a[href*="file0.ts"]').hover()
    await page.waitForTimeout(100)
    network.length = 0
    for (let i = 0; i < 20; i++) {
      await page.evaluate((i) => {
        window.__clickAt = performance.now()
        document
          .querySelector(`[data-tree-root] a[href*="file${i}.ts"]`)
          .click()
      }, i)
      await page.waitForFunction(
        (i) =>
          document.querySelector('[data-file-name]')?.textContent ===
          `src/file${i}.ts`,
        i,
      )
      assert.match(
        await page.locator('[data-file-pane]').innerText(),
        new RegExp('value' + i),
      )
    }
    assert.deepEqual(
      network,
      [],
      '20 bundle-backed file opens must do zero network requests',
    )
    assert.equal(tabRequests.length, new Set(tabRequests).size, 'failed tab publications are prefetched once per generation, not on every file open')
    if (sourceNavigationOnly) {
      assert.deepEqual(errors, [])
      console.log('PASS isolated source navigation: local folder and20 local files, bounded failed tab prefetch')
      return
    }
    assert.match(
      await page.locator('[data-file-pane]').innerText(),
      /__GILD_REF__ __GILD_PATH__ __GILD_DIR__ __GILD_REF_LABEL__/,
      'template substitution never changes source text',
    )
    assert.equal(transferred('favicon.svg'), initialFavicons, 'history-triggered favicon lookups transfer no additional bytes')
    evidence.opens = await page.evaluate(() => window.__navTimes)
    assert.ok(evidence.opens.length >= 20)
    await page.evaluate(() => (window.__clickAt = 0))
    await page.locator('a[data-tab=code]').click()
    await page.locator('.gild-readme').waitFor()
    assert.match(await page.locator('.gild-readme').innerText(), /Fixture/)
    assert.deepEqual(
      network,
      [],
      'return to Code displays locally held rendered README',
    )
    await page.locator('[data-tree-root] a[href*="file19.ts"]').click()
    await page.waitForFunction(
      () =>
        document.querySelector('[data-file-name]')?.textContent ===
        'src/file19.ts',
    )
    await page.getByRole('button', { name: 'Search code', exact: true }).click()
    await page.getByRole('combobox', { name: 'Search query', exact: true }).fill('value14')
    await page.locator('.search-option').first().waitFor()
    assert.match(
      await page.locator('.search-option').first().innerText(),
      /src\/file14.ts/,
    )
    network.length = 0
    await page.keyboard.press('Escape')
    assert.equal(
      await page.locator('.gild-ln[href="#L1"]').count(),
      1,
      'highlighted lines retain shareable anchors',
    )
    await page.goBack()
    await page.locator('.gild-readme').waitFor()
    await page.locator('[data-tree-root] a[href*="image.bin"]').click()
    await page.locator('[data-raw]').waitFor()
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-raw]').click(),
    ])
    assert.equal(download.suggestedFilename(), 'image.bin')
    await download.saveAs('.tmp/fragments-review/binary.bin')
    assert.deepEqual(
      [...readFileSync('.tmp/fragments-review/binary.bin')],
      [0, 1, 2, 255],
      'raw download preserves exact binary bytes',
    )

    network.length = 0
    await get('/__seed?version=2')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.waitForFunction(
      () => document.documentElement.dataset.sourceReady === '5'.repeat(40),
    )
    evidence.delta = network.filter((url) =>
      /\/f\/v\d+\/(?:blob|source)\//.test(url),
    )
    assert.equal(
      evidence.delta.length,
      2,
      'one changed blob: one HTML + one source request: ' +
        JSON.stringify(evidence.delta),
    )
    assert.ok(
      evidence.delta.every(
        (url) => new URL(url).searchParams.get('path') === 'src/file0.ts',
      ),
    )
    assert.ok(
      network.every((url) => !/\/f\/v\d+\/bundle\//.test(url)),
      'new tip must not download the whole bundle',
    )
    assert.match(
      await page.locator('[data-fragment-root]').innerText(),
      /Fixture commit 2/,
    )
    await page.locator('[data-tree-root] [data-kind=tree] > a').click()
    await page.locator('[data-tree-root] a[href*="file0.ts"]').click()
    await page.waitForFunction(
      () =>
        document.querySelector('[data-file-name]')?.textContent ===
        'src/file0.ts',
    )
    for (const width of [1400, 400])
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 1100 })
        await page.evaluate((t) => {
          localStorage.setItem('gild.theme', t)
          document.documentElement.dataset.theme = t
        }, theme)
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
          'page fits viewport',
        )
        const screenshot = `.tmp/fragments-review/code-${width}-${theme}.png`
        await page.screenshot({ path: screenshot, fullPage: true })
        evidence.screenshots.push(screenshot)
      }
    // Score intent prefetch is actual compiled HTML, reused after click.
    await page.setViewportSize({ width: 1400, height: 1100 })
    await page.locator('a[data-tab=score]').hover()
    await page.waitForFunction(() =>
      window.__prefetched.includes(
        document.querySelector('a[data-tab=score]').href,
      ),
    )
    network.length = 0
    await page.evaluate(() => {
      window.__clickAt = performance.now()
      document.querySelector('a[data-tab=score]').click()
    })
    await page.locator('#score').waitFor()
    evidence.prefetchedScoreMs = await page.evaluate(() =>
      window.__navTimes.at(-1),
    )
    assert.ok(Number.isFinite(evidence.prefetchedScoreMs), 'prefetched Score swap records timing evidence')
    await page.evaluate(() => (window.__clickAt = 0))
    assert.equal(
      network.filter((url) => /\/(?:api\/fragments|f)\//.test(url)).length,
      0,
      'prefetched Score navigation makes no new data request: ' +
        JSON.stringify(network),
    )
    assert.equal(
      await page.locator('#score svg').count(),
      5,
      'one shared Score review',
    )
    const defaultCategory = await page
      .locator('#score')
      .getAttribute('data-score-default')
    assert.ok(
      defaultCategory,
      'Score publishes its compiled default category',
    )
    await page.locator('#score a[href*="cat=security"]').click()
    assert.match(
      await page.locator('[data-category=security]').innerText(),
      /Security/,
    )
    await page.goBack()
    await page.waitForFunction(
      (category) =>
        document.querySelector(`#score [data-category=${category}]`)?.hidden ===
        false,
      defaultCategory,
    )
    assert.equal(
      await page
        .locator(`#score [data-score-category=${defaultCategory}]`)
        .getAttribute('aria-current'),
      'true',
      'Back restores default Score category',
    )
    const payload = Buffer.from(
        JSON.stringify({
          name: 'reader',
          publicKey: 'ed25519:reader',
          at: new Date().toISOString(),
        }),
      ).toString('base64url'),
      cookie =
        payload +
        '.' +
        createHmac('sha256', 'fragment-fixture-cookie-secret-32-characters')
          .update(payload)
          .digest('base64url')
    const privateContext = await browser.newContext({
      viewport: { width: 1400, height: 1100 },
    })
    await privateContext.addCookies([
      { name: 'gild_session', value: cookie, url: origin },
    ])
    await get('/__seed?version=1&private')
    const privatePage = await privateContext.newPage()
    await privatePage.addInitScript(() =>
      document.addEventListener('gild:navigation-error', (e) =>
        console.log('NAV ERROR', e.detail),
      ),
    )
    privatePage.on('console', (msg) => {
      if (msg.text().startsWith('NAV ERROR')) console.log(msg.text())
    })
    privatePage.on('pageerror', (error) =>
      console.log('PRIVATE PAGE ERROR', error.message),
    )
    await privatePage.goto(origin + '/acme/demo')
    await privatePage.waitForFunction(
      () => document.documentElement.dataset.sourceReady,
    )
    await privatePage
      .locator('.site-identity')
      .waitFor({ state: 'attached' })
    await privatePage.locator('.site-identity').waitFor()
    for (const width of [1400, 1100, 400]) {
      await privatePage.setViewportSize({ width, height: 1100 })
      await privatePage.waitForTimeout(50)
      const hits = await privatePage.evaluate(() => {
        const bar = document
            .querySelector('.site-identity')
            .getBoundingClientRect(),
          zone = {
            left: bar.left - 12,
            right: innerWidth,
            bottom: bar.bottom + 12,
          }
        const walk = document.createTreeWalker(
            document.querySelector('main'),
            NodeFilter.SHOW_TEXT,
          ),
          out = []
        for (let node = walk.nextNode(); node; node = walk.nextNode()) {
          if (
            !node.textContent.trim() ||
            node.parentElement.closest('.site-identity')
          )
            continue
          const range = document.createRange()
          range.selectNodeContents(node)
          for (const r of range.getClientRects())
            if (
              r.width &&
              r.right > zone.left &&
              r.left < zone.right &&
              r.top < zone.bottom &&
              r.bottom > 0
            )
              out.push(node.textContent)
        }
        return out
      })
      assert.deepEqual(hits, [], 'signed-in corner remains empty at ' + width)
    }
    await privatePage.setViewportSize({ width: 1400, height: 1100 })
    await privatePage.locator('a[data-tab=score]').click()
    await privatePage.waitForFunction(() =>
      document.documentElement.dataset.navigationReady?.includes('/score'),
    )
    await privatePage.locator('#score').waitFor()
    assert.equal(
      await privatePage.locator('.site-identity').count(),
      1,
      'fragment swaps preserve identity/search shell: ' +
        (await privatePage.evaluate(() =>
          JSON.stringify({
            url: location.href,
            root: document.querySelector('[data-fragment-root]')?.tagName,
            parent: document
              .querySelector('[data-fragment-root]')
              ?.parentElement?.outerHTML.slice(0, 400),
            rail: !!document.querySelector('[data-identity]'),
            ready: document.documentElement.dataset.navigationReady,
          }),
        )),
    )
    await privatePage.evaluate(async () => {
      const url = document.querySelector('script[src*="/gild-fragments/"][src$="/router.js"]').src
      const module = await import(url)
      await module.clearPrivateSources()
    })
    const records = await privatePage.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open('gild-source-v1')
          request.onsuccess = () => {
            const tx = request.result.transaction('entries'),
              query = tx.objectStore('entries').getAll()
            query.onsuccess = () => resolve(query.result)
            query.onerror = () => reject(query.error)
          }
        }),
    )
    assert.ok(
      records.every((row) => !row.private),
      'sign-out erases private disk records',
    )
    const privateFiles = await privatePage.evaluate(async () => {
      const root = await navigator.storage.getDirectory(),
        dir = await root.getDirectoryHandle('gild-source-v1')
      const names = []
      for await (const name of dir.keys())
        if (decodeURIComponent(name).includes('/private/')) names.push(name)
      return names
    })
    assert.deepEqual(
      privateFiles,
      [],
      'sign-out erases private OPFS bodies as well as metadata',
    )
    await privateContext.close()
    await get('/__seed?version=2')
    await page.close()
    // saveData forbids both intent prefetch and automatic source bundles.
    const saved = await browser.newPage()
    await saved.addInitScript(() =>
      Object.defineProperty(navigator, 'connection', {
        value: { saveData: true, effectiveType: '4g' },
      }),
    )
    const requests = []
    saved.on('request', (r) => requests.push(r.url()))
    await saved.goto(origin + '/acme/demo')
    await saved.waitForFunction(
      () => document.documentElement.dataset.fragmentRouter === 'ready',
    )
    requests.length = 0
    await saved.locator('a[data-tab=score]').hover()
    await saved.waitForTimeout(150)
    assert.deepEqual(requests, [], 'saveData disables link and bundle prefetch')
    // No-JS first loads are already complete HTML; file links remain shareable.
    const nojs = await browser.newPage({ javaScriptEnabled: false })
    await nojs.goto(origin + '/acme/demo?path=src%2Ffile0.ts')
    assert.match(
      await nojs.locator('[data-file-pane]').innerText(),
      /value0.*2/,
    )
    await nojs.goto(origin + '/acme/demo?path=src')
    await nojs.locator('[data-file-pane] a[href*="file1.ts"]').click()
    assert.match(await nojs.locator('[data-file-pane]').innerText(), /value1/)
    await nojs.goto(
      origin + '/acme/demo/commit/' + '2'.repeat(40) + '?file=src%2Ffile0.ts',
    )
    assert.equal(await nojs.locator('[data-diff-path]:visible').count(), 1)
    assert.equal(
      await nojs.locator('[data-change-overview]:visible').count(),
      0,
    )
    await nojs.goto(origin + '/acme/demo/score?cat=security')
    assert.equal(await nojs.locator('[data-category]:visible').count(), 1)
    assert.equal(
      await nojs.locator('[data-score-category=security]').getAttribute('aria-current'),
      'true',
      'edge selects the same Score dial without JavaScript',
    )
    assert.match(
      await nojs.locator('[data-category]:visible').innerText(),
      /Security/,
    )
    assert.deepEqual(errors, [])
    writeFileSync(
      '.tmp/fragments-review/browser.json',
      JSON.stringify(evidence, null, 2),
    )
    console.log(
      'PASS browser: hover + local swaps; 20 files / 0 requests; changed-blob delta; history; saveData; no-JS; 4 responsive/theme screenshots',
      evidence,
    )
  } finally {
    await browser.close()
  }
}
