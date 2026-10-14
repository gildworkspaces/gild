import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { forgeFixture } from './forge-fixture.mjs'
import { launchChrome } from './chrome.mjs'
import { verifyAccountMenu } from './signed-in-shell.mjs'
import { documentationRoutes } from '../lib/documentation-routes.ts'

const f = await forgeFixture({ renderBuild: false, staticReview: true, documentation: true })
let browser
const evidence = []
try {
  // Prepare the already-existing generic status shell before simulating a
  // missing docs artifact. This setup is outside the measured docs GET path.
  const deadline = Date.now() + 90000
  for (;;) {
    try {
      const response = await fetch(f.origin + '/settingstest/demo', { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(10000) })
      const html = await response.text()
      if (response.status === 200 && !html.includes('data-artifact-pending')) break
    } catch {}
    assert.ok(Date.now() < deadline, 'fixture repository/status-shell preparation')
    await new Promise(r => setTimeout(r, 200))
  }
  browser = await launchChrome()
  const owner = await browser.newContext({ javaScriptEnabled: false })
  await owner.addCookies([{ name: 'gild_session', value: f.cookie('avatest'), url: f.origin }])
  const pendingPage = await owner.newPage()
  const fault = await fetch(f.origin + '/__fixture/documentation-missing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ missing: true }) })
  assert.equal(fault.status, 200)
  for (const d of documentationRoutes) {
    const response = await pendingPage.goto(f.origin + d.path)
    assert.equal(response.status(), 200)
    assert.equal(response.headers()['x-gild-state'], 'pending', 'missing build artifact stays Pending')
    assert.equal(await pendingPage.locator('[data-artifact-pending]').count(), 1)
    assert.equal(await pendingPage.locator('nav[aria-label="Portal"]').count(), 1, 'Pending retains server account sidebar')
    const calls = JSON.parse(response.headers()['x-fixture-calls'])
    assert.equal(calls.next, 0, 'missing docs never fall back to Next')
    assert.equal(calls.render, 0, 'missing docs never compute renderer HTML')
  }
  await owner.close()
  await fetch(f.origin + '/__fixture/documentation-missing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ missing: false }) })
  for (const d of documentationRoutes) {
    const response = await fetch(f.origin + d.path, { headers: { rsc: '1', cookie: 'gild_session=' + f.cookie('avatest') } })
    assert.equal(response.status, 200)
    assert.ok(response.headers.get('content-type').startsWith('text/html'), 'legacy Flight caller receives the supported full-document fallback')
    assert.ok((await response.text()).includes(`data-prepared-document="${d.path}"`))
    assert.equal(JSON.parse(response.headers.get('x-fixture-calls')).next, 0, 'RSC header cannot trigger Next documentation compute')
  }
  const unclaimedName = 'key ' + createHash('sha256').update('ed25519:unclaimed-document-key').digest('hex').slice(0, 8)
  // Server-only DOM checks include repeated different viewers of the same
  // neutral cache key. Cookies, profiles and fingerprints never enter that cache.
  for (const viewer of ['avatest', 'anonymous', 'outsider', 'unclaimed', 'invalid']) {
    const ctx = await browser.newContext({ javaScriptEnabled: false })
    const cookie = viewer === 'unclaimed' ? f.cookie('unclaimed-document-key', '') : viewer === 'invalid' ? f.cookie('avatest') + 'bad' : f.cookie(viewer)
    if (viewer !== 'anonymous') await ctx.addCookies([{ name: 'gild_session', value: cookie, url: f.origin }])
    const page = await ctx.newPage()
    await page.setExtraHTTPHeaders({ 'x-gild-page-reads': encodeURIComponent(JSON.stringify({ viewer: { name: 'forged-identity' } })), 'x-gild-publishing': '1' })
    for (const d of documentationRoutes) {
      const response = await page.goto(f.origin + d.path + '?entry=demo')
      assert.equal(response.status(), 200)
      assert.equal(await page.locator(`[data-prepared-document="${d.path}"]`).count(), 1, 'actual build-owned docs HTML is served')
      const calls = JSON.parse(response.headers()['x-fixture-calls'])
      assert.equal(calls.next, 0, 'prepared docs never enter Next')
      assert.equal(calls.render, 0, 'prepared docs never compute renderer HTML')
      const html = await response.text(), authenticated = !['anonymous', 'invalid'].includes(viewer)
      assert.equal(await page.locator('nav[aria-label="Portal"]').count(), authenticated ? 1 : 0, 'SSR account identity matches verified cookie')
      assert.doesNotMatch(html, /data-tip="@forged-identity"/)
      if (authenticated) {
        const name = viewer === 'unclaimed' ? unclaimedName : viewer
        assert.ok(html.includes(`data-tip="@${name}"`), 'server selects current identity')
        assert.doesNotMatch(html, /class="site-signin"/, 'no initial Sign In fallback')
        if (viewer === 'unclaimed') assert.equal(JSON.parse(await page.locator('#gild-islands').textContent()).name, null, 'unclaimed key is not a claimed browser viewer')
      } else {
        assert.equal(await page.locator('a.site-signin').count(), 1)
        assert.ok((await page.locator('a.site-signin').getAttribute('href')).includes(encodeURIComponent(d.path + '?entry=demo')))
        assert.doesNotMatch(html, /data-tip="@avatest"|data-tip="@outsider"/)
      }
      assert.equal(await page.locator('script[src*="/_next/static/"]').count(), 0, 'docs have no Next hydration runtime')
      assert.ok((response.headers()['cache-control'] ?? '').includes('no-store'), 'personalized document is never a shared browser response')
      assert.equal(await page.locator('h1').innerText(), d.id === 'api' ? 'gild API' : 'Session receipts')
      evidence.push({ viewer, route: d.path, next: calls.next, render: calls.render, serverTiming: response.headers()['server-timing'] })
    }
    await ctx.close()
  }
  for (const width of [1400, 400]) {
    const ctx = await browser.newContext({ viewport: { width, height: 1000 } })
    await ctx.addCookies([{ name: 'gild_session', value: f.cookie('avatest'), url: f.origin }])
    const page = await ctx.newPage()
    for (const d of documentationRoutes) {
      await page.goto(f.origin + d.path)
      await verifyAccountMenu(page, width, d.path)
      assert.deepEqual(await page.evaluate(() => performance.getEntriesByType('resource').filter(e => new URL(e.name).pathname.startsWith('/api/')).map(e => new URL(e.name).pathname)), [], 'no post-load viewer API waterfall')
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'docs fit viewport')
    }
    await ctx.close()
  }
  mkdirSync('.tmp', { recursive: true })
  writeFileSync('.tmp/documentation-evidence.json', JSON.stringify(evidence, null, 2) + '\n')
  console.log('PASS compiled build-owned docs, SSR anonymous/claimed/unclaimed identity, neutral-cache isolation, forged-header denial, missing-artifact Pending and working desktop/mobile menus without Next')
} finally {
  await browser?.close()
  f.worker.kill('SIGTERM')
  await new Promise(r => f.worker.exitCode !== null ? r() : f.worker.once('exit', r))
  await new Promise(r => f.server.close(r))
}
