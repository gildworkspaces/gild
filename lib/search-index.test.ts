import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { D1Database } from '@cloudflare/workers-types'
import { readdirSync } from 'node:fs'
import { syncSearch, searchCode, cleanSearch, removeSearch, readablePrivate, searchCurrent, SYNC_BUDGET, REPLACED_RETENTION_MS, type SearchSync } from './search-index.ts'

function database(dir = 'migrations-search') {
  const db = new DatabaseSync(':memory:')
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(`${dir}/${f}`, 'utf8'))
  const statement = (sql: string, values: unknown[] = []) => ({
    sql, values,
    bind: (...args: unknown[]) => statement(sql, args),
    async all() { return { results: db.prepare(sql).all(...(values as never[])), success: true, meta: {} } },
    async first() { return db.prepare(sql).get(...(values as never[])) ?? null },
    async run() { return { results: [], success: true, meta: { changes: Number(db.prepare(sql).run(...(values as never[])).changes) } } },
  })
  const d1 = {
    prepare: (sql: string) => statement(sql),
    async batch(list: ReturnType<typeof statement>[]) {
      db.exec('BEGIN')
      try {
        const out = list.map(s => /^\s*(SELECT|WITH)/i.test(s.sql)
          ? { results: db.prepare(s.sql).all(...(s.values as never[])), success: true, meta: {} }
          : { results: [], success: true, meta: { changes: Number(db.prepare(s.sql).run(...(s.values as never[])).changes) } })
        db.exec('COMMIT'); return out
      } catch (e) { db.exec('ROLLBACK'); throw e }
    },
  } as unknown as D1Database
  return { db, d1 }
}

const blob = (n: number) => n.toString(16).padStart(40, '0')
function repo(files: Record<string, string>, over: Partial<SearchSync> = {}): SearchSync {
  const byBlob = new Map<string, string>(), list: { path: string; blob: string }[] = []
  for (const [path, content] of Object.entries(files)) {
    const sha = createHash('sha1').update(content).digest('hex')
    byBlob.set(sha, content)
    list.push({ path, blob: sha })
  }
  return {
    repoId: 'repo-1', repository: 'acme/demo', ownerKind: 'user', branch: 'main', tip: 'a'.repeat(40),
    acl: { schema: 1, visibility: 'public' } as never, accessMeta: 'm1', pending: false, files: list,
    text: b => { const c = byBlob.get(b); return c === undefined ? null : { content: c, language: 'TypeScript', size: c.length, symbols: [] } },
    ...over,
  }
}
const everyone = { mayRead: async () => true }
const paths = async (d1: D1Database, q: string, readable: string[] = [], mayRead = everyone.mayRead) =>
  (await searchCode(d1, { q, readable, mayRead })).hits.map(h => `${h.repo}:${h.path}`)

test('a push indexes the tree; search is one query over every readable repository', async () => {
  const { d1 } = database()
  assert.deepEqual(await syncSearch(d1, repo({ 'src/app.ts': 'export const greeting = "hello world"', 'README.md': '# demo' })), { done: true, changed: 2 })
  await syncSearch(d1, repo({ 'lib.ts': 'hello from another repo' }, { repoId: 'repo-2', repository: 'acme/other' }))
  assert.deepEqual(await paths(d1, 'hello'), ['acme/demo:src/app.ts', 'acme/other:lib.ts'])
  assert.deepEqual(await paths(d1, 'path:readme'), ['acme/demo:README.md'])
})

test('a changed file marks the old version replaced with a timestamp; search sees only the new one', async () => {
  const { d1, db } = database()
  await syncSearch(d1, repo({ 'app.ts': 'old needle' }), 1000)
  await syncSearch(d1, repo({ 'app.ts': 'new haystack' }, { tip: 'b'.repeat(40) }), 2000)
  const rows = db.prepare('SELECT commit_sha, replaced_at, replaced_by FROM search_files ORDER BY indexed_at').all()
  assert.deepEqual(rows.map(r => ({ ...r })), [
    { commit_sha: 'a'.repeat(40), replaced_at: 2000, replaced_by: 'b'.repeat(40) },
    { commit_sha: 'b'.repeat(40), replaced_at: null, replaced_by: null },
  ])
  assert.deepEqual(await paths(d1, 'needle'), [])
  assert.deepEqual(await paths(d1, 'haystack'), ['acme/demo:app.ts'])
})

test('a deleted file is replaced; the daily cleanup removes versions replaced over a day ago and unused text', async () => {
  const { d1, db } = database()
  await syncSearch(d1, repo({ 'gone.ts': 'remove me', 'kept.ts': 'stay here' }), 1000)
  await syncSearch(d1, repo({ 'kept.ts': 'stay here' }, { tip: 'b'.repeat(40) }), 2000)
  assert.deepEqual(await paths(d1, 'remove'), [])
  assert.deepEqual(await cleanSearch(d1, 2000 + REPLACED_RETENTION_MS - 1), { files: 0, blobs: 0 }, 'kept for a day')
  assert.deepEqual(await cleanSearch(d1, 2000 + REPLACED_RETENTION_MS + 1), { files: 1, blobs: 1 })
  assert.equal(db.prepare('SELECT count(*) n FROM search_text WHERE search_text MATCH ?').get('"remove"')!.n, 0, 'trigram index follows')
  assert.deepEqual(await paths(d1, 'stay'), ['acme/demo:kept.ts'])
})

test('git is the record: rows that drift from the tree are repaired by the next sync', async () => {
  const { d1, db } = database()
  const tree = repo({ 'a.ts': 'alpha text', 'b.ts': 'beta text' })
  await syncSearch(d1, tree)
  db.exec("DELETE FROM search_files WHERE path='a.ts'")
  db.prepare("INSERT INTO search_files(repo_id,repository,path,blob_sha,commit_sha,visibility,size,indexed_at) VALUES ('repo-1','acme/demo','ghost.ts',?,?, 'public',1,1)").run(blob(1), 'c'.repeat(40))
  assert.deepEqual(await syncSearch(d1, tree), { done: true, changed: 2 })
  assert.deepEqual(db.prepare('SELECT path FROM search_files WHERE replaced_at IS NULL ORDER BY path').all().map(r => r.path), ['a.ts', 'b.ts'])
  assert.deepEqual(await syncSearch(d1, tree), { done: true, changed: 0 }, 'in sync: nothing to write')
})

test('a private repository: only its readers find it, by the live policy, and the access rule is checked again', async () => {
  const { d1 } = database(), main = database('migrations')
  main.db.exec(`INSERT INTO settings_entities(key,id) VALUES ('acme/demo','repo-1'),('org/team','repo-2');
    INSERT INTO repo_access(id,meta,acl,pending) VALUES
      ('repo-1','m1','{"schema":1,"visibility":"private","read":["@reader"],"agents":{"@acme/bot":["pr"],"@acme/idle":[]}}',0),
      ('repo-2','m1','{"schema":1,"visibility":"private"}',0);
    INSERT INTO orgs(name,created_by,created_at) VALUES ('org','x','2026-01-01');
    INSERT INTO org_members(org,member,role,added_at) VALUES ('org','member','member','2026-01-01')`)
  const acl = { schema: 1, visibility: 'private' } as never
  await syncSearch(d1, repo({ 'secret.ts': 'private needle' }, { acl }))
  await syncSearch(d1, repo({ 'team.ts': 'team needle' }, { repoId: 'repo-2', repository: 'org/team', ownerKind: 'org', acl }))
  const find = async (viewer: string | null) => paths(d1, 'needle', await readablePrivate(main.d1, viewer))
  assert.deepEqual(await find(null), [], 'anonymous')
  assert.deepEqual(await find('outsider'), [], 'outsider')
  assert.deepEqual(await find('acme/idle'), [], 'an agent without grants')
  for (const v of ['acme', 'reader', 'acme/bot']) assert.deepEqual(await find(v), ['acme/demo:secret.ts'], v)
  assert.deepEqual(await find('member'), ['org/team:team.ts'], 'org member')
  // A grant and a revocation apply to the next search, with no sync between.
  main.db.exec(`UPDATE repo_access SET acl='{"schema":1,"visibility":"private","read":["@outsider"]}' WHERE id='repo-1'`)
  assert.deepEqual(await find('outsider'), ['acme/demo:secret.ts'], 'granted')
  assert.deepEqual(await find('reader'), [], 'revoked')
  assert.deepEqual(await paths(d1, 'needle', ['repo-1'], async () => false), [], 'the live access rule has the last word')
})

test('making a repository private hides it in the same sync, before any file is written', async () => {
  const { d1 } = database()
  await syncSearch(d1, repo({ 'x.ts': 'flip needle' }))
  assert.deepEqual(await paths(d1, 'needle'), ['acme/demo:x.ts'])
  await syncSearch(d1, repo({ 'x.ts': 'flip needle' }, { acl: { schema: 1, visibility: 'private' } as never, accessMeta: 'm2' }))
  assert.deepEqual(await paths(d1, 'needle'), [])
  assert.deepEqual(await paths(d1, 'needle', ['repo-1']), ['acme/demo:x.ts'])
})

test('a large first push is indexed across runs, and searchable only once complete', async () => {
  const { d1 } = database()
  const files = Object.fromEntries(Array.from({ length: SYNC_BUDGET + 30 }, (_, i) => [`f${i}.ts`, `needle number ${i}`]))
  assert.deepEqual(await syncSearch(d1, repo(files)), { done: false, changed: SYNC_BUDGET })
  assert.deepEqual(await paths(d1, 'needle'), [], 'no head yet')
  assert.deepEqual(await syncSearch(d1, repo(files)), { done: true, changed: 30 })
  assert.equal((await searchCode(d1, { q: 'needle', readable: [], limit: 100, ...everyone })).count, SYNC_BUDGET + 30)
})

test('a deleted repository leaves search', async () => {
  const { d1 } = database()
  await syncSearch(d1, repo({ 'x.ts': 'bye needle' }))
  await removeSearch(d1, 'repo-1')
  assert.deepEqual(await paths(d1, 'needle'), [])
})

test('a cached public answer waits until search rows match every published tip', async () => {
  const { d1 } = database()
  await syncSearch(d1, repo({ 'x.ts': 'tip needle' }))
  const at = (tip: string) => [{ repository: 'acme/demo', ref: 'main', tip }, { repository: 'acme/demo', ref: 'v1', tip: 'f'.repeat(40) }]
  assert.equal(await searchCurrent(d1, at('a'.repeat(40))), true)
  assert.equal(await searchCurrent(d1, at('b'.repeat(40))), false, 'pushed since the last sync')
  assert.equal(await searchCurrent(d1, [{ repository: 'acme/new', ref: 'main', tip: 'a'.repeat(40) }]), false, 'never synced')
})
