import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { ApiControlStore } from './api/control-store.ts'
import { dispatch } from './api/dispatch.ts'
import { service } from './api/service.ts'
import { memoryStore } from './drivers/memory.ts'
import { metadataOperationPath, takeMetadataOperation, metadataOperationSnapshot } from './metadata-operation.ts'

// The service/dispatcher/control are real. Git is represented by an atomic
// committed metadata snapshot here; a separate test exercises actual Git.
function fixture() {
  const db = new DatabaseSync(':memory:')
  const sql = { exec(q: string, ...args: never[]) {
    if (!args.length && q.includes(';')) { db.exec(q); return [] }
    const st = db.prepare(q)
    if (st.columns().length) return st.all(...args)
    st.run(...args); return []
  } }
  let control = new ApiControlStore(sql as never)
  const files = new Map<string, string>(), pulls = new Map<number, any>()
  let writes = 0, throwAfterCommit = true, visible = true
  const owner = { id: 'token', name: 'acme', publicKey: 'fixture', scopes: null, repos: null }
  const st = memoryStore()
  let refs = [{ name: 'main', hash: 'a'.repeat(40) }, { name: 'feature', hash: 'b'.repeat(40) }]
  const index = {
    refs: async () => ({ defaultBranch: 'main', refs }),
    commit: async (hash: string) => ({ hash }),
    metaFile: async (path: string) => visible ? files.get(path) ?? null : null,
    metaItem: async (n: number) => pulls.has(n) ? { item: pulls.get(n), comments: [], reviews: [], log: [] } : null,
  }
  const handlers = service({ store: st, index: async () => index, catalog: async () => [], writes: {
    pull: async (_o: string, _r: string, author: string, title: string, body: string, head: string, base: string) => {
      const operation = takeMetadataOperation(); assert.ok(operation)
      const n = ++writes
      pulls.set(n, { schema: 1, number: n, author, title, body, head, base, state: 'open', createdAt: '2026-10-11T20:00:00.000Z' })
      files.set(metadataOperationPath(operation), JSON.stringify({ result: n, ...await metadataOperationSnapshot(n, { readFile: async () => JSON.stringify(pulls.get(n)) } as any) }))
      if (throwAfterCommit) throw Error('accepted metadata push; later index/ACL operation failed')
      return n
    },
  } } as any)
  const deps = { ...handlers, authenticate: async () => owner, authorize: async () => {}, control: async () => control }
  const request = (title = 'one pull') => new Request('https://gild.test/api/v1/repos/acme/demo/pulls', { method: 'POST', headers: { 'idempotency-key': 'stable-pull' }, body: JSON.stringify({ title, body: 'body', head: 'feature', base: 'main' }) })
  return { db, deps, request, refs: (next: typeof refs) => { refs = next }, writes: () => writes, pulls, restart: () => { control = new ApiControlStore(sql as never) }, visible: (v: boolean) => { visible = v }, noFault: () => { throwAfterCommit = false } }
}

test('post-write exception reconciles the committed pull after control restart without another write', async () => {
  const f = fixture()
  try {
    assert.equal((await dispatch(f.request(), f.deps)).status, 500)
    assert.equal(f.writes(), 1)
    f.restart()
    f.visible(false)
    assert.equal((await dispatch(f.request(), f.deps)).status, 409, 'unprepared receipt stays unresolved')
    assert.equal(f.writes(), 1)
    f.visible(true)
    const reconciled = await dispatch(f.request(), f.deps)
    assert.equal(reconciled.status, 201, await reconciled.clone().text())
    assert.equal(reconciled.headers.get('idempotency-reconciled'), 'true')
    const data = await reconciled.json()
    assert.equal(data.number, 1); assert.equal(data.title, 'one pull'); assert.equal(data.created_at, '2026-10-11T20:00:00.000Z')
    assert.equal(f.writes(), 1, 'response recovery must not call the create handler')
    const replay = await dispatch(f.request(), f.deps)
    assert.equal(replay.headers.get('idempotency-replayed'), 'true')
    assert.deepEqual(await replay.json(), data)
    assert.equal((await dispatch(f.request('changed'), f.deps)).status, 409)
    assert.equal(f.writes(), 1)
  } finally { f.db.close() }
})

test('unknown outcome persists beyond 24 hours and cannot expire into another write', async t => {
  const f = fixture(); let now = Date.now(); t.mock.method(Date, 'now', () => now)
  try {
    assert.equal((await dispatch(f.request(), f.deps)).status, 500)
    f.visible(false); f.restart(); now += 86400001
    assert.equal((await dispatch(f.request(), f.deps)).status, 409, 'unknown operation must stay reserved after 24 hours')
    assert.equal(f.writes(), 1)
    f.visible(true)
    const recovered = await dispatch(f.request(), f.deps)
    assert.equal(recovered.status, 201)
    assert.equal((await dispatch(f.request(), f.deps)).headers.get('idempotency-replayed'), 'true')
    assert.equal(f.writes(), 1)
  } finally { t.mock.restoreAll(); f.db.close() }
})


test('expired completed response recovers its durable receipt before executing again', async t => {
  const f = fixture(); let now = Date.now(); t.mock.method(Date, 'now', () => now)
  try {
    f.noFault()
    const original = await dispatch(f.request(), f.deps)
    assert.equal(original.status, 201)
    const data = await original.json()
    f.restart(); now += 86400001
    const recovered = await dispatch(f.request(), f.deps)
    assert.equal(recovered.status, 201)
    assert.equal(recovered.headers.get('idempotency-reconciled'), 'true')
    const current = await recovered.json()
    assert.equal(current.number, data.number)
    assert.equal(current.title, data.title)
    assert.equal(current.created_at, f.pulls.get(1).createdAt, 'recovery uses the committed record')
    assert.equal(f.writes(), 1, 'expired response must recover before another create')
    assert.equal((await dispatch(f.request(), f.deps)).headers.get('idempotency-replayed'), 'true')
  } finally { t.mock.restoreAll(); f.db.close() }
})


for (const changed of ['deleted branch', 'advanced branches', 'edited pull']) {
  test(`receipt recovers immutable PR creation after ${changed}`, async () => {
    const f = fixture()
    try {
      assert.equal((await dispatch(f.request(), f.deps)).status, 500)
      if (changed === 'deleted branch') f.refs([{ name: 'main', hash: 'a'.repeat(40) }])
      if (changed === 'advanced branches') f.refs([{ name: 'main', hash: 'c'.repeat(40) }, { name: 'feature', hash: 'd'.repeat(40) }])
      if (changed === 'edited pull') Object.assign(f.pulls.get(1), { title: 'edited', body: 'changed body', state: 'closed', head: 'deleted', base: 'another' })
      const recovered = await dispatch(f.request(), f.deps)
      assert.equal(recovered.status, 201, 'immutable creation must survive ' + changed + ': ' + await recovered.clone().text())
      const data = await recovered.json()
      assert.equal(data.title, 'one pull'); assert.equal(data.body, 'body'); assert.equal(data.state, 'open')
      assert.equal(data.head.sha, 'b'.repeat(40), 'creation head must remain immutable')
      assert.equal(data.base.sha, 'a'.repeat(40), 'creation base must remain immutable')
      assert.equal(data.head.ref, 'feature'); assert.equal(data.base.ref, 'main')
      assert.equal(data.created_at, '2026-10-11T20:00:00.000Z')
      assert.equal(f.writes(), 1)
    } finally { f.db.close() }
  })
}
