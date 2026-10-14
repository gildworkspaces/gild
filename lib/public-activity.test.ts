import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publicActivityLoader } from './public-activity.ts'
import type { RepoRow } from './repo-list.ts'

/** An isolated kept-store per test (the real one is module-wide). */
const mem = () => {
  const saved = new Map<string, unknown>()
  return {
    recall: (async (key: string) => (saved.has(key) ? structuredClone(saved.get(key)) : null)) as never,
    store: async (key: string, value: unknown) => void saved.set(key, structuredClone(value)),
  }
}

test('production landing misses enqueue preparation without scanning, then read the published result', async () => {
  let scans = 0, queued = 0, now = 0
  const load = publicActivityLoader({
    ...mem(), prepare: async () => { queued++ },
    owners: async () => { scans++; return [] },
    repos: async () => [], commits: async () => [],
  }, () => now)
  assert.deepEqual(await load(), { repos: [], commits: [], pending: true })
  assert.equal(queued, 1)
  assert.equal(scans, 0, 'a cold page cannot scan the owner graph')
  assert.deepEqual(await load('immutable-publication'), { repos: [], commits: [] })
  assert.equal(scans, 1, 'only the producer computes the snapshot')
  assert.deepEqual(await load(), { repos: [], commits: [] })
  now = 60000
  assert.deepEqual(await load(), { repos: [], commits: [] })
  assert.equal(queued, 2, 'an expired snapshot queues a producer and keeps available data')
  assert.equal(scans, 1, 'expiry never runs the scan in the page request')
})

test('landing coalesces full scans for 60s; cached hits hydrate only six with live ACL/counts', async () => {
  let now = 0,
    ownersCalls = 0,
    fullScans = 0,
    selectedReads = 0,
    logCalls = 0
  let hidden = false,
    stars = 0
  const repos = Array.from(
    { length: 20 },
    (_, i) =>
      ({
        owner: 'owner' + i,
        name: 'demo',
        updated: i,
        stargazers_count: 0,
      }) as RepoRow,
  )
  const load = publicActivityLoader(
    {
      ...mem(),
      owners: async () => {
        ownersCalls++
        return repos
          .map((r) => ({ name: r.owner }))
          .concat({ name: 'smoketest-hidden' })
      },
      repos: async (owner, names) => {
        if (names) {
          selectedReads++
          assert.deepEqual(names, ['demo'])
        } else fullScans++
        return repos
          .filter((r) => r.owner === owner && !(hidden && owner === 'owner19'))
          .map((r) => ({ ...r, stargazers_count: stars }))
      },
      commits: async (rows) => {
        logCalls++
        assert.equal(rows.length, 4)
        return rows.map((r) => ({
          owner: r.owner,
          repo: r.name,
          hash: 'tip',
          message: 'commit',
          author: 'a',
          at: r.updated,
        }))
      },
    },
    () => now,
  )
  const results = await Promise.all([load(), load()])
  assert.equal(ownersCalls, 1)
  assert.equal(fullScans, 20)
  assert.equal(logCalls, 1)
  assert.equal(selectedReads, 12)
  assert.deepEqual(
    results[0].repos.map((r) => r.owner),
    ['owner19', 'owner18', 'owner17', 'owner16', 'owner15', 'owner14'],
  )
  stars = 3
  hidden = true
  now = 59999
  const warm = await load()
  assert.equal(fullScans, 20, 'cached hit does not walk every owner')
  assert.equal(selectedReads, 18, 'cached hit reads only six candidates')
  assert.equal(warm.repos.length, 5)
  assert.ok(warm.repos.every((r) => r.stargazers_count === 3))
  assert.ok(
    warm.commits.every((c) => c.owner !== 'owner19'),
    'private/deleted repo commits disappear immediately',
  )
  now = 60000
  assert.equal((await load()).repos.length, 6, 'expiry refills candidates')
  assert.equal(ownersCalls, 2)
  assert.equal(fullScans, 40)
  assert.equal(logCalls, 2)
})

test('failed landing scan is retried without caching failure', async () => {
  let calls = 0
  const load = publicActivityLoader({
    ...mem(),
    owners: async () => {
      if (++calls === 1) throw Error('unavailable')
      return []
    },
    repos: async () => [],
    commits: async () => [],
  })
  await assert.rejects(load(), /unavailable/)
  assert.deepEqual(await load(), { repos: [], commits: [] })
  assert.equal(calls, 2)
})

test('separate landing loaders share a persisted minute bucket and reauthorize its candidates', async () => {
  const values = new Map<string, unknown>()
  const keep = async <T>(key: string, compute: () => Promise<T>): Promise<T> => {
    if (values.has(key)) return structuredClone(values.get(key)) as T
    const value = await compute()
    values.set(key, structuredClone(value))
    return value
  }
  let now = 0, scans = 0, hidden = false
  const row = { owner: 'acme', name: 'demo', updated: 1 } as RepoRow
  const services = {
    ...mem(),
    keep,
    owners: async () => { scans++; return [{ name: 'acme' }] },
    repos: async (_owner: string, names?: readonly string[], candidates?: readonly RepoRow[]) => {
      if (names) assert.deepEqual(candidates, [row])
      return hidden ? [] : [row]
    },
    commits: async () => [{ owner: 'acme', repo: 'demo', hash: 'tip', message: 'commit', author: 'acme', at: 1 }],
  }
  assert.equal((await publicActivityLoader(services, () => now)()).repos.length, 1)
  const newIsolate = publicActivityLoader(services, () => now)
  hidden = true
  assert.deepEqual(await newIsolate(), { repos: [], commits: [] })
  assert.equal(scans, 1, 'second loader recalls candidates instead of rescanning owners')
  now = 60000
  await newIsolate()
  assert.equal(scans, 2, 'a new minute uses a new shared key')
})

test('landing never makes a visitor wait for a rescan once one scan exists', async () => {
  let now = 0, scans = 0, release: () => void = () => {}
  const saved = new Map<string, unknown>(), deferred: Promise<unknown>[] = []
  const row = { owner: 'o', name: 'demo', updated: 1, stargazers_count: 0 } as RepoRow
  const load = publicActivityLoader(
    {
      owners: async () => [{ name: 'o' }],
      repos: async (_owner, names) => {
        if (!names) {
          scans++
          // The second scan hangs until released: a visitor must not wait on it.
          if (scans > 1) await new Promise<void>((r) => (release = r))
        }
        return [row]
      },
      commits: async () => [],
      keep: (async (_key: string, compute: () => Promise<unknown>) => compute()) as never,
      recall: (async (key: string) => saved.get(key) ?? null) as never,
      store: async (key, value) => void saved.set(key, value),
      defer: (work) => void deferred.push(work),
    },
    () => now,
  )
  assert.equal((await load()).repos.length, 1, 'first scan ever is awaited')
  now = 61_000
  const served = await Promise.race([load(), new Promise((r) => setTimeout(() => r('waited'), 200))])
  assert.notEqual(served, 'waited', 'stale result is served while the rescan runs in the background')
  assert.equal(deferred.length, 1, 'the rescan is deferred past the response')
  release()
  await deferred[0]
  assert.equal(scans, 2)
})


test('publication candidates use immutable input instead of stale minute candidates',async()=>{
 const saved=new Map<string,unknown>()
 let scans=0,tip='old'
 const row={owner:'acme',name:'demo',updated:1} as RepoRow
 const load=publicActivityLoader({
  ...mem(),keep:(async(key:string,compute:()=>Promise<unknown>)=>{if(!saved.has(key))saved.set(key,await compute());return structuredClone(saved.get(key))}) as never,
  owners:async()=>{scans++;return [{name:'acme'}]},repos:async()=>[row],
  commits:async()=>[{owner:'acme',repo:'demo',hash:tip,message:tip,author:'acme',at:1}],
  defer:()=>{throw Error('Publication must await its scan')},
 },()=>0)
 await load()
 tip='new'
 assert.equal((await load('input-new')).commits[0].hash,'new','publication bypasses stale minute candidate commits')
 assert.equal((await load('input-new')).commits[0].hash,'new')
 assert.equal(scans,2,'same immutable publication input is computed once')
 tip='next'
 assert.equal((await load('input-next')).commits[0].hash,'next')
 assert.equal(scans,3)
})
