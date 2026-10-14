import { forgeFixture } from './forge-fixture.mjs'
import { verifyRepoRefresh } from './repo-refresh-browser.mjs'
import { launchChrome } from './chrome.mjs'
import assert from 'node:assert/strict'

const f = await forgeFixture()
let browser
try {
  // Only warm the initial fixture. The mutation/navigation proof has no retry.
  const deadline = Date.now() + 60000
  for (;;) {
    try {
      if ((await fetch(f.origin + '/api/v1/repos/settingstest/demo', {
        headers: { authorization: 'Bearer ' + f.tokens.avatest },
      })).ok) break
    } catch {}
    assert.ok(Date.now() < deadline, 'initial fixture readiness')
    await new Promise(r => setTimeout(r, 100))
  }
  const call = async (path, body, method = 'POST', token = f.tokens.avatest, status = 200) => {
    const r = await fetch(f.origin + path, {
      method,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    assert.equal(r.status, status, path + ': ' + await r.text())
  }
  browser = await launchChrome()
  const context = await browser.newContext()
  await context.addCookies([{ name: 'gild_session', value: f.cookie('avatest'), domain: new URL(f.origin).hostname, path: '/' }])
  const page = await context.newPage()
  await verifyRepoRefresh({ ...f, page, call, label: 'standalone' })
} finally {
  await browser?.close()
  f.worker.kill('SIGTERM')
  await new Promise(r => f.worker.exitCode !== null || f.worker.signalCode !== null ? r() : f.worker.once('exit', r))
  f.server.closeAllConnections()
  await new Promise(r => f.server.close(r))
  console.log('Fixture: ' + f.work)
}
