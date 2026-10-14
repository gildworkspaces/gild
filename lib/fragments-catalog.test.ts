import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import type { D1Database } from '@cloudflare/workers-types'
import { publishHeads } from './fragments/catalog.ts'
import type { PagePointer, TipManifest } from './fragments/types.ts'

function database() {
  const db = new DatabaseSync(':memory:')
  for (const f of readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + f, 'utf8'))
  let writes = 0
  const statement = (sql: string, values: unknown[] = []) => ({
    sql, values, bind: (...args: unknown[]) => statement(sql, args),
    async all() { return { results: db.prepare(sql).all(...(values as never[])) } },
  })
  const d1 = {
    prepare: (sql: string) => statement(sql),
    async batch(list: ReturnType<typeof statement>[]) {
      return list.map(s => { if (!/^\s*SELECT/i.test(s.sql)) { writes++; db.prepare(s.sql).run(...(s.values as never[])) } return { results: [] } })
    },
  } as unknown as D1Database
  return { db, d1, writes: () => writes }
}
const f = (kind: string, hash: string) => ({ kind, hash }) as never
const head = (tip: string) => ({
  pointer: { version: 'v1', entity: 'e', repository: 'acme/demo', scope: '', tip, meta: null, ref: 'main', path: '',
    home: f('home', 'h' + tip), selected: null, manifest: f('manifest', 'm' + tip), bundle: null, shell: f('shell', 's') } as PagePointer,
  manifest: { tree: 't' + tip, files: [{ path: 'a.ts', fragment: f('file', 'a' + tip) }], trees: [], bundle: null } as unknown as TipManifest,
})

test('republishing an unchanged repository writes nothing; a push still rewrites its graph', async () => {
  const { db, d1, writes } = database()
  const first = await publishHeads(d1, 'repo-1', [head('1')], 1)
  const n = writes()
  assert.ok(n > 0)
  const reachable = db.prepare("SELECT count(*) n FROM fragment_reachable WHERE id='repo-1'").get()!.n
  assert.equal(await publishHeads(d1, 'repo-1', [head('1')], 2, undefined, first), first)
  assert.equal(writes(), n, 'unchanged: no D1 writes')
  const second = await publishHeads(d1, 'repo-1', [head('2')], 3, undefined, first)
  assert.notEqual(second, first)
  assert.ok(writes() > n, 'a new tip is published')
  assert.equal(db.prepare("SELECT count(*) n FROM fragment_reachable WHERE id='repo-1' AND fragment LIKE '%/a2'").get()!.n, 1)
  assert.equal(reachable > 0, true)
})
