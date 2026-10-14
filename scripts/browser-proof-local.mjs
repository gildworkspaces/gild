// Actual compiled OpenNext route handlers on workerd and D1; all data disposable.
import { forgeFixture } from './forge-fixture.mjs'
import { generateKeyPairSync, sign } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { launchChrome } from './chrome.mjs'
import { verifySessionCookie } from '../lib/session-cookie.ts'
const f = await forgeFixture({ renderBuild: false })
const key = generateKeyPairSync('ed25519')
const publicKey = 'ed25519:' + key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const post = (path, body, headers = {}) => fetch(f.origin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) })
const get = (kind, challenge, cookie, headers = {}) => fetch(f.origin + `/api/${kind}/status?challenge=${encodeURIComponent(challenge)}`, { headers: { ...(cookie ? { cookie } : {}), ...headers }, signal: AbortSignal.timeout(30000) })
const json = async (r, code = 200) => { assert.equal(r.status, code, await r.clone().text()); return r.json() }
const evidence = []
let browser
try {
  const until = Date.now() + 60000
  while (true) {
    try { if ((await fetch(f.origin + '/__fixture/calls?trace=browser-proof-ready', { signal: AbortSignal.timeout(1000) })).ok) break } catch {}
    assert.ok(Date.now() < until, 'fixture startup deadline')
    await new Promise(r => setTimeout(r, 250))
  }
  for (const kind of ['auth', 'claim']) {
    const start = () => kind === 'auth' ? post('/api/auth/challenge', {}, { origin: f.origin }) : post('/api/claim/prepare', { name: 'boundbrowser', email: 'browser@example.test', publicKey }, { origin: f.origin })
    const first = await start(), { challenge } = await json(first), cookie = first.headers.get('set-cookie').split(';')[0]
    assert.match(first.headers.get('set-cookie'), /HttpOnly.*Secure.*SameSite=Strict/)
    const second = await start(), { challenge: otherChallenge } = await json(second), otherCookie = second.headers.get('set-cookie').split(';')[0]
    assert.notEqual(otherCookie, cookie, 'each initiating browser receives distinct random state')
    assert.deepEqual(await json(await get(kind, challenge, cookie)), { status: 'pending' })
    const signature = sign(null, Buffer.from(challenge), key.privateKey).toString('base64')
    await json(await post(`/api/${kind}/answer`, { challenge, publicKey, signature }))
    for (const [target, state, headers] of [[challenge, null, {}], [challenge, otherCookie, {}], [otherChallenge, cookie, {}], [challenge, cookie, { 'sec-fetch-site': 'cross-site' }]]) {
      const denied = await get(kind, target, state, headers)
      await json(denied, 404)
      assert.equal(denied.headers.get('set-cookie'), null)
    }
    const replies = await Promise.all(Array.from({ length: 8 }, () => get(kind, challenge, cookie)))
    assert.equal(replies.filter(r => r.status === 200).length, 1, 'one real D1 completion must issue a session')
    assert.equal(replies.filter(r => r.status === 404).length, 7)
    const accepted = replies.find(r => r.status === 200)
    assert.deepEqual(await json(accepted), kind === 'auth' ? { status: 'ok' } : { status: 'done', name: 'boundbrowser' })
    const session = accepted.headers.getSetCookie().find(v => v.startsWith('gild_session=')).split(';')[0].slice('gild_session='.length)
    assert.equal((await verifySessionCookie(session, f.sessionSecret))?.publicKey, publicKey)
    assert.match(accepted.headers.get('cache-control'), /no-store/)
    await json(await get(kind, challenge, cookie), 404)
    if (kind === 'auth') assert.match((await json(await post('/api/tokens', { challenge, publicKey, signature }))).token, /^gf_/)
    evidence.push({ kind, separateBrowserDenied: true, concurrency: 8, issuedSessions: 1, signedSessionVerified: true, replayDenied: true })
  }
  for (const path of ['/api/auth/challenge', '/api/claim/prepare']) await json(await post(path, {}, { origin: 'https://other.example.test', 'sec-fetch-site': 'same-origin', 'x-gild-browser-proof-origin': 'https://other.example.test' }), 403)
  browser = await launchChrome()
  const initiating = await browser.newContext(), unrelated = await browser.newContext()
  const a = await initiating.newPage(), b = await unrelated.newPage()
  await a.goto(f.origin + '/__fixture/calls?trace=auth-browser')
  await b.goto(f.origin + '/__fixture/calls?trace=auth-browser')
  for (const kind of ['auth', 'claim']) {
    const challenge = await a.evaluate(async ({ kind, publicKey }) => {
      const path = kind === 'auth' ? '/api/auth/challenge' : '/api/claim/prepare'
      const body = kind === 'auth' ? {} : { name: 'boundweb', email: 'browser@example.test', publicKey }
      const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) throw Error(await r.text())
      return (await r.json()).challenge
    }, { kind, publicKey })
    const stateCookie = (await initiating.cookies()).find(c => c.name === '__Host-gild_' + kind + '_state')
    assert.ok(stateCookie, 'real Chrome must store the initiating state cookie')
    assert.equal(stateCookie.httpOnly, true); assert.equal(stateCookie.secure, true); assert.equal(stateCookie.sameSite, 'Strict')
    assert.ok(!(await a.evaluate(() => document.cookie)).includes('__Host-gild_'), 'state is not readable by page JavaScript')
    const signature = sign(null, Buffer.from(challenge), key.privateKey).toString('base64')
    await json(await post(`/api/${kind}/answer`, { challenge, publicKey, signature }))
    const read = (page) => page.evaluate(async ({ kind, challenge }) => {
      const r = await fetch(`/api/${kind}/status?challenge=${encodeURIComponent(challenge)}`)
      return { status: r.status, body: await r.json() }
    }, { kind, challenge })
    assert.equal((await read(b)).status, 404)
    assert.ok(!(await unrelated.cookies()).some(c => c.name === 'gild_session'), 'unrelated Chrome context receives no session')
    const done = await read(a)
    assert.equal(done.status, 200)
    const sessionCookie = (await initiating.cookies()).find(c => c.name === 'gild_session')
    assert.ok(sessionCookie, 'initiating Chrome context receives its real session')
    assert.equal((await verifySessionCookie(sessionCookie.value, f.sessionSecret))?.publicKey, publicKey)
    assert.ok(!(await initiating.cookies()).some(c => c.name === '__Host-gild_' + kind + '_state'), 'state cookie is cleared')
    assert.equal((await read(a)).status, 404)
    evidence.push({ kind, runtime: 'two real Chrome contexts', initiatingBrowserSignedIn: true, unrelatedBrowserDenied: true, httpOnlyState: true, replayDenied: true })
  }
  writeFileSync(join(f.work, 'browser-proof-evidence.json'), JSON.stringify({ runtime: 'compiled OpenNext + workerd + D1', evidence }, null, 2))
  console.log('PASS real Worker browser-bound login/claim, distinct browser states, atomic completion and terminal token proof', JSON.stringify(evidence))
} finally {
  await browser?.close()
  f.worker.kill('SIGTERM')
  await new Promise(r => f.worker.exitCode !== null ? r() : f.worker.once('exit', r))
  await new Promise(r => f.server.close(r))
}
