import { test } from 'node:test'
import assert from 'node:assert/strict'
import { awaitCurrentIndex } from './repo-index-ready.ts'
import { mayRead } from './repo-read.ts'
import { ApiError } from './api/errors.ts'
import type { Refs } from './repo-refs.ts'

const refs = (meta: string): Refs => ({ branches: [{ name: 'main', oid: 'code' }], tags: [], defaultBranch: 'main', meta })
const indexed = (meta: string) => ({ refs: [{ kind: 'branch', name: 'main', hash: 'code' }], defaultBranch: 'main', meta })

test('a metadata refresh waits for the current private ACL without reporting missing', async () => {
  let ready = false, calls = 0
  const index = {
    async status() { ready = ++calls > 1; return { ready, refreshing: !ready } },
    async refs() { return indexed('new') },
    async refresh() { assert.fail('must not restart in-flight work') },
    async metaFile() { assert.equal(ready, true); return '{"visibility":"private"}' },
  }
  const s = {
    store: { async orgRole() { return null } },
    index: () => awaitCurrentIndex(index, 'owner', 'repo', refs('old'), async () => refs('new')),
  }
  assert.equal(await mayRead(s, 'owner', 'repo', 'owner'), true)
  assert.equal(await mayRead(s, 'owner', 'repo', null), false)
})

test('a lagging snapshot schedules once and becomes readable after refresh', async () => {
  let tip = 'old', scheduled = 0
  const index = {
    async status() { return { ready: true, refreshing: false } },
    async refs() { return indexed(tip) },
    async refresh() { scheduled++; tip = 'new' },
  }
  assert.equal(await awaitCurrentIndex(index, 'owner', 'repo', refs('new'), async () => refs('new')), index)
  assert.equal(scheduled, 1)
})

test('a refresh exceeding the budget reports unavailable rather than not found', async () => {
  const index = {
    async status() { return { ready: false, refreshing: true } },
    async refs() { return indexed('old') },
    async refresh() { assert.fail('must not restart refresh') },
  }
  await assert.rejects(awaitCurrentIndex(index, 'owner', 'repo', refs('new'), async () => refs('new'), 0),
    e => e instanceof ApiError && e.status === 503)
})
