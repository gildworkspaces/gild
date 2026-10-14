import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  licenseId,
  commitWeeks,
  activityBuckets,
  sparklinePoints,
  WEEK,
} from './repo-summary.ts'
import { repoList, type ListServices } from './repo-list.ts'
import { DatabaseSync } from 'node:sqlite'
import { IndexStore, type SQL } from './repo-index-store.ts'
import { listingSnapshot, type ListingSnapshot } from './repo-list-snapshot.ts'
import { updatedAgo } from './time.ts'
import { kept } from './kept.ts'
import { memoryStore } from './drivers/memory.ts'

const licenses = [
  [
    'MIT',
    'Permission is hereby granted, free of charge, to any person obtaining a copy. THE SOFTWARE IS PROVIDED "AS IS"',
  ],
  [
    'Apache-2.0',
    'Apache License Version 2.0, January 2004. See the License for the specific language governing permissions and limitations under the License.',
  ],
  [
    'BSD-2-Clause',
    'Redistribution and use in source and binary forms. Redistributions of source code must retain. Redistributions in binary form must reproduce. THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS "AS IS".',
  ],
  [
    'BSD-3-Clause',
    'Redistribution and use in source and binary forms. Redistributions of source code must retain. Redistributions in binary form must reproduce. Neither the name of the copyright holder nor the names of its contributors may be used to endorse. THIS SOFTWARE IS PROVIDED "AS IS".',
  ],
  ['GPL-3.0', 'GNU GENERAL PUBLIC LICENSE Version 3, 29 June 2007'],
  ['MPL-2.0', 'Mozilla Public License Version 2.0'],
  [
    'ISC',
    'Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee. THE SOFTWARE IS PROVIDED "AS IS"',
  ],
] as const
for (const [id, text] of licenses)
  test(`license ${id}`, () => assert.equal(licenseId(text), id))
test('unknown and other versions omitted', () => {
  for (const text of [
    'All rights reserved',
    'MIT-like custom license',
    'GNU LESSER GENERAL PUBLIC LICENSE Version 3, 29 June 2007',
    'GNU GENERAL PUBLIC LICENSE Version 2, June 1991',
    'Apache License Version 1.1',
  ])
    assert.equal(licenseId(text), null)
})
test('52 fixed UTC weeks, boundary dates, old commits, flat line and time advancing', () => {
  const now = Date.parse('2026-10-08T12:00:00Z')
  const weeks = commitWeeks(
    [
      '2026-10-05T00:00:00Z',
      '2026-10-04T23:59:59Z',
      '2026-10-07T10:00:00Z',
      '2024-01-01T00:00:00Z',
    ].map((s) => Date.parse(s) / 1000),
  )
  const buckets = activityBuckets(weeks, now)
  assert.equal(buckets.length, 52)
  assert.deepEqual(buckets.slice(-2), [1, 2])
  assert.equal(
    buckets.reduce((a, b) => a + b, 0),
    3,
  )
  assert.equal(
    activityBuckets(weeks, now + 53 * WEEK * 1000).reduce((a, b) => a + b, 0),
    0,
  )
  const flat = sparklinePoints(
    activityBuckets(commitWeeks([Date.parse('2024-01-01') / 1000]), now),
  )
  assert.equal(flat.split(' ').length, 52)
  assert.ok(flat.split(' ').every((p) => p.endsWith(',36.00')))
})
test('owner batch uses live stars, ACL, counts and scores without per-card reads', async () => {
  const st = memoryStore()
  const snapshot: ListingSnapshot = {
    tip: 'a'.repeat(40),
    meta: 'meta1',
    facts: {
      license: 'MIT',
      language: { name: 'TypeScript', color: '#3178c6' },
      updated: 1,
      weeks: commitWeeks([Date.parse('2026-10-08') / 1000]),
    },
    updated: 1,
    issues: 1,
    pulls: 1,
    acl: {},
  }
  let batchReads = 0,
    starReads = 0,
    scoreReads = 0
  const starCounts = st.starCounts.bind(st)
  st.starCounts = async (ids) => {
    starReads++
    return starCounts(ids)
  }
  const catalog = Array.from({ length: 15 }, (_, i) => ({
    name: 'repo' + i,
    description: 'Live description',
  })) as RepoRow[]
  const services: ListServices = {
    store: st,
    catalog: async () => catalog,
    snapshots: async (repos) => {
      batchReads++
      return Object.fromEntries(repos.map((r) => [r.id, snapshot]))
    },
    scores: async (_, repos) => {
      scoreReads++
      return Object.fromEntries(repos.map((r) => [r.name, { score: 72, note: null }]))
    },
  }
  const now = Date.parse('2026-10-08T12:00:00Z')
  let rows = await repoList('acme', null, services, now)
  assert.equal(rows.length, 15)
  assert.equal(rows[0].license, 'MIT')
  assert.equal(rows[0].language?.name, 'TypeScript')
  assert.equal(rows[0].score, 72)
  assert.equal(rows[0].issues, 1)
  assert.equal(rows[0].pulls, 1)
  assert.deepEqual(
    [batchReads, starReads, scoreReads],
    [1, 1, 1],
    'three owner batches for 15 cards',
  )
  await st.star('acme/repo0', 'alice')
  snapshot.issues = 0
  rows = await repoList('acme', null, services, now + 53 * WEEK * 1000)
  assert.equal(rows.find((r) => r.name === 'repo0')!.stargazers_count, 1)
  assert.equal(rows[0].issues, 0)
  assert.equal(
    rows[0].activity?.reduce((a, b) => a + b, 0),
    0,
  )
  snapshot.acl = {
    private: true,
    read: ['@reader'],
    agents: { '@acme/bot': [] },
  }
  assert.deepEqual(await repoList('acme', null, services), [])
  assert.deepEqual(await repoList('acme', 'outsider', services), [])
  assert.deepEqual(await repoList('acme','acme/bot',services),[])
  snapshot.acl.agents={'@acme/bot':['pr']}
  for (const viewer of ['acme', 'reader', 'acme/bot'])
    assert.equal((await repoList('acme', viewer, services)).length, 15)
  await st.createOrg('acme', null, 'admin')
  assert.equal((await repoList('acme', 'admin', services)).length, 15)
  await st.addOrgMember('acme', 'member', 'member')
  assert.equal((await repoList('acme', 'member', services)).length,15)
  // Settings are re-read even when names and repo info came from a minute cache.
  const state = await st.settings.state('acme/repo0')
  state.deletedAt = now
  await st.settings.putState(state)
  assert.equal(
    (await repoList('acme', 'acme', services, now, ['repo0'], catalog)).length,
    0,
  )
})

test('last published snapshot survives refresh, keeps facts once per code/meta tip and retries incomplete history', () => {
  const db = new DatabaseSync(':memory:')
  const sql: SQL = {
    exec(q, ...args) {
      if (!args.length && q.includes(';')) {
        db.exec(q)
        return []
      }
      return db.prepare(q).all(...args) as never
    },
  }
  const index = new IndexStore(sql)
  assert.equal(listingSnapshot(index), null, 'unpublished fails closed')
  const publish = (
    tip: string,
    meta: string,
    privateRepo = false,
    history = true,
  ) => {
    index.putCommit({
      hash: tip,
      tree: 'tree',
      parents: [],
      time: 1000,
      author_name: '',
      author_email: '',
      message: '',
    })
    index.putTree('tree', [
      { name: 'LICENSE', type: 'blob', mode: '100644', child: 'license' },
      { name: 'main.ts', type: 'blob', mode: '100644', child: 'code' },
    ])
    index.putBlob({
      hash: 'license',
      size: licenses[0][1].length,
      lines: 1,
      language: '',
      binary: 0,
      content: licenses[0][1],
      symbols: [],
    })
    index.putBlob({
      hash: 'code',
      size: 10,
      lines: 1,
      language: 'TypeScript',
      binary: 0,
      content: 'export {}',
      symbols: [],
    })
    db.prepare('INSERT OR IGNORE INTO meta_roots VALUES (?)').run(meta)
    db.prepare('INSERT OR IGNORE INTO meta_files VALUES (?,?,?)').run(
      meta,
      '.gild/index.json',
      JSON.stringify({
        issues: [{ state: privateRepo ? 'closed' : 'open' }],
        pulls: [],
      }),
    )
    db.prepare('INSERT OR IGNORE INTO meta_files VALUES (?,?,?)').run(
      meta,
      '.gild/acl.json',
      JSON.stringify({ private: privateRepo }),
    )
    index.publish([{ name: 'main', kind: 'branch', hash: tip }], 'main', meta)
    if (history)
      db.prepare('INSERT OR IGNORE INTO api_history_roots VALUES (?)').run(tip)
    db.prepare('INSERT OR IGNORE INTO api_history_nodes VALUES (?,?,?)').run(
      tip,
      tip,
      1000,
    )
  }
  publish('tip1', 'meta1')
  const first = listingSnapshot(index)!
  assert.equal(first.facts!.license, 'MIT')
  assert.equal(first.issues, 1)
  index.setting('dirty', '1')
  assert.deepEqual(
    listingSnapshot(index),
    first,
    'listing does not wait on dirty index',
  )
  publish('tip2', 'meta2', true, false)
  const pending = listingSnapshot(index)!
  assert.equal(pending.tip, 'tip2')
  assert.equal(pending.acl.private, true)
  assert.equal(
    pending.issues,
    0,
    'new metadata tip recomputes counts while code history is pending',
  )
  assert.deepEqual(
    pending.facts,
    first.facts,
    'last code facts while new history fills',
  )
  assert.equal(
    index.view('repo-list:code:v2:tip2'),
    null,
    'incomplete facts never cached',
  )
  db.prepare('INSERT INTO api_history_roots VALUES (?)').run('tip2')
  assert.ok(listingSnapshot(index)!.facts)
  assert.ok(index.view('repo-list:code:v2:tip2'))
  // A warm snapshot has no code/history or metadata recomputation.
  index.apiLog = () => {
    throw Error('history was re-read')
  }
  index.languages = () => {
    throw Error('languages were re-read')
  }
  index.metaFile = () => {
    throw Error('metadata was re-read')
  }
  assert.equal(listingSnapshot(index)!.acl.private, true)
  db.close()
})

test('durable kept coalesces concurrent summary misses and retries failed computations', async () => {
  const key = 'repo-list:concurrent:' + crypto.randomUUID()
  let calls = 0
  const compute = async () => {
    calls++
    await new Promise((r) => setTimeout(r, 10))
    return { weeks: { '1': 2 } }
  }
  assert.deepEqual(
    await Promise.all([kept(key, compute), kept(key, compute)]),
    [{ weeks: { '1': 2 } }, { weeks: { '1': 2 } }],
  )
  assert.deepEqual(await kept(key, compute), { weeks: { '1': 2 } })
  assert.equal(calls, 1)
  await assert.rejects(
    kept(key + 'failed', async () => {
      throw new Error('pending history')
    }),
  )
  assert.deepEqual(await kept(key + 'failed', compute), { weeks: { '1': 2 } })
})

test('old tip freshness stays relative; absolute timestamp remains available to the row', () => {
  const now = Date.parse('2026-10-08T12:00:00Z')
  assert.equal(updatedAgo(now - 45 * 86400000, now), '1 month ago')
  assert.equal(updatedAgo(now - 120 * 86400000, now), '4 months ago')
  assert.equal(updatedAgo(Date.parse('2024-01-01'), now), '2 years ago')
})
