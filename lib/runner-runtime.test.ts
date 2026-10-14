import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'
import { dispatch } from './api/dispatch.ts'
import { PoolStore, REGISTRATION_TTL } from './actions/pool-store.ts'
mkdirSync('.tmp', { recursive: true })
await build({
  stdin: { contents: "export {RunnerPool} from './lib/actions/pool-do'; export {RunQueue} from './lib/actions/queue-do'; export {runnerHandler} from './lib/api/runners'", resolveDir: process.cwd() },
  outfile: '.tmp/runner-runtime-test.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external',
  plugins: [{ name: 'workerd-host', setup(b) {
    b.onResolve({ filter: /^next\/headers$/ }, () => ({ path: 'headers', namespace: 'next-host' }))
    b.onLoad({ filter: /.*/, namespace: 'next-host' }, () => ({ contents: 'export const cookies=()=>{throw Error("Unexpected Next request access in runner fixture")};export const headers=cookies', loader: 'js' }))
    b.onResolve({ filter: /^cloudflare:workers$/ }, a => ({ path: a.path, namespace: 'host' }))
    b.onLoad({ filter: /.*/, namespace: 'host' }, () => ({ contents: 'export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}', loader: 'js' }))
    // Only host integrations are replaced. DO, schemas, SQLite and API handler are production.
    b.onResolve({ filter: /^\.\.\/artifacts$/ }, () => ({ path: 'artifacts', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const readToken=()=>{throw Error("Unused read connection in runner fixture")};export const nsFor = (o,k)=>o; export async function repoInfo(){throw Error('Unused request-only repository lookup in runner fixture')} export async function rawRepo(ns,repo) { if (repo==='missing') throw Object.assign(Error('Repository not found'),{status:404}); return {name:repo} }`, loader: 'js' }))
  } }],
})
const { RunnerPool, RunQueue, runnerHandler } = await import('../.tmp/runner-runtime-test.mjs')
function fixture() {
  const db = new DatabaseSync(':memory:')
  const sql = { exec(q: string, ...args: any[]) {
    if (!args.length && q.includes(';')) { db.exec(q); return [] }
    const st = db.prepare(q)
    if (st.columns().length) return st.all(...args)
    st.run(...args); return []
  } }
  const state: any = { storage: { sql, transactionSync(fn: () => any) {
    db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result } catch (e) { db.exec('ROLLBACK'); throw e }
  }, getAlarm: async () => null, setAlarm: async () => {} }, waitUntil: () => {} }
  const env: any = { ARTIFACTS_TOKEN: 'local-fixture-only', DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } }
  const pool = new RunnerPool(state, env), queue = new RunQueue(state, env)
  pool.pool.owner('acme'); queue.runs.setting('owner', 'acme'); queue.runs.setting('repo', 'one')
  pool.access = async () => ({ readable: true, isPublic: false })
  return { db, sql, state, env, pool, queue }
}
const data = { name: 'bugsy', os: 'linux', arch: 'x64', labels: [] }
test('registration parity rejects control characters, paths and limits before consuming a token', async () => {
  const f = fixture()
  const invalid = [
    { name: 'bad\nname' }, { name: '../bugsy' }, { name: 'a'.repeat(65) },
    { os: 'plan9' }, { arch: 'mips' }, { labels: ['bad\tlabel'] },
    { labels: ['../label'] }, { labels: ['a'.repeat(65)] }, { labels: Array(33).fill('label') },
  ]
  await f.pool.registration()
  for (const patch of invalid) {
    const input = { ...data, ...patch }
    await assert.rejects(f.pool.register('admin', input), e => (e as any).status === 422)
    assert.throws(() => f.pool.pool.register(input, 'hash', 'default'), e => (e as any).status === 422)
    await assert.rejects(f.queue.register('admin', input), e => (e as any).status === 422)
  }
  const reg = await f.pool.registration()
  await assert.rejects(f.pool.register('', { ...data, name: '../bad' }, 'default', reg.token))
  await f.pool.register('', data, 'default', reg.token)
  assert.equal(f.pool.pool.runners().length, 1)
  assert.equal(f.queue.runs.ownRunners().length, 0)
  f.db.close()
})
test('saveGroup rejects invalid bodies and nonexistent or foreign repositories with 422', async () => {
  const f = fixture()
  const g = await f.pool.saveGroup({ name: 'builds', repositories: ['acme/one'] })
  for (const body of [{ visibility: 'bogus' }, null, [], { repositories: 'acme/one' },
    { repositories: [3] }, { repositories: ['../one'] }, { repositories: ['other/one'] },
    { repositories: ['acme/missing'] }, { allow_public_repositories: 'yes' }, { name: '' }]) {
    await assert.rejects(f.pool.saveGroup(body, g.id), e => (e as any).status === 422)
    assert.deepEqual(await f.pool.group(g.id), g)
  }
  await assert.rejects(f.pool.saveGroup({ visibility: 'all' }), e => (e as any).status === 422)
  f.pool.access = async () => ({ readable: false, isPublic: false })
  await assert.rejects(f.pool.saveGroup({ repositories: ['acme/one'] }, g.id), e => (e as any).status === 422)
  f.db.close()
})
test('personal repo runner retains its registrant; one-time registration uses repo owner', async () => {
  const f = fixture()
  const r = await f.queue.register('acme/codex', data)
  assert.equal(f.queue.runs.ownRunners().find((x: any) => x.id === r.id).owner, 'acme/codex')
  const registration = await f.queue.registration()
  const second = await f.queue.register('', { ...data, name: 'one-time' }, registration.token)
  assert.equal(f.queue.runs.ownRunners().find((x: any) => x.id === second.id).owner, 'acme')
  f.db.close()
})
test('expired and used registrations are pruned without deleting live unused tokens', async () => {
  const f = fixture(), store = new PoolStore(f.sql)
  store.registration('expired', 'acme', 'default', 1)
  store.registration('used', 'acme', 'default', 2)
  store.consume('used', 'acme', 'default', 3)
  store.registration('live', 'acme', 'default', 4)
  store.pruneRegistrations(REGISTRATION_TTL + 1)
  assert.deepEqual(store.rows<{ hash: string }>('SELECT hash FROM pool_registrations').map(r => r.hash), ['live'])
  store.consume('live', 'acme', 'default', REGISTRATION_TTL + 2)
  store.pruneRegistrations(REGISTRATION_TTL + 2)
  assert.equal(store.nextRegistrationExpiry(), null)
  const alarms: number[] = []
  f.state.storage.setAlarm = async (at: number) => { alarms.push(at) }
  store.registration('scheduled', 'acme', 'default')
  await f.pool.alarm()
  assert.equal(alarms.at(-1), store.nextRegistrationExpiry())
  f.sql.exec('UPDATE pool_registrations SET expires=1')
  await f.pool.alarm()
  assert.equal(store.rows('SELECT hash FROM pool_registrations').length, 0)
  f.db.close()
})
for (const [method, suffix, body] of [['POST', '/runners', data], ['PATCH', '/runner-groups/default', { visibility: 'all' }]] as const)
  test('non-admin org member cannot ' + (method === 'POST' ? 'register runner' : 'edit group'), async () => {
    let writes = 0
    const execute = runnerHandler({ pool: async () => ({ register: async () => { writes++ }, saveGroup: async () => { writes++ } }) as any,
      mayWrite: async (_owner: string, by: string) => by === 'admin' })
    const response = await dispatch(new Request('http://local/api/v1/orgs/acme/actions' + suffix, {
      method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    }), { authenticate: async () => ({ id: 'member', name: 'member', publicKey: '', scopes: null, repos: null }),
      control: async () => ({ rate: async () => ({ allowed: true, remaining: 100, limit: 100, reset: 0 }) }) as any,
      authorize: async () => {}, execute })
    assert.equal(response.status, 403)
    assert.equal(writes, 0)
  })
test('20 repositories and 100 polling runners share readiness per wake with no lease fanout', async () => {
  const f = fixture()
  let readyCalls = 0, leaseCalls = 0, claimCalls = 0, accessCalls = 0
  f.pool.access = async () => { accessCalls++; return { readable: true, isPublic: false } }
  f.env.RUN_QUEUE = { idFromName: (n: string) => n, get: () => ({
    ready: async () => { readyCalls++; return [] },
    leasesLive: async (a: any[]) => { leaseCalls++; return a.map(() => true) },
    poolClaim: async () => { claimCalls++; return null },
  }) }
  for (let repo = 0; repo < 20; repo++) f.pool.pool.offer('acme/repo' + repo, 'repo' + repo)
  const tokens = []
  for (let i = 0; i < 100; i++) tokens.push((await f.pool.register('admin', { ...data, name: 'runner' + i })).token)
  const started = performance.now()
  await Promise.all(tokens.map(t => f.pool.poll(t, 0)))
  const coldMs = performance.now() - started
  assert.equal(readyCalls, 20)
  assert.equal(accessCalls, 20)
  const repeated = performance.now()
  await Promise.all(tokens.map(t => f.pool.poll(t, 0)))
  const warmMs = performance.now() - repeated
  assert.equal(readyCalls, 20)
  assert.equal(leaseCalls, 0)
  assert.equal(accessCalls, 20)
  for (let i = 0; i < 100; i++) {
    const runner = f.pool.pool.authenticate(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tokens[i])).then(b => Buffer.from(b).toString('hex')))
    f.pool.pool.saveRunner({ ...runner, assignment: { repository: 'acme/repo' + Math.floor(i / 5), job: i, run: i, lease: 'live' } })
  }
  await Promise.all(tokens.map(t => f.pool.poll(t, 0)))
  assert.equal(leaseCalls, 0, 'busy polls must not check any other machine or cross a DO')
  await f.pool.overview()
  assert.equal(leaseCalls, 20, 'overview batches five leases into one call per repo')
  for (const r of f.pool.pool.runners()) f.pool.completed(r.id, 'live')
  // One repo wake reuses its offered labels; incompatible sleeping machines stay asleep.
  const windows = await f.pool.register('admin', { ...data, name: 'windows', os: 'windows' })
  const matching = f.pool.poll(tokens[0], 5000), nonmatching = f.pool.poll(windows.token, 80)
  while (f.pool.readiness.waiters.size < 2) await new Promise(r => setImmediate(r))
  f.pool.offer('acme/repo0', 'repo0', [{ job: 1, created: 1, labels: ['self-hosted', 'linux'] }])
  await matching
  assert.equal(claimCalls, 1)
  assert.equal(f.pool.readiness.waiters.size, 1)
  await nonmatching
  assert.equal(claimCalls, 1)
  assert.equal(readyCalls, 20)
  const evidence = { repositories: 20, runners: 100, coldMs, warmMs, coldReadyCalls: 20, repeatedReadyCalls: 0,
    pollAccessCalls: 20, pollLeaseCalls: 0, overviewBatchedLeaseCalls: 20, matchedWakeClaims: 1, nonmatchingWakeClaims: 0 }
  writeFileSync('docs/actions/owner-runner-scaling-evidence.json', JSON.stringify(evidence, null, 2) + '\n')
  f.db.close()
})

test('batched lease reconciliation clears dead leases without clearing a newer assignment', async () => {
  const f = fixture()
  const first = await f.pool.register('admin', { ...data, name: 'live' })
  const second = await f.pool.register('admin', { ...data, name: 'stale' })
  f.pool.pool.offer('acme/one', 'one')
  for (const r of f.pool.pool.runners()) f.pool.pool.saveRunner({ ...r,
    assignment: { repository: 'acme/one', job: 1, run: 1, lease: 'old' } })
  let calls = 0
  f.env.RUN_QUEUE = { idFromName: (n: string) => n, get: () => ({ leasesLive: async (assignments: any[]) => {
    calls++
    if (calls === 1) {
      const r = f.pool.pool.runner(second.id)
      f.pool.pool.saveRunner({ ...r, assignment: { ...r.assignment, lease: 'new' } })
    }
    return assignments.map(a => a.runner === first.id)
  } }) }
  await f.pool.overview()
  assert.equal(calls, 1)
  assert.equal(f.pool.pool.runner(first.id).assignment.lease, 'old')
  assert.equal(f.pool.pool.runner(second.id).assignment.lease, 'new')
  await f.pool.overview()
  assert.equal(f.pool.pool.runner(second.id).assignment, null)
  assert.equal(f.pool.pool.runner(first.id).assignment.lease, 'old')
  f.db.close()
})

test('cached scheduling access cannot bypass the fresh candidate read at claim', async () => {
  const f = fixture()
  const registered = await f.pool.register('admin', data)
  f.pool.pool.offer('acme/one', 'one')
  let readable = true, claims = 0
  f.pool.access = async () => ({ readable, isPublic: false })
  f.env.RUN_QUEUE = { idFromName: (n: string) => n, get: () => ({
    ready: async () => [{ job: 1, created: 1, labels: ['self-hosted', 'linux'] }],
    poolClaim: async (runner: any) => {
      readable = false // Access changes after scheduling, before the authoritative claim.
      if (!(await f.pool.candidate(runner.id, 'acme/one'))) return null
      claims++
      return { repository: 'acme/one', job: 1, run: 1, lease: 'live' }
    },
  }) }
  assert.equal(await f.pool.poll(registered.token, 0), null)
  assert.equal(claims, 0)
  assert.equal(f.pool.pool.runner(registered.id).assignment, null)
  f.db.close()
})
