import { forgeFixture } from './forge-fixture.mjs'
import { launchChrome } from './chrome.mjs'
import { generateKeyPairSync, sign } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const f = await forgeFixture({ renderBuild: false })
const key = generateKeyPairSync('ed25519')
const publicKey = 'ed25519:' + key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
let browser
const evidence = []
try {
  const until = Date.now() + 60000
  while (true) {
    try { if ((await fetch(f.origin + '/__fixture/calls?trace=flow-recovery-ready', { signal: AbortSignal.timeout(1000) })).ok) break } catch {}
    assert.ok(Date.now() < until, 'fixture startup deadline')
    await new Promise(r => setTimeout(r, 250))
  }
  browser = await launchChrome()
  for (const kind of ['claim', 'auth']) {
    const context = await browser.newContext(), old = await context.newPage(), current = await context.newPage()
    let oldPolls = 0
    old.on('request', request => { if (request.url().includes(`/api/${kind}/status?`)) oldPolls++ })
    const start = async (page, name) => {
      if (kind === 'auth') {
        const response = page.waitForResponse(r => r.url().endsWith('/api/auth/challenge') && r.request().method() === 'POST')
        await page.goto(f.origin + '/auth/device')
        return (await (await response).json()).challenge
      }
      await page.goto(f.origin + '/auth/claim?key=' + encodeURIComponent(publicKey))
      await page.getByLabel('username', { exact: true }).fill(name)
      await page.getByLabel('email', { exact: true }).fill('recovery@example.test')
      const response = page.waitForResponse(r => r.url().endsWith('/api/claim/prepare') && r.request().method() === 'POST')
      await page.getByRole('button', { name: 'continue →', exact: true }).click()
      const result = await response; assert.equal(result.status(), 200, await result.text())
      return (await result.json()).challenge
    }
    const earlier = await start(old, 'expiredtab')
    const active = await start(current, 'activetab')
    assert.notEqual(earlier, active)
    const restart = old.getByRole('button', { name: kind === 'auth' ? 'Restart sign in' : 'Restart claim', exact: true })
    await restart.waitFor({ timeout: 10000 })
    await old.getByRole('alert').filter({ hasText: /expired or was replaced by another tab/ }).waitFor()
    const pollsAtExpiry = oldPolls
    await old.waitForTimeout(3500)
    assert.equal(oldPolls, pollsAtExpiry, 'superseded browser tab must stop polling')
    const signature = sign(null, Buffer.from(active), key.privateKey).toString('base64')
    const answer = await fetch(f.origin + `/api/${kind}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challenge: active, publicKey, signature }), signal: AbortSignal.timeout(30000) })
    assert.equal(answer.status, 200, await answer.text())
    if (kind === 'claim') await current.getByRole('heading', { name: '@activetab is yours', exact: true }).waitFor()
    else await current.waitForURL('**/dashboard')
    assert.ok((await context.cookies()).some(c => c.name === 'gild_session'), 'current tab must complete normally')
    const replay = await current.evaluate(async ({ kind, challenge }) => (await fetch(`/api/${kind}/status?challenge=${encodeURIComponent(challenge)}`)).status, { kind, challenge: active })
    assert.equal(replay, 404, 'completion remains single-use')
    if (kind === 'claim') {
      await restart.click()
      assert.equal(await old.getByLabel('username', { exact: true }).inputValue(), 'expiredtab', 'restart retains the form input')
      await old.getByRole('button', { name: 'continue →', exact: true }).waitFor()
    } else {
      const response = old.waitForResponse(r => r.url().endsWith('/api/auth/challenge') && r.request().method() === 'POST')
      await restart.click()
      const fresh = (await (await response).json()).challenge
      assert.notEqual(fresh, earlier, 'restart must create a new browser-bound challenge')
      assert.notEqual(fresh, active)
      await old.getByText('waiting for your terminal…', { exact: true }).waitFor()
    }
    evidence.push({ kind, runtime: 'two tabs in one real Chrome context', oldTabPollingStopped: true, restart: true, activeTabCompletes: true, completionSingleUse: true })
    await context.close()
  }
  // Lose only the completed HTTP response, including its session cookie. The
  // actual Worker still consumes the single-use claim; the browser retries it.
  const lostKey = generateKeyPairSync('ed25519')
  const lostPublicKey = 'ed25519:' + lostKey.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const context = await browser.newContext(), page = await context.newPage()
  let dropped = false, polls = 0
  await page.route('**/api/claim/status?*', async route => {
    polls++
    // Node fetch does not share the browser's cookie jar. Never apply the lost
    // response's Set-Cookie, unlike a browser-context APIRequestContext.
    const response = await fetch(route.request().url(), { headers: await route.request().allHeaders(), signal: AbortSignal.timeout(30000) })
    const body = await response.text()
    if (!dropped && response.status === 200 && JSON.parse(body).status === 'done') {
      dropped = true; await route.abort('failed'); return
    }
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body })
  })
  await page.goto(f.origin + '/auth/claim?key=' + encodeURIComponent(lostPublicKey))
  await page.getByLabel('username', { exact: true }).fill('lostreply')
  await page.getByLabel('email', { exact: true }).fill('lostreply@example.test')
  const prepared = page.waitForResponse(r => r.url().endsWith('/api/claim/prepare') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'continue →', exact: true }).click()
  const challenge = (await (await prepared).json()).challenge
  const signature = sign(null, Buffer.from(challenge), lostKey.privateKey).toString('base64')
  const answer = await fetch(f.origin + '/api/claim/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challenge, publicKey: lostPublicKey, signature }), signal: AbortSignal.timeout(30000) })
  assert.equal(answer.status, 200, await answer.text())
  await page.getByRole('button', { name: 'Restart claim', exact: true }).waitFor({ timeout: 15000 })
  assert.equal(dropped, true, 'actual completed claim response must be lost')
  assert.ok(!(await context.cookies()).some(c => c.name === 'gild_session'), 'lost response must not issue a browser session')
  const signin = page.getByRole('link', { name: 'Sign in with your key', exact: true })
  assert.equal(await signin.count(), 1, 'lost completed claim must offer explicit sign-in recovery')
  assert.equal(await signin.getAttribute('href'), '/auth/device')
  const stoppedAt = polls
  await page.waitForTimeout(3500)
  assert.equal(polls, stoppedAt, 'consumed lost-response claim must stop polling')
  await page.getByRole('button', { name: 'Restart claim', exact: true }).click()
  const taken = page.waitForResponse(r => r.url().endsWith('/api/claim/prepare') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'continue →', exact: true }).click()
  assert.equal((await taken).status(), 409, 'completed name stays taken after restart')
  await page.getByRole('alert').filter({ hasText: '@lostreply is taken' }).waitFor()
  assert.equal(await signin.count(), 1, 'failed claim restart must retain sign-in recovery')
  const auth = page.waitForResponse(r => r.url().endsWith('/api/auth/challenge') && r.request().method() === 'POST')
  await signin.click()
  const authChallenge = (await (await auth).json()).challenge
  const authAnswer = await fetch(f.origin + '/api/auth/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challenge: authChallenge, publicKey: lostPublicKey, signature: sign(null, Buffer.from(authChallenge), lostKey.privateKey).toString('base64') }), signal: AbortSignal.timeout(30000) })
  assert.equal(authAnswer.status, 200, await authAnswer.text())
  await page.waitForURL('**/dashboard')
  assert.ok((await context.cookies()).some(c => c.name === 'gild_session'), 'same terminal key must sign in through a fresh single-use auth flow')
  evidence.push({ kind: 'claim-lost-response', droppedCompletedResponse: true, noLostCookie: true, pollingStopped: true, restartNameTaken409: true, explicitSignin: true, sameKeyFreshSignin: true })
  await context.close()
  writeFileSync(join(f.work, 'browser-flow-recovery-evidence.json'), JSON.stringify(evidence, null, 2))
  console.log('PASS actual browser two-tab recovery', JSON.stringify(evidence))
} finally {
  await browser?.close()
  f.worker.kill('SIGTERM')
  await new Promise(r => f.worker.exitCode !== null ? r() : f.worker.once('exit', r))
  await new Promise(r => f.server.close(r))
}
