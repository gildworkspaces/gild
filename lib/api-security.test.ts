import { DatabaseSync } from 'node:sqlite'
import { ApiControlStore } from './api/control-store.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dispatch, type Dependencies } from './api/dispatch.ts'
import { routes } from './api/contract.ts'
import { permitsRequest, matchRequest, publicRead } from './api/routing.ts'
import { service } from './api/service.ts'
import { memoryStore } from './drivers/memory.ts'
import type { Principal } from './api/scopes.ts'

const owner: Principal = { id: 'token-1', name: 'acme', publicKey: '', scopes: null, repos: null }
function fixture(p: Principal | null = owner, grants: string[] = []) {
  let calls = 0
  const controls = new Map<string, any>()
  const handlers = service({
    store: memoryStore(),
    index: async () => ({
      metaFile: async () => JSON.stringify({ agents: { '@acme/bot': grants } }),
      metaItem: async () => ({ item: { author: 'acme' } }),
    }),
  } as any)
  const deps: Dependencies = {
    authenticate: async () => p,
    authorize: handlers.authorize,
    execute: async () => { calls++; throw Error('Reached write') },
    control: async (id) => {
      if (!controls.has(id)) {
        const db = new DatabaseSync(':memory:')
        controls.set(id, new ApiControlStore({ exec(q: string, ...args: any[]) {
          if (!args.length && q.includes(';')) { db.exec(q); return [] }
          const st = db.prepare(q)
          if (st.columns().length) return st.all(...args)
          st.run(...args); return []
        }} as any))
      }
      return controls.get(id)
    },
  }
  return { deps, controls, calls: () => calls }
}
const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => new Request('https://gild.test/api/v1' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })

test('matched contract scopes ignore repo names on v1 and legacy paths', async () => {
  const p = { ...owner, scopes: ['issues:write'] }
  for (const repo of ['issues-app', 'pulls-x', 'actions-app', 'agents-app', 'orgs-app']) {
    for (const prefix of ['/api/v1', '/api']) {
      assert.equal(permitsRequest(p, 'PUT', `${prefix}/repos/acme/${repo}/actions/settings`), false)
      assert.equal(permitsRequest(p, 'POST', `${prefix}/repos/acme/${repo}/pulls`), false)
      assert.equal(permitsRequest(p, 'POST', `${prefix}/repos/acme/${repo}/issues`), true)
    }
    for (const route of routes.filter(r => r.scope === 'repo:write' && r.path.includes('{repo}'))) {
      const path = route.path.replace('{owner}', 'acme').replace('{repo}', repo).replace(/\{\w+\}/g, '1'.repeat(40))
      assert.equal(permitsRequest(p, route.method, '/api/v1' + path), false)
      assert.equal((await dispatch(request(path, route.method, {}), fixture(p).deps)).status, 403)
    }
    // Phase A's repo:write operation creates a repository; names are body data.
    assert.equal(permitsRequest(p, 'POST', '/api/repos'), false)
    assert.equal((await dispatch(request('/user/repos', 'POST', { name: repo }), fixture(p).deps)).status, 403)
  }
  assert.equal(matchRequest('POST', '/api/repos/acme/issues-app/pulls/1')?.route.id, 'updatePull')
  assert.equal(permitsRequest(p, 'POST', '/api/repos/acme/pulls-x/pulls/1'), false)
  assert.equal(permitsRequest(p, 'POST', '/api/not-a-contract'), false)
})

test('repo allow-list refuses writes before their effect', async () => {
  const f = fixture({ ...owner, repos: ['acme/other'] })
  const r = await dispatch(request('/repos/acme/demo/issues', 'POST', { title: 'forbidden' }), f.deps)
  assert.equal(r.status, 403); assert.equal(f.calls(), 0)
})
test('pulls:write without repository writer access cannot merge', async () => {
  const f = fixture({ ...owner, name: 'outsider', scopes: ['pulls:write'] })
  const r = await dispatch(request('/repos/acme/demo/pulls/1/merge', 'PUT', {}), f.deps)
  assert.equal(r.status, 403); assert.equal(f.calls(), 0)
})
test('agent token cannot exceed current grants or operation grants', async () => {
  for (const [grants, path, method, body] of [
    [[], '/repos/acme/demo/issues', 'POST', { title: 'no grant' }],
    [['pr'], '/repos/acme/demo/pulls/1/merge', 'PUT', {}],
    [['pr'], '/repos/acme/demo/pulls/1/reviews', 'POST', { event: 'APPROVE' }],
  ] as const) {
    const f = fixture({ ...owner, name: 'acme/bot' }, [...grants])
    const r = await dispatch(request(path, method, body), f.deps)
    assert.equal(r.status, 403); assert.equal(f.calls(), 0)
  }
})

test('issues:write cannot merge even for the repo owner', async () => {
  const f = fixture({ ...owner, scopes: ['issues:write'] })
  assert.equal((await dispatch(request('/repos/acme/demo/pulls/1/merge', 'PUT', {}), f.deps)).status, 403)
  assert.equal(f.calls(), 0)
})
test('createToken allow-list comparison is case insensitive and cannot widen', async () => {
  const f = fixture({ ...owner, repos: ['acme/demo'] })
  const path = '/user/tokens', body = { scopes: ['repo:read'], repos: ['ACME/DEMO'], label: 'case' }
  assert.equal((await dispatch(request(path, 'POST', body), f.deps)).status, 500)
  assert.equal(f.calls(), 1)
  assert.equal((await dispatch(request(path, 'POST', { ...body, repos: ['acme/other'] }), f.deps)).status, 403)
  assert.equal(f.calls(), 1)
})
test('anonymous public reads use independent IP buckets and never authorize writes', async () => {
  const f = fixture(null)
  f.deps.authorize = async () => {}
  f.deps.execute = async () => ({ data: [] })
  for (let i = 0; i < 60; i++) assert.equal((await dispatch(request('/repos/acme/demo/issues', 'GET', undefined, { 'cf-connecting-ip': '192.0.2.1' }), f.deps)).status, 200)
  assert.equal((await dispatch(request('/repos/acme/demo/issues', 'GET', undefined, { 'cf-connecting-ip': '192.0.2.1' }), f.deps)).status, 429)
  const other = await dispatch(request('/repos/acme/demo/issues', 'GET', undefined, { 'cf-connecting-ip': '192.0.2.2' }), f.deps)
  assert.equal(other.status, 200); assert.equal(other.headers.get('x-ratelimit-limit'), '60')
  assert.equal((await dispatch(request('/repos/acme/demo/issues', 'POST', { title: 'no' }), f.deps)).status, 401)
  assert.equal((await dispatch(request('/user/repos'), f.deps)).status, 401)
  assert.equal((await dispatch(request('/repos/acme/demo/issues', 'GET', undefined, { authorization: 'Bearer bad' }), f.deps)).status, 401)
})
test('anonymous cannot read authentication-only contract routes', async () => {
  const f = fixture(null)
  for (const route of routes.filter(r => r.method === 'GET' && r.scope && !publicRead(r))) {
    const path = route.path.replace(/\{\w+\}/g, 'value')
    assert.equal((await dispatch(request(path), f.deps)).status, 401, route.id)
  }
  assert.equal(f.calls(), 0)
})
test('fresh tokens share the principal rate limit', async () => {
  const f = fixture()
  f.deps.authorize = async () => {}
  f.deps.execute = async () => ({ data: [] })
  for (let i = 0; i < 10000; i++) {
    f.deps.authenticate = async () => ({ ...owner, id: 'token-' + i })
    assert.equal((await dispatch(request('/repos/acme/demo/issues'), f.deps)).status, 200)
  }
  f.deps.authenticate = async () => ({ ...owner, id: 'new-token' })
  assert.equal((await dispatch(request('/repos/acme/demo/issues'), f.deps)).status, 429)
  f.deps.authenticate = async () => ({ ...owner, id: 'other', name: 'another' })
  assert.equal((await dispatch(request('/repos/acme/demo/issues'), f.deps)).status, 200)
})
test('malformed percent-encoding returns 400', async () => {
  assert.equal((await dispatch(request('/repos/acme/%ZZ/issues'), fixture().deps)).status, 400)
})
test('uncertain POST PUT PATCH DELETE writes retain their reservation', async () => {
  for (const [path, method, body, data] of [
    ['/repos/acme/demo/pulls/1/merge', 'PUT', {}, { sha: null, merged: false, message: 'queued', queued: true }],
    ['/user/tokens/abc', 'DELETE', undefined, { ok: true }],
    ['/agents/bot', 'PATCH', { approver: true }, { ok: true }],
    ['/repos/acme/demo/issues/1/claim', 'POST', { action: 'claim' }, { ok: true }],
  ] as const) {
    const f = fixture()
    f.deps.authorize = async () => {}
    let calls = 0
    f.deps.execute = async () => { if (++calls === 1) throw Error('write failed'); return { data } }
    const run = () => dispatch(request(path, method, body, { 'idempotency-key': 'retry' }), f.deps)
    assert.equal((await run()).status, 500)
    assert.equal((await run()).status, 409)
    assert.equal((await run()).status, 409)
    assert.equal(calls, 1, 'unknown write outcome must not execute again')
  }
})

test('anonymous missing IP fails before allocation', async () => {
  const f = fixture(null)
  assert.equal((await dispatch(request('/repos/acme/demo/issues'), f.deps)).status, 400)
  assert.equal(f.controls.size, 0)
})
test('idempotency lease expires and fences abandoned claims', async () => {
  const control = await fixture().deps.control('lease') as ApiControlStore
  const first = control.begin('key', 'input', 0)
  assert.equal(first.kind, 'new')
  assert.equal(control.begin('key', 'input', 59999).kind, 'pending')
  const next = control.begin('key', 'input', 60000)
  assert.equal(next.kind, 'new')
  if (first.kind !== 'new' || next.kind !== 'new') throw Error('lease')
  assert.equal(control.activate('key', first.claim, 60000), false)
  assert.equal(control.activate('key', next.claim, 60000), true)
  control.release('key', first.claim)
  assert.equal(control.begin('key', 'input', 120001).kind, 'pending')
  control.finish('key', next.claim, {status: 200, body: 'saved', headers: {}})
  assert.equal(control.begin('key', 'input', 120002).kind, 'replay')
})
test('idempotency finish failure cannot repeat a successful write after lease expiry', async () => {
  const f = fixture()
  f.deps.authorize = async () => {}
  let writes = 0
  f.deps.execute = async () => { writes++; return { data: {ok: true} } }
  const control = await f.deps.control(owner.id)
  control.finish = () => { throw Error('storage unavailable') }
  const run = () => dispatch(request('/user/tokens/abc', 'DELETE', undefined, {'idempotency-key': 'finish-failure'}), f.deps)
  assert.equal((await run()).status, 500)
  assert.equal((await run()).status, 409)
  const now = Date.now
  try {
    Date.now = () => now() + 60001
    assert.equal((await run()).status, 409)
    assert.equal(writes, 1)
  } finally { Date.now = now }
})
