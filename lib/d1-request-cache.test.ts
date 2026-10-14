import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import type { D1Database } from '@cloudflare/workers-types'
import { d1Store } from './drivers/d1.ts'
import { repoAccess, mayRead } from './repo-read.ts'
import { RequestReads } from './d1-request-cache.ts'
import { hashToken } from './token-verifier.ts'

/** Migrated SQLite behind the D1 surface, counting every round trip. */
function database() {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'))
  const trips: string[] = []
  const statement = (sql: string, values: unknown[] = []) => ({
    sql, values,
    bind: (...args: unknown[]) => statement(sql, args),
    async first() { trips.push(sql); return db.prepare(sql).get(...(values as never[])) ?? null },
    async all() { trips.push(sql); return { results: db.prepare(sql).all(...(values as never[])), success: true, meta: {} } },
    async run() { trips.push(sql); return { meta: { changes: Number(db.prepare(sql).run(...(values as never[])).changes) } } },
  })
  const d1 = {
    prepare: (sql: string) => statement(sql),
    async batch(list: ReturnType<typeof statement>[]) {
      trips.push(`batch ×${list.length}`)
      return list.map(s => /^\s*(SELECT|WITH)/i.test(s.sql)
        ? { results: db.prepare(s.sql).all(...(s.values as never[])), success: true, meta: {} }
        : { results: [], success: true, meta: { changes: Number(db.prepare(s.sql).run(...(s.values as never[])).changes) } })
    },
  } as unknown as D1Database
  return { db, d1, trips }
}

async function seeded() {
  const f = database(), token = 'gf_' + 'a'.repeat(32), hash = await hashToken(token)
  f.db.exec(`INSERT INTO settings_entities(key,id) VALUES ('acme','user:acme'),('acme/demo','repo-1');
    INSERT INTO repo_access(id,meta,acl,pending) VALUES ('repo-1','m1','{"schema":1,"visibility":"private","read":["@reader"]}',0)`)
  f.db.prepare('INSERT INTO api_tokens(token_hash,name,public_key,created_at,expires_at) VALUES (?,?,?,?,?)').run(hash, 'reader', 'ed25519:x', 1_000, Date.now() + 3_600_000 - (Date.now() % 1_000_000))
  return { ...f, hash }
}

/** What the privacy layer and the API both do for one repository request. */
async function request(db: D1Database, hash: string) {
  const store = d1Store(db), s = { store, index: async () => null }
  const out = []
  for (let layer = 0; layer < 2; layer++) {
    out.push(await store.settings.canonical('acme'), await store.settings.canonical('acme/demo'))
    out.push(await repoAccess(s as never, 'acme', 'demo'))
    out.push(await mayRead(s as never, 'acme', 'demo', 'reader'))
    out.push(await store.getApiToken(hash))
  }
  return out
}

test('a repository request reads D1 once: the primer answers the privacy layer and the API', async () => {
  const plain = await seeded(), expected = await request(plain.d1, plain.hash)
  assert.ok(plain.trips.length >= 18, `unprimed request makes ${plain.trips.length} round trips`)

  const primed = await seeded(), reads = new RequestReads(primed.d1)
  reads.primeRepository('acme', 'demo', Promise.resolve(primed.hash))
  const actual = await request(reads.db, primed.hash)
  assert.deepEqual(actual, expected, 'the same answers')
  assert.deepEqual(primed.trips, ['batch ×10'], 'one round trip')
})

test('identical reads are answered once per request; a write clears them', async () => {
  const f = await seeded(), reads = new RequestReads(f.d1), store = d1Store(reads.db)
  await store.settings.state('acme/demo'); await store.settings.state('acme/demo')
  assert.equal(f.trips.length, 1)
  await store.settings.putState({ ...(await store.settings.state('acme/demo')), description: 'changed' })
  assert.equal((await store.settings.state('acme/demo')).description, 'changed')
  assert.equal(f.trips.length, 3, 'read, write, and a fresh read after the write')
})

test('a renamed repository is left to the store: the primer never answers for the old name', async () => {
  const f = await seeded()
  f.db.exec(`INSERT INTO settings_aliases(name,target) VALUES ('acme/old','acme/demo')`)
  const reads = new RequestReads(f.d1)
  reads.primeRepository('acme', 'old', Promise.resolve(null))
  const store = d1Store(reads.db)
  assert.equal(await store.settings.canonical('acme/old'), 'acme/demo')
  const access = await repoAccess({ store, index: async () => null } as never, 'acme', 'old')
  assert.equal(access, null, 'no entity under the old key, as without the primer')
})

test('an expired token is refused although its row is read without a time bound', async () => {
  const f = await seeded()
  f.db.prepare('UPDATE api_tokens SET expires_at=?').run(Date.now() - 1)
  assert.equal(await d1Store(f.d1).getApiToken(f.hash), null)
})
