import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { forgeFixture } from './forge-fixture.mjs'
import { publishRepoTabs } from './nav-fixture.mjs'
import { launchChrome } from './chrome.mjs'
import { fixturePendingMenus, verifyAccountMenu } from './signed-in-shell.mjs'
const evidence = { scenario: 'Actual first mobile click while compiled island module is deferred', events: [], assets: [], outcomes: [] }
const save = () => writeFileSync('.tmp/fragments-review/sidebar-first-click.json', JSON.stringify(evidence, null, 2) + '\n')
const fixture = await forgeFixture({ renderBuild: false, staticReview: true }), base = '/avatest/sidebar-test'
fixture.seedRepo('u-avatest', 'sidebar-test', [{ path: 'README.md', text: '# Sidebar fixture\n' }])
let browser, release
const held = new Promise(resolve => { release = resolve })
try {
  await publishRepoTabs(fixture, base)
  browser = await launchChrome()
  const response = await fetch(fixture.origin + '/api/v1/repos' + base + '/visibility', { method: 'PATCH', headers: { authorization: 'Bearer ' + fixture.tokens.avatest, 'content-type': 'application/json' }, body: JSON.stringify({ visibility: 'private' }) })
  assert.equal(response.status, 200, await response.text())
  const controlled = { async newContext(options) {
    const context = await browser.newContext(options), newPage = context.newPage.bind(context)
    context.newPage = async () => {
      const page = await newPage()
      page.on('pageerror', error => evidence.events.push(error.message))
      page.on('response', r => { if (/\.(?:js|css)$/.test(new URL(r.url()).pathname)) evidence.assets.push({ url: r.url(), status: r.status() }) })
      await page.route('**/gild-fragments/**/tab-client.js', async route => {
        evidence.heldModule = route.request().url(); await held; await route.continue()
      })
      return page
    }
    return context
  } }
  await fixturePendingMenus({ browser: controlled, fixture, base, widths: [400], verifyMenu: async (page, width, label) => {
    assert.ok(evidence.heldModule, 'the actual compiled island module is held')
    assert.equal(await page.locator('.sidebar[data-sidebar-client-ready]').count(), 0, 'first click precedes actual React handlers')
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: 'Menu', exact: true }).getAttribute('aria-expanded'), 'true', 'real early Menu click opens while island is held')
    assert.equal(await page.getByRole('button', { name: 'Collapse', exact: true }).count(), 1, 'early click exposes Collapse before module delivery')
    assert.equal(await page.getByRole('navigation', { name: 'Portal', exact: true }).locator('a[href="/dashboard"]').isVisible(), true, 'early menu has reachable Dashboard')
    evidence.outcomes.push('first actual click opens before island delivery')
    release()
    await page.locator('.sidebar[data-sidebar-client-ready]').waitFor()
    assert.equal(await page.getByRole('button', { name: 'Menu', exact: true }).getAttribute('aria-expanded'), 'true', 'React handoff retains early menu state')
    await verifyAccountMenu(page, width, label)
    evidence.outcomes.push('React handoff remains open and original menu/close assertions pass')
    assert.equal(evidence.assets.some(a => a.status >= 400), false, 'compiled module/style delivery succeeds')
    assert.deepEqual(evidence.events, [], 'no browser script exception')
    save()
  } })
  evidence.outcomes.push('original prepared recovery after producer release completes'); save()
  console.log('PASS real deferred-island early click, open state handoff, original menu/close and prepared recovery')
} catch (error) { evidence.failure = error.message; save(); throw error }
finally {
  release(); await browser?.close()
  fixture.worker.kill('SIGTERM')
  await new Promise(resolve => fixture.worker.exitCode !== null ? resolve() : fixture.worker.once('exit', resolve))
  await new Promise(resolve => fixture.server.close(resolve))
}
