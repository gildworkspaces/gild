import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { d1Store, d1RepoReads } from './drivers/d1.ts'
import { mayRead } from './repo-read.ts'
import { repoState } from './repo-state.ts'
import { repoContext, storeReads, type RepoContextDeps } from './repo-context.ts'
import type { ForgeStore } from './backend.ts'

// The layout's D1 budget: one batch. Only an aliased (renamed) address may
// fall through to the live canonical/state/star reads.
const LAYOUT_D1_ROUND_TRIPS = 1

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
        const out = []
        for (const s of items) {
          const { q, args } = s.stmt()
          out.push(/^\s*(SELECT|WITH)/i.test(q) ? { results: db.prepare(q).all(...(args as never[])) } : { results: [], meta: { changes: Number(db.prepare(q).run(...(args as never[])).changes) } })
        }
        return out
      } finally { batching = false }
    },
  } as never
  return { binding, store: d1Store(binding), trips: () => trips, reset: () => { trips = 0 } }
}

const ACL = {
  'acme/public': { schema: 1 },
  'acme/secret': { schema: 1, visibility: 'private', read: ['@reader'] },
  'acme/pending': { schema: 1, visibility: 'private', read: ['@reader'] },
  'acme/gone': { schema: 1 },
  'acme/unpublished': { schema: 1, visibility: 'private' },
} as Record<string, object>

async function fixture() {
  const f = d1(), st = f.store
  await st.createOrg('acme', null, 'founder')
  await st.addOrgMember('acme', 'member', 'member')
  await st.addOrgMember('acme', 'admin', 'admin')
  for (const key of Object.keys(ACL)) {
    await st.settings.putState({ ...(await st.settings.state(key)), id: 'id-' + key })
    if (key !== 'acme/unpublished') await st.publishRepoAccess('id-' + key, 'meta', ACL[key] as never)
  }
  await st.fenceRepoAccess('id-acme/pending', 'next')
  await st.settings.putState({ ...(await st.settings.state('acme/gone')), deletedAt: Date.now() })
  await st.star('id-acme/public', 'reader')
  await st.star('id-acme/public', 'outsider')
  await st.star('id-acme/secret', 'reader')
  // A renamed repository: its old address is an alias.
  await (f.binding as unknown as { prepare(q: string): { run(): Promise<unknown> } }).prepare("INSERT INTO settings_aliases(name,target) VALUES ('acme/old','acme/public')").run()
  const index = async (owner: string, repo: string) => {
    const acl = ACL[`${owner.toLowerCase()}/${repo}`]
    return acl ? { metaFile: async (p: string) => (p === '.gild/acl.json' ? JSON.stringify(acl) : null) } : null
  }
  const deps = (viewer: string | null): RepoContextDeps => ({
    store: st,
    reads: (o, r, v) => d1RepoReads(f.binding, o, r, v),
    viewer: async () => (viewer ? { name: viewer } : null),
    info: async (_o, r) => ({ id: r, name: r }) as never,
    index,
    readIndex: async () => ({ schema: 1, issues: [], pulls: [], queue: [] }),
    // The production rule, minus its default store() lookup.
    mayWrite: async (owner, name, s) => !!name && !name.includes('/') && (name.toLowerCase() === owner.toLowerCase() || ['owner', 'admin'].includes((await s.orgRole(owner.toLowerCase(), name.toLowerCase())) ?? '')),
  })
  return { f, st, index, deps }
}

const VIEWERS = [null, 'outsider', 'reader', 'member', 'admin', 'founder', 'acme/agent']
const REPOS = ['public', 'secret', 'pending', 'gone', 'unpublished', 'missing', 'old']

test('the repository layout reads D1 in at most one round trip, with the same policy answers', async () => {
  const { f, st, index, deps } = await fixture()
  for (const repo of REPOS) for (const viewer of VIEWERS) {
    const label = `acme/${repo} as ${viewer}`
    const readable = await mayRead({ store: st, index }, 'acme', repo, viewer)
    f.reset()
    const ctx = await repoContext(deps(viewer), 'acme', repo)
    const trips = f.trips()
    assert.equal(ctx !== null, readable, label + ': 404 decision matches mayRead on the live store')
    if (repo !== 'old') assert.ok(trips <= LAYOUT_D1_ROUND_TRIPS, `${label}: ${trips} D1 round trips`)
    if (!ctx) continue
    const state = await repoState(st, 'acme', repo)
    assert.deepEqual(ctx.state, state, label)
    assert.equal(ctx.stars, await st.starCount(state.id), label)
    assert.equal(ctx.starred, viewer ? await st.starred(state.id, viewer) : false, label)
    assert.equal(ctx.write, await deps(viewer).mayWrite('acme', viewer, st), label)
  }
})

test('a renamed address resolves through its alias to the canonical stars', async () => {
  const { deps } = await fixture()
  // The Worker redirects old addresses first; the layout still must not
  // show the alias's (absent) stars if it is reached.
  const d = deps('reader')
  const ctx = await repoContext({ ...d, index: async (o, r) => (await d.index(o, r)) ?? { metaFile: async () => '{"schema":1}' } }, 'acme', 'old')
  assert.equal(ctx?.state.id, 'id-acme/public')
  assert.equal(ctx?.stars, 2)
  assert.equal(ctx?.starred, true)
})

test('the batch returns exactly what the store methods return', async () => {
  const { f, st } = await fixture()
  for (const repo of REPOS.filter((r) => r !== 'old')) for (const viewer of VIEWERS) {
    for (const owner of ['acme', 'ACME']) {
      assert.deepEqual(await d1RepoReads(f.binding, owner, repo, viewer), await storeReads(st as ForgeStore, owner, repo, viewer), `${owner}/${repo} as ${viewer}`)
    }
  }
})

test('nothing is read from the index or metadata before a private repo is refused', async () => {
  const { deps } = await fixture()
  const read: string[] = []
  const d = deps('outsider')
  const ctx = await repoContext({
    ...d,
    index: async (o, r) => { const i = await d.index(o, r); return i && { metaFile: async (p: string) => { read.push(p); return i.metaFile(p) } } },
    readIndex: async () => { read.push('.gild/index.json'); return { schema: 1, issues: [], pulls: [], queue: [] } },
  }, 'acme', 'secret')
  assert.equal(ctx, null)
  assert.deepEqual(read, [])
})
