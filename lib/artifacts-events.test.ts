import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import type { D1Database } from '@cloudflare/workers-types'
import { handleArtifactsEvents, ownerOf, type ArtifactsEvent } from './artifacts-events.ts'

function database() {
  const db = new DatabaseSync(':memory:')
  for (const f of readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + f, 'utf8'))
  const statement = (sql: string, values: unknown[] = []) => ({
    sql, values, bind: (...args: unknown[]) => statement(sql, args),
    async first() { return db.prepare(sql).get(...(values as never[])) ?? null },
    async all() { return { results: db.prepare(sql).all(...(values as never[])) } },
    async run() { return { meta: { changes: Number(db.prepare(sql).run(...(values as never[])).changes) } } },
  })
  const d1 = {
    prepare: (sql: string) => statement(sql),
    async batch(list: ReturnType<typeof statement>[]) { return list.map(s => ({ meta: { changes: Number(db.prepare(s.sql).run(...(s.values as never[])).changes) } })) },
  } as unknown as D1Database
  return { db, d1 }
}
const event = (type: string, namespace: string, repoName: string, payload = {}): ArtifactsEvent =>
  ({ type: `cf.artifacts.repo.${type}`, source: { type: 'artifacts.repo', namespace, repoName }, payload })

/** Subscriptions API stand-in: records each call. */
function api() {
  const calls: { method: string; url: string; body?: { source?: { repo_name?: string } } }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return Response.json({ success: true, result: { id: 'sub-' + calls.length } })
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('a push re-indexes its repository once per batch; every operation is counted', async () => {
  const { db, d1 } = database(), refreshed: string[] = []
  const env = { DB: d1, EVENTS_TOKEN: 't', ARTIFACTS_EVENTS_QUEUE_ID: 'q' }
  const effects = { refresh: async (o: string, r: string) => { refreshed.push(`${o}/${r}`) }, catalogue: async () => {} }
  const now = Date.UTC(2026, 9, 13)
  const result = await handleArtifactsEvents([
    event('pushed', 'u-acme', 'demo'), event('pushed', 'u-acme', 'demo'), event('cloned', 'u-acme', 'demo'),
    event('fetched', 'o-team', 'site'), event('pushed', 'someone-else', 'x'),
  ], env, effects, now)
  assert.deepEqual(refreshed, ['acme/demo'], 'two pushes, one refresh; other namespaces ignored')
  assert.equal(result.counted, 4)
  // What each operation costs is the hosted service's metering (lib/hosted/types.ts); self-hosted counts nothing.
})

test('a created repository is subscribed, indexed and catalogued; a deleted one is unsubscribed', async () => {
  const { db, d1 } = database(), refreshed: string[] = [], catalogued: string[] = [], a = api()
  try {
    const env = { DB: d1, EVENTS_TOKEN: 't', ARTIFACTS_EVENTS_QUEUE_ID: 'q' }
    const effects = { refresh: async (o: string, r: string) => { refreshed.push(`${o}/${r}`) }, catalogue: async (o: string) => { catalogued.push(o) } }
    await handleArtifactsEvents([event('created', 'u-acme', 'new'), event('created', 'u-acme', 'new')], env, effects)
    assert.equal(a.calls.filter(c => c.method === 'POST').length, 1, 'one subscription per repository')
    assert.equal(a.calls[0].body?.source?.repo_name, 'new')
    assert.deepEqual(refreshed, ['acme/new'])
    assert.deepEqual(catalogued, ['acme'])
    await handleArtifactsEvents([event('deleted', 'u-acme', 'new')], env, effects)
    assert.equal(a.calls.at(-1)?.method, 'DELETE')
    assert.equal(db.prepare('SELECT count(*) n FROM artifacts_subscriptions').get()!.n, 0)
  } finally { a.restore() }
})

test('only gild namespaces map to owners', () => {
  assert.equal(ownerOf('u-acme'), 'acme')
  assert.equal(ownerOf('o-team-1'), 'team-1')
  assert.equal(ownerOf('acme'), null)
  assert.equal(ownerOf('x-acme'), null)
})
