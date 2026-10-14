import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { d1Store } from './drivers/d1.ts'
import { privacyHTTP } from './privacy-http.ts'
import { settingsHTTP } from './settings-http.ts'
import { d1OwnerReads, d1PageReads, pageStore } from './page-reads.ts'

/** Real migrations on SQLite behind a D1-shaped binding that counts round
 *  trips: every first/all/run outside a batch is one, a whole batch is one. */
function d1() {
  const db = new DatabaseSync(':memory:')
  for (const f of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + f, 'utf8'))
  let trips = 0, batching = false
  const prepare = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => prepare(q, a),
    async first() { if (!batching) trips++; return db.prepare(q).get(...(args as never[])) ?? null },
    async all() { if (!batching) trips++; return { results: db.prepare(q).all(...(args as never[])) } },
    async run() { if (!batching) trips++; return { success: true, meta: { changes: Number(db.prepare(q).run(...(args as never[])).changes) } } },
    stmt: () => ({ q, args }),
  })
  const binding = {
    prepare,
    async batch(items: ReturnType<typeof prepare>[]) {
      trips++
      batching = true
      try {
        return items.map((s) => { const { q, args } = s.stmt(); return { results: db.prepare(q).all(...(args as never[])) } })
      } finally { batching = false }
    },
  } as never
  return { binding, db, store: d1Store(binding), trips: () => trips, reset: () => { trips = 0 } }
}

const ACL: Record<string, object> = {
  'acme/public': { schema: 1 },
  'acme/secret': { schema: 1, visibility: 'private', read: ['@reader'] },
  'acme/pending': { schema: 1, visibility: 'private', read: ['@reader'] },
  'acme/gone': { schema: 1 },
}
const VIEWERS = [null, 'outsider', 'reader', 'member', 'admin', 'founder']
const REPOS = ['public', 'secret', 'pending', 'gone', 'missing', 'old']

async function fixture() {
  const f = d1(), st = f.store
  await st.createOrg('acme', null, 'founder')
  await st.addOrgMember('acme', 'member', 'member')
  await st.addOrgMember('acme', 'admin', 'admin')
  for (const name of VIEWERS.filter(Boolean)) f.db.prepare("INSERT INTO claims(name,public_key,email,email_verified,claimed_at) VALUES (?,?,?,0,'2026-10-10')").run(name, 'ed25519:' + name, name + '@example.test')
  for (const key of Object.keys(ACL)) {
    await st.settings.putState({ ...(await st.settings.state(key)), id: 'id-' + key })
    await st.publishRepoAccess('id-' + key, 'meta', ACL[key] as never)
  }
  await st.fenceRepoAccess('id-acme/pending', 'next')
  await st.settings.putState({ ...(await st.settings.state('acme/gone')), deletedAt: Date.now() })
  await st.star('id-acme/public', 'reader')
  f.db.prepare("INSERT INTO settings_aliases(name,target) VALUES ('acme/old','acme/public')").run()
  return f
}
const session = (name: string | null) => name ? { publicKey: 'ed25519:' + name } : null
const principal = (name: string | null) => name ? { id: '', name, publicKey: 'ed25519:' + name, scopes: null, repos: null } : null

test('one D1 round trip decides a repository page exactly as the live store does', async () => {
  const f = await fixture()
  const decide = (store: ReturnType<typeof d1Store>, viewer: string | null, repo: string) => privacyHTTP(new Request(`https://gild.test/acme/${repo}/issues`), {
    store, index: async () => null, viewer: async () => principal(viewer),
  }, async () => new Response('page')).then(async (r) => `${r.status} ${r.headers.get('location') ?? ''} ${await r.text()}`)
  for (const repo of REPOS) for (const viewer of VIEWERS) {
    const label = `acme/${repo} as ${viewer}`
    f.reset()
    const reads = await d1PageReads(f.binding, 'acme', repo, session(viewer))
    assert.equal(f.trips(), 1, label + ': one batch')
    assert.equal(reads.viewer?.name ?? null, viewer, label + ': the viewer comes from the claim')
    const live = await decide(f.store, viewer, repo)
    f.reset()
    const batched = await decide(pageStore(f.store, reads), viewer, repo)
    assert.equal(batched, live, label)
    if (repo !== 'old') assert.equal(f.trips(), 0, label + ': the decision reads nothing more')
  }
})

test('the batch carries the per-viewer page state: stars, starred and org role', async () => {
  const f = await fixture()
  const reads = await d1PageReads(f.binding, 'acme', 'public', session('reader'))
  assert.equal(reads.canonical.stars, 1)
  assert.equal(reads.canonical.starred, true)
  assert.equal((await d1PageReads(f.binding, 'acme', 'public', session('outsider'))).canonical.starred, false)
  assert.equal((await d1PageReads(f.binding, 'acme', 'public', session('admin'))).role, 'admin')
  assert.equal((await d1PageReads(f.binding, 'acme', 'public', null)).role, null)
  assert.deepEqual(await pageStore(f.store, reads).getOrg('acme'), await f.store.getOrg('acme'))
})

test('a cookie name never overrides the claim on the key; an unclaimed key keeps the cookie name', async () => {
  const f = await fixture()
  assert.equal((await d1PageReads(f.binding, 'acme', 'public', { publicKey: 'ed25519:reader', name: 'founder' })).viewer?.name, 'reader')
  assert.equal((await d1PageReads(f.binding, 'acme', 'public', { publicKey: 'ed25519:nobody', name: 'newcomer' })).viewer?.name, 'newcomer')
  assert.equal((await d1PageReads(f.binding, 'acme', 'public', { publicKey: 'ed25519:nobody' })).viewer, null)
})

test('an owner page resolves in one round trip with the same redirects and states', async () => {
  const f = await fixture()
  f.db.prepare("INSERT INTO settings_aliases(name,target) VALUES ('oldacme','acme')").run()
  for (const owner of ['acme', 'ACME', 'nobody', 'oldacme']) for (const viewer of VIEWERS) {
    f.reset()
    const reads = await d1OwnerReads(f.binding, owner, session(viewer))
    assert.equal(f.trips(), 1, owner)
    const run = (store: ReturnType<typeof d1Store>) => settingsHTTP(new Request(`https://gild.test/${owner}`), store, async () => new Response('page'))
      .then(async (r) => `${r.status} ${r.headers.get('location') ?? ''} ${await r.text()}`)
    assert.equal(await run(pageStore(f.store, reads)), await run(f.store), `${owner} as ${viewer}`)
    assert.deepEqual(await pageStore(f.store, reads).getOrg(owner), await f.store.getOrg(owner), owner)
  }
})

test('an owner listing reads states, snapshots, stars and scores in one round trip, as the separate reads do', async () => {
  const f = await fixture()
  for (const key of Object.keys(ACL)) f.db.prepare('INSERT INTO repo_listing(id,revision,data) VALUES (?,1,?)').run('id-' + key, JSON.stringify({ meta: 'meta', tip: 'tip-' + key, acl: {} }))
  f.db.prepare("INSERT INTO repo_listing(id,revision,data) VALUES ('acme/legacy',1,?)").run(JSON.stringify({ meta: null, tip: 'tip-legacy', acl: {} }))
  f.db.prepare("INSERT INTO cqx_scores(key,report) VALUES ('acme/public@tip-acme/public#B','{\"lines\":1}'),('acme/secret@old-tip#B','{}')").run()
  const names = ['public', 'secret', 'pending', 'gone', 'missing', 'old', 'legacy']
  f.reset()
  const batch = await f.store.listedListings!('acme', names, '#B')
  assert.equal(f.trips(), 1)
  const states = await f.store.settings.listed('acme', names)
  assert.deepEqual(batch.states, states)
  const ids = states.map((s) => s.id)
  // The batch may read a superset (names the listing then drops); every listed id agrees.
  const only = <T,>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).filter(([id]) => ids.includes(id)))
  assert.deepEqual(only(batch.listings), await f.store.getListings(ids))
  assert.deepEqual(only(batch.stars), Object.fromEntries(Object.entries(await f.store.starCounts(ids)).filter(([, n]) => n)))
  assert.deepEqual(batch.scores, await f.store.getScores(states.map((s) => `${s.key}@${(batch.listings[s.id] as { tip?: string } | undefined)?.tip}#B`)))
})
