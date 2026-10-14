import assert from 'node:assert/strict'

/** The response must contain the real account before any client code runs. */
export async function verifyServerIdentity({ browser, fixture, base }) {
  const context = await browser.newContext({ javaScriptEnabled: false })
  await context.addCookies([{ name: 'gild_session', value: fixture.cookie('avatest'), url: fixture.origin }])
  const page = await context.newPage()
  try {
    for (const path of ['/', '/docs/api', '/avatest', base, ...['issues', 'pulls', 'actions', 'agents', 'score'].map(tab => `${base}/${tab}`)]) {
      const response = await page.goto(fixture.origin + path)
      assert.equal(response.status(), 200, `${path}: initial account document succeeds`)
      const html = await response.text()
      assert.match(html, /data-tip="@avatest"/, `${path}: initial response contains the authenticated account`)
      assert.doesNotMatch(html, /class="site-signin"/, `${path}: initial response never sends a Sign In fallback`)
      assert.doesNotMatch(html, />Sign in to star</, `${path}: authenticated star controls never send a Sign In fallback`)
      assert.equal(await page.locator('nav[aria-label="Portal"]').count(), 1, `${path}: server sends one account sidebar without JavaScript`)
    }
    console.log('PASS initial server identity and account sidebar: homepage, docs, profile and all six repository tabs without JavaScript')
  } finally {
    await context.close()
  }
  for (const width of [1400, 400]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } })
    await context.addCookies([{ name: 'gild_session', value: fixture.cookie('avatest'), url: fixture.origin }])
    const page = await context.newPage()
    try {
      for (const path of ['/', '/docs/api', '/avatest']) {
        await page.goto(fixture.origin + path)
        await verifyAccountMenu(page, width, path)
      }
      console.log(`PASS signed-in homepage/docs/profile account menus at ${width}px`)
    } finally {
      await context.close()
    }
  }
}

export async function verifyAccountMenu(page, width, label) {
  const portal = page.getByRole('navigation', { name: 'Portal', exact: true })
  await portal.waitFor()
  assert.equal(await portal.count(), 1, `${label}: exactly one account sidebar`)
  assert.equal(await page.locator('.site-header').count(), 0, `${label}: signed-in shell stays consistent`)
  const toggle = page.getByRole('button', { name: 'Expand', exact: true })
  if (await toggle.count()) {
    if (width === 400) await page.getByRole('button', { name: 'Menu', exact: true }).click()
    else await toggle.click()
  }
  const collapse = page.getByRole('button', { name: 'Collapse', exact: true })
  await collapse.waitFor()
  assert.equal(await collapse.getAttribute('aria-expanded'), 'true', `${label}: menu opens`)
  assert.equal(await portal.locator('a[href="/dashboard"]').isVisible(), true, `${label}: Dashboard remains reachable`)
  assert.equal(await page.locator('.sidebar-identity').getAttribute('data-tip'), '@avatest', `${label}: account identity remains correct`)
  // The SSR bootstrap already opens the rail. Require the real client handoff
  // before closing so a missing account mount cannot pass on bootstrap alone.
  await page.locator('.sidebar[data-sidebar-client-ready]').waitFor({ timeout: 5000 })
  await collapse.click()
  await toggle.waitFor()
  await page.waitForFunction(() => {
    const rail = document.querySelector('.sidebar').getBoundingClientRect()
    return innerWidth < 760 ? rail.right <= 1 : Math.round(rail.width) === 68
  })
}

/** Direct entries must offer the same working account navigation as tab hops. */
export async function verifySignedInShell({ browser, fixture, base, visibility }) {
  if (visibility === 'private') {
    await fixturePendingMenus({ browser, fixture, base })
  }
  for (const width of [1400, 400]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } })
    await context.addCookies([{ name: 'gild_session', value: fixture.cookie('avatest'), url: fixture.origin }])
    const page = await context.newPage()
    try {
      for (const tab of ['code', 'issues', 'pulls', 'actions', 'agents', 'score']) {
        const path = base + (tab === 'code' ? '' : '/' + tab)
        await page.goto(fixture.origin + path)
        assert.equal(await page.getByRole('navigation', { name: 'Portal', exact: true }).count(), 1, `${visibility} ${tab}: exactly one account sidebar`)
        await page.waitForFunction(() => document.documentElement.dataset.fragmentRouter === 'ready')
        await verifyAccountMenu(page, width, `${visibility} ${tab}`)
        if (tab === 'issues' || tab === 'pulls') {
          const create = page.getByRole('link', { name: tab === 'issues' ? 'New issue' : 'New pull request', exact: true })
          assert.equal(await create.count(), 1, `${visibility} ${tab}: mounted creation controls retain the viewer`)
          assert.equal(await create.getAttribute('href'), `${base}/${tab}/new`, `${visibility} ${tab}: mounted creation controls retain the viewer`)
        }
        if (['code', 'agents'].includes(tab)) await page.screenshot({ path: `.tmp/nav-review/shell-${visibility}-${tab}-${width}.png` })
      }
      console.log(`PASS consistent ${visibility} signed-in sidebar: six direct routes at ${width}px, working menu`)
    } finally {
      await context.close()
    }
  }
}

export async function fixturePendingMenus({ browser, fixture, base, widths = [1400, 400], verifyMenu = verifyAccountMenu }) {
  const pause = paused => fetch(fixture.origin + '/__fixture/import-index-pause?repository=' + base.slice(1) + '&paused=' + (paused ? '1' : '0'))
  // Visibility changes produce new immutable shells. Prepare those first;
  // this scenario deliberately blocks metadata, not unrelated initial builds.
  const preparedBy = Date.now() + 60000
  for (const path of [base, base + '/score']) {
    for (;;) {
      const response = await fetch(fixture.origin + path, { headers: { accept: 'text/html', cookie: 'gild_session=' + fixture.cookie('avatest') } })
      const html = await response.text()
      assert.ok([200,202].includes(response.status), 'authorized preparation response for ' + path)
      if (response.status === 200 && response.headers.get('x-gild-state') !== 'pending' && !html.includes('data-artifact-pending')) break
      assert.ok(Date.now() < preparedBy, 'prepare current visibility artifacts before blocking metadata')
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
  for (;;) {
    const state = await (await fetch(fixture.origin + '/__fixture/render-settled')).json()
    if (state.ready) break
    assert.ok(Date.now() < preparedBy, 'finish the fixture commit builds before blocking metadata: ' + JSON.stringify(state.pending))
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.equal((await pause(true)).status, 200)
  try {
    for (const width of widths) {
      const context = await browser.newContext({ viewport: { width, height: 1000 } })
      await context.addCookies([{ name: 'gild_session', value: fixture.cookie('avatest'), url: fixture.origin }])
      const page = await context.newPage()
      try {
        const startedAt = Date.now(), start = performance.now()
        const response = await page.goto(fixture.origin + base + '/issues', { waitUntil: 'commit' })
        assert.equal(response.status(), 200)
        assert.equal(response.headers()['x-gild-state'], 'pending')
        const html = await response.text()
        const elapsed = performance.now() - start
        const navigation = await page.evaluate(() => {
          const entry = performance.getEntriesByType('navigation')[0]
          return { ttfbMs: Math.round(entry.responseStart), documentMs: Math.round(entry.responseEnd),
            fetchStartMs: Math.round(entry.fetchStart), requestStartMs: Math.round(entry.requestStart),
            connectStartMs: Math.round(entry.connectStart), connectEndMs: Math.round(entry.connectEnd) }
        })
        const enteredAt = Number(response.headers()['x-fixture-entered-at']), returnedAt = Number(response.headers()['x-fixture-returned-at'])
        console.log('Pending metadata timing', JSON.stringify({ width, elapsedMs: Math.round(elapsed), ...navigation,
          handlerEntryMs: enteredAt ? enteredAt - startedAt : null,
          handlerReturnMs: returnedAt ? returnedAt - startedAt : null,
          serverTiming: response.headers()['server-timing'] }))
        const calls = JSON.parse(response.headers()['x-fixture-calls'])
        assert.equal(calls.next, 0, 'Pending metadata must not enter the Next producer')
        assert.equal(calls.render, 0, 'Pending metadata must not ask the renderer to compute HTML')
        assert.match(html, /data-artifact-pending.*Pending/s)
        assert.doesNotMatch(html, /http-equiv="refresh"|class="site-signin"/)
        await verifyMenu(page, width, 'Pending private metadata')
        // Check the menu effect before the latency gate so an intentional menu
        // omission reaches its own assertion. elapsed still measures only the
        // original complete response, and the same 500 ms budget stays required.
        assert.ok(elapsed < 500, `Complete Pending metadata document responds within 500 ms while its producer is blocked (${Math.round(elapsed)} ms)`)
      } finally { await context.close() }
    }
    console.log('PASS blocked metadata producer: prompt Pending document, initial account identity and working desktop/mobile menus')
  } finally { await pause(false) }
  const end = Date.now() + 60000
  for (;;) {
    const response = await fetch(fixture.origin + base + '/issues', { headers: { accept: 'text/html', cookie: 'gild_session=' + fixture.cookie('avatest') } })
    const html = await response.text()
    if (response.status === 200 && !html.includes('data-artifact-pending')) break
    assert.ok(Date.now() < end, 'metadata preparation completes after producer release')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { forgeFixture } = await import('./forge-fixture.mjs')
  const { publishRepoTabs } = await import('./nav-fixture.mjs')
  const { launchChrome } = await import('./chrome.mjs')
  const fixture = await forgeFixture({ renderBuild: false, staticReview: true }), base = '/avatest/sidebar-test'
  fixture.seedRepo('u-avatest', 'sidebar-test', [{ path: 'README.md', text: '# Sidebar fixture\n' }])
  let browser
  try {
    await publishRepoTabs(fixture, base)
    browser = await launchChrome()
    if (process.argv.includes('--pending-only')) {
      const privateResponse = await fetch(fixture.origin + '/api/v1/repos' + base + '/visibility', { method: 'PATCH', headers: { authorization: 'Bearer ' + fixture.tokens.avatest, 'content-type': 'application/json' }, body: JSON.stringify({ visibility: 'private' }) })
      assert.equal(privateResponse.status, 200, await privateResponse.text())
      await fixturePendingMenus({ browser, fixture, base })
    } else {
      if (!process.argv.includes('--menu-only')) await verifyServerIdentity({ browser, fixture, base })
      if (!process.argv.includes('--identity-only')) await verifySignedInShell({ browser, fixture, base, visibility: 'public' })
    }
  } finally {
    await browser?.close()
    fixture.worker.kill('SIGTERM')
    await new Promise(resolve => fixture.worker.exitCode !== null ? resolve() : fixture.worker.once('exit', resolve))
    await new Promise(resolve => fixture.server.close(resolve))
  }
}
