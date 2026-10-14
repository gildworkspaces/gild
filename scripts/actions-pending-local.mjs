import assert from 'node:assert/strict'
import { forgeFixture } from './forge-fixture.mjs'
import { launchChrome } from './chrome.mjs'

// Pause only the real RunQueue's producer alarm. Requests still execute the
// compiled Actions page and actual cache read/background preparation admission.
const f = await forgeFixture({ renderBuild: false, workflowPending: true })
const owner = 'avatest', repo = 'pending-actions', base = `/${owner}/${repo}`
f.seedRepo('u-' + owner, repo, [
  { path: 'README.md', text: '# Pending Actions fixture\n' },
  { path: '.github/workflows/ci.yml', text: 'name: Fixture\non: workflow_dispatch\njobs:\n  test:\n    runs-on: self-hosted\n    steps:\n      - run: echo fixture\n' },
])
let browser
const pause = async paused => {
  const response = await fetch(f.origin + '/__fixture/workflow-pending', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ owner, repo, paused }),
  })
  assert.equal(response.status, 200)
}
try {
  const startup = Date.now() + 90000
  for (;;) {
    try { await pause(true); break } catch {}
    assert.ok(Date.now() < startup, 'fixture startup deadline')
    await new Promise(r => setTimeout(r, 250))
  }
  for (;;) {
    const response = await fetch(f.origin + base, { headers: { accept: 'text/html' } })
    const html = await response.text()
    if (response.status === 200 && html.includes('aria-label="Repository"')) break
    assert.ok(Date.now() < startup, 'repository preparation deadline')
    await new Promise(r => setTimeout(r, 250))
  }
  browser = await launchChrome()
  const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1400, height: 1000 } })
  await ctx.addCookies([{ name: 'gild_session', value: f.cookie(owner), url: f.origin }])
  const page = await ctx.newPage()
  const response = await page.goto(f.origin + base + '/actions')
  assert.equal(response.status(), 200)
  // Assertions inspect SSR DOM while both browser JavaScript and preparation
  // are disabled: no client fallback or producer completion can satisfy them.
  assert.equal(await page.locator('[data-artifact-pending]').count(), 1, 'workflow cache miss returns Pending inside the repository')
  assert.equal(await page.locator('nav[aria-label="Repository"]').count(), 1, 'Pending preserves repository navigation')
  assert.equal(await page.locator('[data-repo-island="sidebar"]').count(), 1, 'Pending preserves server-selected account sidebar')
  assert.equal(await page.locator('[data-repo-island="actions"]').count(), 0, 'Pending does not imply prepared workflows')
  await pause(false)
  const deadline = Date.now() + 60000
  for (;;) {
    await page.reload()
    if (await page.locator('[data-repo-island="actions"]').count()) break
    assert.ok(Date.now() < deadline, 'background producer must prepare the Actions view')
    await new Promise(r => setTimeout(r, 250))
  }
  assert.equal(await page.locator('[data-artifact-pending]').count(), 0)
  assert.equal(await page.locator('nav[aria-label="Repository"]').count(), 1)
  console.log('PASS compiled Actions Pending SSR navigation/sidebar with paused producer; prepared view after alarm release')
} finally {
  await browser?.close()
  f.worker.kill('SIGTERM')
  await new Promise(r => f.worker.exitCode !== null ? r() : f.worker.once('exit', r))
  await new Promise(r => f.server.close(r))
}
