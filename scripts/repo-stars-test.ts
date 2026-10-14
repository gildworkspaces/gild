import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { d1Store } from '../lib/drivers/d1'
import { service, type Services } from '../lib/api/service'
import { GildClient } from '../lib/api/client'
import { dispatch, type Control } from '../lib/api/dispatch'

test('stars persist in D1; idempotent toggle, live payloads, anonymous/private read boundary, rename', async () => {
  const sql = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sql.exec(readFileSync('migrations/' + file, 'utf8'))
  const statement = (q: string, a: any[] = []) => ({
    bind: (...args: any[]) => statement(q, args),
    run: async () => ({ meta: sql.prepare(q).run(...a) }),
    first: async () => sql.prepare(q).get(...a) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...a) }),
  })
  const db = {
    prepare: statement,
    batch: async (stmts: any[]) => Promise.all(stmts.map((s) => s.run())),
  } as any
  const store = d1Store(db)
  let privateRepo = false
  const index = {
    metaFile: async () => JSON.stringify({ private: privateRepo }),
    refs: async () => ({ defaultBranch: 'main', refs: [] }),
  }
  const handlers = service({
    store,
    index: async () => index,
    catalog: async () => [
      { owner: 'acme', name: 'demo', default_branch: 'main' },
    ],
  } as unknown as Services)
  const principal = {
    id: 'fixture',
    name: 'alice',
    publicKey: 'fixture',
    scopes: ['repo:read'] as const,
    repos: null,
  }
  const control = {
    rate: async () => ({
      limit: 10000,
      remaining: 9999,
      reset: 9999999999,
      allowed: true,
    }),
  } as Control
  const call = (path: string, method = 'GET', actor: string | null = 'alice') =>
    dispatch(
      new Request('http://local/api/v1' + path, {
        method,
        headers: { 'cf-connecting-ip': '127.0.0.1' },
      }),
      {
        ...handlers,
        authenticate: async () =>
          actor ? { ...principal, name: actor } : null,
        control: async () => control,
      },
    )
  const star = '/user/starred/acme/demo',
    repo = '/repos/acme/demo'
  for (const method of ['PUT', 'DELETE'])
    assert.equal((await call('/user/starred/acme/missing', method)).status, 404)
  assert.equal(await store.starCount('acme/missing'), 0)
  assert.equal(sql.prepare('SELECT count(*) AS n FROM stars WHERE repo=?').get('acme/missing')!.n, 0)
  assert.equal((await call(star, 'PUT')).status, 204)
  assert.equal((await call(star, 'PUT')).status, 204)
  assert.equal(
    await d1Store(db).starCount('acme/demo'),
    1,
    'a fresh store sees the D1 row',
  )
  assert.equal(await d1Store(db).starred('acme/demo', 'alice'), true)
  assert.equal((await (await call(repo)).json()).stargazers_count, 1)
  assert.deepEqual(
    (await (await call(repo + '/stargazers')).json()).map((u: any) => u.login),
    ['alice'],
  )
  assert.equal((await call(star, 'PUT', null)).status, 401)
  assert.equal((await call(star, 'DELETE', null)).status, 401)
  for (const path of ['/users/acme/repos', '/orgs/acme/repos']) {
    assert.equal((await (await call(path)).json())[0].stargazers_count, 1)
  }
  privateRepo = true
  for (const verb of ['PUT', 'DELETE'])
    assert.equal((await call(star, verb, 'outsider')).status, 404)
  assert.equal(
    (await call(repo + '/stargazers', 'GET', 'outsider')).status,
    404,
  )
  assert.equal(
    await store.starCount('acme/demo'),
    1,
    'outsider cannot alter private stars',
  )
  assert.equal((await call(star, 'PUT', 'acme')).status, 204)
  assert.equal(await store.starCount('acme/demo'), 2)
  privateRepo = false
  const saved = new Map<string, any>()
  const idem = {
    ...control,
    begin: async (key: string) =>
      saved.has(key)
        ? { kind: 'replay', response: saved.get(key) }
        : { kind: 'new', claim: 'claim' },
    activate: async () => true,
    finish: async (key: string, _claim: string, response: any) => {
      saved.set(key, response)
    },
    release: async () => {},
  } as Control
  const client = new GildClient(
    'http://local/api/v1',
    'fixture',
    async (input, init) =>
      dispatch(new Request(input, init), {
        ...handlers,
        authenticate: async () => principal,
        control: async () => idem,
      }),
  )
  assert.equal(
    await client.request(
      'star',
      { owner: 'acme', repo: 'demo' },
      {},
      {},
      { idempotencyKey: 'star-fixture' },
    ),
    null,
  )
  assert.equal(
    await client.request(
      'star',
      { owner: 'acme', repo: 'demo' },
      {},
      {},
      { idempotencyKey: 'star-fixture' },
    ),
    null,
  )
  assert.equal(
    saved.size,
    1,
    'no-content responses finish and replay idempotency',
  )
  assert.equal((await call(star, 'DELETE')).status, 204)
  assert.equal((await call(star, 'DELETE')).status, 204)
  assert.equal((await (await call(repo)).json()).stargazers_count, 1)
  await store.settings.putState(await store.settings.state('acme/demo'))
  await store.settings.rename('acme/demo', 'acme/renamed', false)
  const key = (await store.settings.state('acme/renamed')).id
  assert.equal(
    await store.starCount(key),
    1,
    'stars survive a repo rename via the stable id',
  )
  sql.close()
})

test('mixed-case repository stars preserve the canonical id through rename', async () => {
  const { memoryStore } = await import('../lib/drivers/memory')
  const store = memoryStore()
  const index = {
    metaFile: async () => null,
    refs: async () => ({ defaultBranch: 'main', refs: [] }),
  }
  const handlers = service({
    store,
    index: async () => index,
    catalog: async () => [{ owner: 'acme', name: 'MiXeD', default_branch: 'main' }, { owner: 'acme', name: 'Renamed', default_branch: 'main' }],
  } as unknown as Services)
  const control = {
    rate: async () => ({
      limit: 10000,
      remaining: 9999,
      reset: 9999999999,
      allowed: true,
    }),
  } as Control
  const call = (repo: string, method: string) =>
    dispatch(
      new Request(
        `http://local/api/v1${method === 'GET' ? '/repos/acme/' : '/user/starred/acme/'}${repo}`,
        { method },
      ),
      {
        ...handlers,
        authenticate: async () => ({
          id: 'fixture',
          name: 'alice',
          publicKey: 'fixture',
          scopes: ['repo:read'],
          repos: null,
        }),
        control: async () => control,
      },
    )
  assert.equal((await call('MiXeD', 'PUT')).status, 204)
  assert.equal(await store.starCount('acme/MiXeD'), 1)
  await store.settings.putState(await store.settings.state('acme/MiXeD'))
  await store.settings.rename('acme/MiXeD', 'acme/Renamed', false)
  assert.equal(
    (await (await call('Renamed', 'GET')).json()).stargazers_count,
    1,
  )
})
