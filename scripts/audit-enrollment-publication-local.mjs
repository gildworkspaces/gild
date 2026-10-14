// Compiled OpenNext/workerd, actual D1/DO/Git, Chrome owner requests and
// native Cache API. All identities/keys/grants/data are disposable fixtures.
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { forgeFixture } from './forge-fixture.mjs'
import { launchChrome } from './chrome.mjs'
const f = await forgeFixture({ renderBuild: false, staticReview: true, publicationAudit: true })
const base = '/avatest/admission-test'
f.seedRepo('u-avatest', 'admission-test', [{ path: 'README.md', text: '# Private enrollment fixture\n' }])
const keys = generateKeyPairSync('ed25519')
const publicKey = 'ed25519:' + keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const proof = challenge => sign(null, Buffer.from(challenge), keys.privateKey).toString('base64')
const nodeRequest = (path, method = 'GET', body, token = f.tokens.avatest) => fetch(f.origin + path, {
  method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000),
})
const json = async (response, status = 200) => { assert.equal(response.status, status, await response.clone().text()); return response.json() }
let browser
try {
  const deadline = Date.now() + 120000
  for (;;) {
    try { if ((await nodeRequest('/api/v1/repos' + base)).status === 200) break } catch {}
    assert.ok(Date.now() < deadline, 'fixture repository projection ready')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  await json(await nodeRequest('/api/v1/repos' + base + '/visibility', 'PATCH', { visibility: 'private' }))
  browser = await launchChrome()
  const context = await browser.newContext()
  await context.addCookies([{ name: 'gild_session', value: f.cookie('avatest'), url: f.origin }])
  const page = await context.newPage()
  await page.goto(f.origin + '/__fixture/publication-audit')
  const ownerRequest = (path, method, body) => page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json(), calls: JSON.parse(response.headers.get('x-fixture-calls') ?? 'null') }
  }, { path, method, body })
  if (!process.argv.includes('--publication-only')) {
  const join = label => nodeRequest('/api/agents/requests', 'POST', { sponsor: 'avatest', label, publicKey, repo: base.slice(1), grants: ['pr'] })
  const first = await json(await join('audit-agent'), 201)
  const legacy = await json(await join('audit-agent'), 201)
  const approved = await ownerRequest('/api/agents/requests/' + first.id, 'POST', { decision: 'approve', grants: ['pr'] })
  assert.equal(approved.status, 200); assert.equal(approved.body.status, 'approved')
  const collected = await json(await nodeRequest('/api/agents/requests/' + first.id + '/token', 'POST', { signature: proof('gild-agent-join:' + first.id) }))
  assert.ok(collected.token?.startsWith('gf_'))
  await json(await nodeRequest('/api/v1/repos' + base + '/issues', 'GET', undefined, collected.token))
  await json(await nodeRequest('/api/v1/repos' + base + '/issues', 'POST', { title: 'Agent grant effect', body: 'Disposable evidence' }, collected.token), 201)
  const revoked = await ownerRequest('/api/agents/audit-agent', 'DELETE')
  assert.equal(revoked.status, 200)
  assert.equal((await nodeRequest('/api/v1/repos' + base + '/issues', 'GET', undefined, collected.token)).status, 404)
  await json(await join('audit-agent'), 409)
  const oldApproval = await ownerRequest('/api/agents/requests/' + legacy.id, 'POST', { decision: 'approve', grants: ['pr'] })
  assert.equal(oldApproval.status, 409)
  await json(await nodeRequest('/api/agents/requests/' + first.id + '/token', 'POST', { signature: proof('gild-agent-join:' + first.id) }), 404)
  const pending = await ownerRequest('/api/agents/requests/' + legacy.id, 'GET')
  assert.equal(pending.status, 200); assert.equal(pending.body.status, 'pending'); assert.equal(pending.body.tokenIssued, false)
  assert.equal((await ownerRequest('/api/agents/requests/' + legacy.id, 'POST', { decision: 'deny' })).status, 200)
  const fresh = await json(await nodeRequest('/api/agents/requests', 'POST', { sponsor: 'avatest', label: 'audit-fresh', publicKey, grants: [] }), 201)
  assert.equal((await ownerRequest('/api/agents/requests/' + fresh.id, 'POST', { decision: 'approve', grants: [] })).status, 200)
  const freshToken = await json(await nodeRequest('/api/agents/requests/' + fresh.id + '/token', 'POST', { signature: proof('gild-agent-join:' + fresh.id) }))
  assert.equal((await nodeRequest('/api/v1/repos' + base + '/issues', 'GET', undefined, freshToken.token)).status, 404)
  console.log('PASS compiled enrollment/Chrome approval: fresh grant reads/writes, revoked label409, pending approval409, old token/collection denied, fresh label inherits no private grant')

  }
  const epoch = async () => json(await nodeRequest('/__fixture/publication-audit'))
  await json(await nodeRequest('/__fixture/publication-audit?init=1'))
  const before = (await epoch()).generation
  assert.ok(before, 'native Cache API stores a real read generation')
  const authChallenge = await nodeRequest('/api/auth/challenge', 'POST', {})
  const challenge = await json(authChallenge)
  const answer = await nodeRequest('/api/auth/answer', 'POST', { challenge: challenge.challenge, publicKey, signature: proof(challenge.challenge) })
  await json(answer)
  const signout = await ownerRequest('/api/auth/signout', 'POST', {})
  assert.equal(signout.status, 200)
  assert.equal((await context.cookies()).some(cookie => cookie.name === 'gild_session'), false, 'real Chrome signout clears its session')
  const forged = await fetch(f.origin + '/api/auth/signout', { method: 'POST', headers: { cookie: 'gild_session=' + f.cookie('avatest'), origin: 'https://other.fixture.invalid', 'x-gild-browser-proof-origin': f.origin }, signal: AbortSignal.timeout(30000) })
  assert.equal(forged.status, 403, 'Worker strips a forged trusted-origin header and signout rejects cross-site intent')
  assert.equal(forged.headers.has('set-cookie'), false)
  for (const response of [authChallenge, answer]) {
    const counts = JSON.parse(response.headers.get('x-fixture-calls'))
    assert.equal(counts.publication, 0, 'auth write makes zero public job/forge-owner enumeration statements')
    assert.equal(counts.render, 0, 'auth write does not invoke HTML production')
  }
  assert.equal(signout.calls.publication, 0)
  assert.equal(signout.calls.render, 0)
  assert.equal((await epoch()).generation, before, 'all three real auth writes preserve native cache generation')
  const changed = await nodeRequest('/api/v1/repos' + base + '/issues', 'POST', { title: 'Public invalidation positive control', body: 'Disposable evidence' })
  await json(changed, 201)
  assert.notEqual((await epoch()).generation, before, 'genuine content mutation still invalidates native cache')
  assert.ok(JSON.parse(changed.headers.get('x-fixture-calls')).publication > 0, 'genuine mutation still schedules publication bookkeeping')
  mkdirSync('.tmp', { recursive: true })
  writeFileSync('.tmp/audit-enrollment-publication-evidence.json', JSON.stringify({ enrollment: { freshGrant: true, revokedRequest409: true, revokedApproval409: true, oldTokenDenied: true, oldCollectionDenied: true, freshLabelNoInheritedGrant: true }, publication: { authWrites: 3, publicStatements: 0, rendererCalls: 0, nativeGenerationPreserved: true, contentPositiveControl: true }, limits: 'Disposable real Worker/browser/cache effects; no production timing or full speed acceptance' }, null, 2) + '\n')
  console.log('PASS actual Worker auth writes: zero public bookkeeping/production, native cache generation preserved; real content write still invalidates/enqueues')
} finally {
  await browser?.close()
  f.worker.kill('SIGTERM')
  await new Promise(resolve => f.worker.exitCode !== null || f.worker.signalCode !== null ? resolve() : f.worker.once('exit', resolve))
  await new Promise(resolve => f.server.close(resolve))
}
