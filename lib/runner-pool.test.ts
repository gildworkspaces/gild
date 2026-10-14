import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  PoolStore,
  groupEligibility,
  REGISTRATION_TTL,
} from './actions/pool-store.ts'
import { RunStore } from './actions/store.ts'
import { parseWorkflow } from './actions/workflow.ts'
import { mayRead } from './repo-read.ts'
function fixture() {
  const db = new DatabaseSync(':memory:'),
    sql = {
      exec: (q: string, ...args: any[]) => {
        if (!args.length && q.includes(';')) {
          db.exec(q)
          return []
        }
        return db.prepare(q).all(...args) as any
      },
    }
  return { db, pool: new PoolStore(sql), runs: new RunStore(sql) }
}
const workflow = parseWorkflow(
  'ci.yml',
  `on: push\njobs:\n  test:\n    runs-on: self-hosted\n    steps:\n      - run: echo worked\n`,
)
function create(f: ReturnType<typeof fixture>) {
  f.pool.owner('acme')
  const group = f.pool.saveGroup({
    id: 'builds',
    name: 'builds',
    visibility: 'selected',
    repositories: ['acme/one'],
    allow_public_repositories: false,
  })
  const r = f.pool.register(
    { name: 'bugsy', os: 'linux', arch: 'x64', labels: [] },
    'runner-hash',
    group.id,
  )
  f.runs.inherited(r)
  return { group, r }
}
function enqueue(f: ReturnType<typeof fixture>, extra = {}) {
  return f.runs.enqueue(workflow, {
    name: 'push',
    sha: 'a'.repeat(40),
    ref: 'refs/heads/main',
    actor: 'acme',
    title: 'test',
    repository: 'acme/one',
    key: crypto.randomUUID(),
    ...extra,
  })
}
test('group eligibility blocks leasing outside selected repositories', () => {
  const f = fixture(),
    { group, r } = create(f)
  enqueue(f)
  const claim = (repository: string) =>
    groupEligibility(group, repository, true, false) === null
      ? f.runs.claim(r as never)
      : null
  assert.equal(claim('acme/two'), null)
  assert.equal(f.runs.runs()[0].status, 'queued')
  assert.ok(claim('acme/one'))
  f.db.close()
})
test('public repository exclusion blocks leasing until allow-public is enabled', () => {
  const f = fixture(),
    { group, r } = create(f)
  enqueue(f)
  const claim = () =>
    groupEligibility(f.pool.group(group.id), 'acme/one', true, true) === null
      ? f.runs.claim(r as never)
      : null
  assert.equal(claim(), null)
  assert.equal(f.runs.runs()[0].status, 'queued')
  f.pool.saveGroup({ ...group, allow_public_repositories: true })
  assert.ok(claim())
  f.db.close()
})
test('removing group access leaves the running job valid and the next job queued', () => {
  const f = fixture(),
    { group, r } = create(f)
  enqueue(f)
  const first = f.runs.claim(r as never)!
  enqueue(f)
  f.pool.saveGroup({ ...group, repositories: [] })
  assert.equal(
    f.runs.heartbeat(r.id, first.job.id, first.job.lease!).cancel,
    false,
  )
  f.runs.finish(
    r.id,
    first.job.id,
    first.job.lease!,
    'failure',
    'fixture complete',
  )
  assert.equal(f.runs.run(first.run.id)?.status, 'failure')
  assert.ok(groupEligibility(f.pool.group(group.id), 'acme/one', true, false))
  assert.equal(f.runs.ready(r.labels).length, 1)
  f.db.close()
})
test('repo and inherited runner compete for the same authoritative lease once', () => {
  const f = fixture(),
    { r } = create(f)
  enqueue(f)
  f.runs.register(
    {
      id: 'repo',
      name: 'local',
      owner: 'acme',
      os: 'linux',
      arch: 'x64',
      labels: [],
    },
    'repo-hash',
  )
  const results = [
    f.runs.claim(r as never),
    f.runs.claim(f.runs.authenticate('repo-hash')!),
  ]
  assert.equal(results.filter(Boolean).length, 1)
  f.db.close()
})
test('checkout credential dies with its lease, never authenticates in another repo', () => {
  const f = fixture(),
    other = fixture(),
    { r } = create(f)
  enqueue(f)
  const j = f.runs.claim(r as never)!.job
  f.runs.checkout('checkout-hash', r.id, j.id, j.lease!)
  assert.equal(f.runs.checkoutRunner('checkout-hash').id, r.id)
  assert.throws(
    () => f.runs.checkoutRunner('checkout-hash', Date.now(), j.id + 1, j.lease),
    /does not belong/,
  )
  assert.throws(() => other.runs.checkoutRunner('checkout-hash'), /invalid/)
  assert.throws(
    () => f.runs.checkoutRunner('checkout-hash', j.deadline!),
    /invalid/,
  )
  f.runs.finish(r.id, j.id, j.lease!, 'failure', null)
  assert.throws(() => f.runs.checkoutRunner('checkout-hash'), /invalid/)
  f.db.close()
  other.db.close()
})
test('registration is single use, expires at one hour and binds owner and group', () => {
  const f = fixture()
  create(f)
  f.pool.registration('reg', 'acme', 'builds', 1000)
  assert.throws(() => f.pool.consume('reg', 'other', 'builds', 1001), /invalid/)
  assert.throws(() => f.pool.consume('reg', 'acme', 'default', 1001), /invalid/)
  f.pool.consume('reg', 'acme', 'builds', 1001)
  assert.throws(() => f.pool.consume('reg', 'acme', 'builds', 1002), /used/)
  f.pool.registration('expired', 'acme', 'builds', 1000)
  assert.throws(
    () => f.pool.consume('expired', 'acme', 'builds', 1000 + REGISTRATION_TTL),
    /expired/,
  )
  f.db.close()
})
test('shared mayRead permits listed private repo to owner and public flag remains false', async () => {
  const f = fixture(),
    { group } = create(f)
  const deps = {
    store: { orgRole: async () => null },
    index: async () => ({
      metaFile: async () => JSON.stringify({ visibility: 'private' }),
    }),
  }
  assert.equal(await mayRead(deps as never, 'acme', 'one', 'acme'), true)
  assert.equal(await mayRead(deps as never, 'acme', 'one', null), false)
  assert.equal(
    groupEligibility(
      group,
      'acme/one',
      await mayRead(deps as never, 'acme', 'one', 'acme'),
      await mayRead(deps as never, 'acme', 'one', null),
    ),
    null,
  )
  f.db.close()
})
test('public fork runs cannot be leased by repo or owner runners before maintainer approval', () => {
  const f = fixture(),
    { r } = create(f),
    id = enqueue(f, { requiresApproval: true, name: 'pull_request' })
  assert.equal(f.runs.ready(r.labels).length, 0)
  assert.equal(f.runs.claim(r as never), null)
  f.runs.approve(id, 'admin')
  assert.ok(f.runs.claim(r as never))
  f.db.close()
})
