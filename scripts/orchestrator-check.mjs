import { flushChannelFixture } from './channel-fixture.mjs'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { randomBytes, generateKeyPairSync } from 'node:crypto'
import { join } from 'node:path'
// Orchestrator agents through the production Worker fixture: owner-only
// grants, scope narrowing, the child limit, suspension (no mentions, 403,
// system notes), the raw mention view and revoke cascades.
export async function orchestratorSuite({ request, work, token }) {
  await build({ entryPoints: ['lib/api/contract.ts'], outfile: join(work, 'orchestrator-contract.mjs'), bundle: true, platform: 'node', format: 'esm' })
  const { routes } = await import(join(work, 'orchestrator-contract.mjs'))
  const repo = '/api/v1/repos/acme/demo', covered = new Set()
  const tokens = { owner: token }
  const as = (name) => ({ authorization: `Bearer ${tokens[name]}` })
  const send = (path, method = 'GET', body, name = 'owner') => request(path, method, body, as(name))
  const checked = async (id, path, method, body, name, status = 200) => {
    const r = await send(path, method, body, name)
    assert.equal(r.status, status, `${id}: ${r.status} ${await r.clone().text()}`)
    const data = await r.json()
    routes.find((route) => route.id === id).output.parse(data)
    covered.add(id)
    return data
  }
  const refused = async (path, method, body, name, status, why) => {
    const r = await send(path, method, body, name)
    assert.equal(r.status, status, `${why}: ${r.status} ${await r.clone().text()}`)
  }
  const key = () => 'ed25519:' + generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const events = async (name, since = '0') => {
    const r = await send('/api/v1/events?repos=acme/demo&wait=0&since=' + since, 'GET', undefined, name)
    assert.equal(r.status, 200, `${name} events: ${r.status} ${await r.clone().text()}`)
    return r.json()
  }
  const mentions = async (name, since) => (await events(name, since)).events.filter((e) => e.event === 'channel.mention')
  const post = async (body) => {
    const r = await send(repo + '/channel/messages', 'POST', { body })
    assert.equal(r.status, 201, await r.clone().text())
    return r.json()
  }
  const participants = async () => (await (await send(repo + '/channel/participants')).json()).participants

  // Actors. acme/orch holds pr+review here; its token has repo:write but not
  // pulls:write. acme/narrow holds pr here but its token cannot write.
  for (const [name, actor, scopes] of [
    ['orch', 'acme/orch', ['repo:read', 'repo:write', 'channel:write']],
    ['narrow', 'acme/narrow', ['repo:read', 'channel:write']],
    ['plain', 'acme/plain', ['repo:read', 'channel:write']],
    ['wide', 'acme/wide', ['repo:read', 'repo:write', 'issues:write', 'pulls:write', 'channel:write']],
    ['writer', 'orchwriter', ['repo:read', 'repo:write', 'agents']],
  ]) {
    tokens[name] = 'gf_' + randomBytes(16).toString('hex')
    assert.equal((await request('/privacy-fixture', 'POST', { actor, token: tokens[name], scopes })).status, 200)
  }
  const before = (await (await request('/privacy-fixture', 'POST', { status: true })).json()).access.acl
  const acl = { ...before, schema: 1, owners: ['@acme'], write: [...(before.write ?? []), '@orchwriter'], agents: { ...(before.agents ?? {}), '@acme/orch': ['pr', 'review'], '@acme/narrow': ['pr'], '@acme/plain': [], '@acme/wide': ['pr'] } }
  await request('/privacy-fixture', 'POST', { acl })
  await flushChannelFixture(request)

  // 1. Only an owner or admin grants orchestrator.
  await refused(repo + '/orchestrators', 'POST', { agent: 'acme/orch' }, 'writer', 403, 'a repository writer is not an admin')
  await refused(repo + '/orchestrators', 'POST', { agent: 'acme/orch' }, 'plain', 403, 'agents cannot grant')
  assert.deepEqual((await checked('repoOrchestrators', repo + '/orchestrators')).orchestrators, [], 'refused grants leave no orchestrator')
  const granted = await checked('setRepoOrchestrator', repo + '/orchestrators', 'POST', { agent: '@acme/orch', child_limit: 2 })
  assert.deepEqual([granted.agent, granted.scope, granted.child_limit, granted.granted_by], ['acme/orch', 'repo', 2, 'acme'])
  await checked('setRepoOrchestrator', repo + '/orchestrators', 'POST', { agent: 'acme/narrow' })
  const listed = (await checked('repoOrchestrators', repo + '/orchestrators')).orchestrators
  assert.deepEqual(listed.map((o) => o.agent).sort(), ['acme/narrow', 'acme/orch'])
  assert.equal(listed.find((o) => o.agent === 'acme/narrow').child_limit, 10, 'default child limit')
  const ranks = Object.fromEntries((await participants()).map((p) => [p.name, p.prefix]))
  assert.equal(ranks['acme/orch'], '%', 'orchestrators carry the % prefix')
  assert.equal(ranks['acme/plain'], '+')
  assert.equal(ranks.acme, '@')

  // 2. Children are never wider than the orchestrator.
  const children = repo + '/agents/children'
  await refused(children, 'POST', { label: 'child-x', publicKey: key() }, 'plain', 403, 'only orchestrators spawn')
  await refused(children, 'POST', { label: 'child-x', publicKey: key() }, 'owner', 403, 'people approve join requests instead')
  await refused(children, 'POST', { label: 'child-x', publicKey: key(), grants: ['queue'] }, 'orch', 403, 'a grant the orchestrator does not hold here')
  await refused(children, 'POST', { label: 'child-x', publicKey: key(), grants: ['review'] }, 'orch', 403, 'review needs pulls:write, which the orchestrator token lacks')
  await refused(children, 'POST', { label: 'child-x', publicKey: key(), grants: ['pr'] }, 'narrow', 403, 'pr needs repo:write, which the narrow token lacks')
  // A token wide enough for review still cannot pass on a grant it lacks here.
  await checked('setRepoOrchestrator', repo + '/orchestrators', 'POST', { agent: 'acme/wide' })
  await refused(children, 'POST', { label: 'child-x', publicKey: key(), grants: ['review'] }, 'wide', 403, 'wide holds pulls:write but not the review grant')
  assert.deepEqual((await checked('deleteRepoOrchestrator', repo + '/orchestrators/acme/wide', 'DELETE', undefined, 'owner')).revoked, [])
  const one = await checked('createChildAgent', children, 'POST', { label: 'child-one', publicKey: key(), note: 'triage helper' }, 'orch', 201)
  assert.deepEqual([one.name, one.sponsor, one.human, one.repo, one.suspended], ['acme/child-one', 'acme/orch', 'acme', 'acme/demo', false])
  assert.deepEqual(one.scopes, ['repo:read', 'channel:write'])
  assert.match(one.token, /^gf_/)
  tokens.one = one.token
  // The child's token is scoped: it reads and talks, it cannot write the repo.
  assert.equal((await send(repo + '/channel/messages', 'GET', undefined, 'one')).status, 200)
  await refused(repo + '/issues', 'POST', { title: 'child write' }, 'one', 403, 'child token cannot write issues')
  const said = await send(repo + '/channel/messages', 'POST', { body: 'child-one reporting' }, 'one')
  assert.equal(said.status, 201, 'a child sends channel messages: ' + await said.clone().text())
  const narrowChild = await checked('createChildAgent', children, 'POST', { label: 'narrow-kid', publicKey: key() }, 'narrow', 201)
  assert.deepEqual(narrowChild.scopes, ['repo:read', 'channel:write'])

  // 3. The per-orchestrator limit.
  tokens.two = (await checked('createChildAgent', children, 'POST', { label: 'child-two', publicKey: key() }, 'orch', 201)).token
  await refused(children, 'POST', { label: 'child-three', publicKey: key() }, 'orch', 403, 'third child exceeds a limit of 2')
  await refused(children, 'POST', { label: 'child-one', publicKey: key() }, 'narrow', 409, 'names are unique')
  const mine = await checked('childAgents', children, 'GET', undefined, 'orch')
  assert.deepEqual(mine.map((c) => c.name).sort(), ['acme/child-one', 'acme/child-two'])
  assert.deepEqual((await checked('childAgents', children, 'GET', undefined, 'owner')).map((c) => c.name).sort(), ['acme/child-one', 'acme/child-two', 'acme/narrow-kid'])
  await refused(children, 'GET', undefined, 'plain', 403, 'plain agents cannot list children')
  assert.equal((await checked('repoOrchestrators', repo + '/orchestrators')).orchestrators.find((o) => o.agent === 'acme/orch').children, 2)

  // 4. A child receives its own mentions with its repo-restricted token.
  let start = (await events('one')).cursor
  const first = await post('@child-one please triage')
  const got = await mentions('one', start)
  assert.deepEqual(got.map((e) => e.payload.message.id), [first.id], 'the child is mentioned')

  // 5. Suspension: offline, no mentions, 403, system notes.
  await refused(repo + '/agents/acme/child-two/suspend', 'POST', {}, 'plain', 403, 'a plain agent cannot suspend')
  await refused(repo + '/agents/acme/child-two/suspend', 'POST', {}, 'narrow', 403, 'another orchestrator cannot suspend it')
  await refused(repo + '/agents/acme/child-two/suspend', 'POST', {}, 'writer', 403, 'a non-admin person cannot suspend')
  await refused(repo + '/agents/acme/orch/suspend', 'POST', {}, 'orch', 403, 'an orchestrator does not suspend itself')
  const off = await checked('suspendAgent', repo + '/agents/acme/child-one/suspend', 'POST', {}, 'orch')
  assert.deepEqual([off.agent, off.suspended, off.suspended_by], ['acme/child-one', true, 'acme/orch'])
  await refused(repo + '/agents/acme/child-one/suspend', 'POST', {}, 'orch', 409, 'already suspended')
  assert.ok(!(await participants()).some((p) => p.name === 'acme/child-one'), 'a suspended agent leaves the participants')
  for (const path of [repo + '/channel/messages', '/api/v1/events?repos=acme/demo&wait=0'])
    await refused(path, 'GET', undefined, 'one', 403, 'a suspended token answers 403')
  start = (await events('orch')).cursor
  const missed = await post('@acme/child-one are you there?')
  const notes = (await (await send(repo + '/channel/messages?limit=20')).json()).messages.filter((m) => m.kind === 'system')
  assert.ok(notes.some((m) => m.body === 'suspended @acme/child-one' && m.author.name === 'acme/orch'), 'suspension writes a system note')
  const resumed = await checked('resumeAgent', repo + '/agents/acme/child-one/resume', 'POST', {}, 'owner')
  assert.deepEqual([resumed.suspended, resumed.suspended_at], [false, null])
  assert.ok((await (await send(repo + '/channel/messages?limit=20')).json()).messages.some((m) => m.kind === 'system' && m.body === 'resumed @acme/child-one' && m.author.name === 'acme'), 'resuming writes a system note')
  assert.equal((await send(repo + '/channel/messages', 'GET', undefined, 'one')).status, 200, 'a resumed token works again')
  assert.ok(!(await mentions('one', start)).some((e) => e.payload.message.id === missed.id), 'no mention while suspended')
  assert.ok(!(await mentions('orch', start)).some((e) => e.payload.message.id === missed.id), 'not even in the raw view')
  assert.ok((await participants()).some((p) => p.name === 'acme/child-one'))

  // 6. Raw view: the orchestrator reads every agent's mentions; others only their own.
  const startOrch = (await events('orch')).cursor, startPlain = (await events('plain')).cursor, startOne = (await events('one')).cursor
  const toTwo = await post('@child-two run the flaky test')
  const toPlain = await post('@acme/plain heads up')
  const raw = (await mentions('orch', startOrch)).map((e) => [e.payload.agent, e.payload.message.id])
  assert.deepEqual(raw, [['acme/child-two', toTwo.id], ['acme/plain', toPlain.id]], 'the orchestrator sees every mention in the repo')
  assert.deepEqual((await mentions('plain', startPlain)).map((e) => e.payload.message.id), [toPlain.id], 'a plain agent sees only its own')
  assert.deepEqual(await mentions('one', startOne), [], 'a child sees no one else\'s')

  // 7. Revoking cascades: grant → children → grandchildren.
  await checked('setRepoOrchestrator', repo + '/orchestrators', 'POST', { agent: 'acme/child-two' })
  tokens.grand = (await checked('createChildAgent', children, 'POST', { label: 'grandchild', publicKey: key() }, 'two', 201)).token
  await refused(repo + '/orchestrators/acme/orch', 'DELETE', undefined, 'writer', 403, 'a writer cannot revoke')
  const gone = await checked('deleteRepoOrchestrator', repo + '/orchestrators/acme/orch', 'DELETE', undefined, 'owner')
  assert.deepEqual(gone.revoked.sort(), ['acme/child-one', 'acme/child-two', 'acme/grandchild'])
  for (const name of ['one', 'two', 'grand'])
    await refused(repo + '/channel/messages', 'GET', undefined, name, 401, `${name}: a revoked child token stops working`)
  assert.deepEqual((await checked('repoOrchestrators', repo + '/orchestrators')).orchestrators.map((o) => o.agent), ['acme/narrow'], 'the cascade removes descendants\' grants')
  assert.ok(!(await participants()).some((p) => ['acme/child-one', 'acme/child-two', 'acme/grandchild'].includes(p.name)))
  assert.equal((await send(repo + '/channel/messages', 'GET', undefined, 'orch')).status, 200, 'the orchestrator itself stays')
  await refused(repo + '/orchestrators/acme/orch', 'DELETE', undefined, 'owner', 404, 'already revoked')
  // Revoking the narrow orchestrator agent itself takes its child too.
  assert.equal((await send(repo + '/channel/messages', 'GET', undefined, 'narrow')).status, 200)

  // 8. Org grants: org owners and admins only.
  const org = await send('/api/v1/orgs', 'POST', { name: 'orch-org', description: 'orchestrator fixture' })
  assert.ok([201, 409].includes(org.status), await org.clone().text())
  await refused('/api/v1/orgs/orch-org/orchestrators', 'GET', undefined, 'writer', 404, 'non-members do not see org grants')
  await refused('/api/v1/orgs/orch-org/orchestrators', 'POST', { agent: 'acme/narrow' }, 'writer', 404, 'non-members cannot grant')
  const orgGrant = await checked('setOrgOrchestrator', '/api/v1/orgs/orch-org/orchestrators', 'POST', { agent: 'acme/narrow', child_limit: 3 })
  assert.deepEqual([orgGrant.scope, orgGrant.child_limit], ['org', 3])
  assert.deepEqual((await checked('orgOrchestrators', '/api/v1/orgs/orch-org/orchestrators')).orchestrators.map((o) => o.agent), ['acme/narrow'])
  const orgGone = await checked('deleteOrgOrchestrator', '/api/v1/orgs/orch-org/orchestrators/acme/narrow', 'DELETE')
  assert.deepEqual(orgGone.revoked, [], 'children spawned under the repo grant survive the org revoke')
  assert.deepEqual((await checked('orgOrchestrators', '/api/v1/orgs/orch-org/orchestrators')).orchestrators, [])

  await request('/privacy-fixture', 'POST', { acl: before })
  await flushChannelFixture(request)
  console.log('Orchestrators: owner-only grants, % prefix, scope and grant narrowing, child limit, child mentions, suspension (participants, mentions, 403, notes), raw mention view, revoke cascade, org grants passed')
  return { covered: [...covered] }
}
