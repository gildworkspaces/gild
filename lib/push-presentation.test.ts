import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publishPushPresentation, publishPushBatches } from './push-presentation.ts'

test('push acknowledgement waits for the new index and stored presentation', async () => {
  let indexed = false, acknowledged = false, published = false, scheduled = 0
  let finish!: () => void
  const stored = new Promise<void>(resolve => { finish = resolve })
  const index = {
    async refresh() { scheduled++; indexed = true },
    async status() { return { ready: indexed, refreshing: !indexed } },
    async refs() { return { refs: [{ kind: 'branch', name: 'main', hash: indexed ? 'new' : 'old' }], defaultBranch: 'main', meta: null } },
  }
  const live = async () => ({ branches: [{ name: 'main', oid: 'new' }], tags: [], defaultBranch: 'main', meta: null })
  const push = publishPushPresentation(index, 'owner', 'repo', live, async () => {
    assert.equal(indexed, true, 'presentation uses the accepted indexed commit')
    await stored
    published = true
  }).then(() => { acknowledged = true })
  // Drain the asynchronous index reads while the renderer is deliberately held.
  for (let i = 0; i < 12; i++) await Promise.resolve()
  assert.equal(acknowledged, false, 'Git acknowledgement must wait for stored presentation')
  assert.equal(published, false)
  finish()
  await push
  assert.equal(scheduled, 1)
  assert.equal(published, true)
  assert.equal(acknowledged, true)
})

test('presentation failure cannot report a successful publication', async () => {
  const index = {
    async refresh() {}, async status() { return { ready: true, refreshing: false } },
    async refs() { return { refs: [], defaultBranch: 'main', meta: null } },
  }
  await assert.rejects(publishPushPresentation(index, 'owner', 'repo',
    async () => ({ branches: [], tags: [], defaultBranch: 'main', meta: null }),
    async () => { throw new Error('presentation unavailable') }), /presentation unavailable/)
})

test('push publication follows every batch before returning and fails closed on a later error', async () => {
  const initial = { entity: 'id', repository: 'owner/repo' }
  const bodies: Record<string, unknown>[] = []
  const renderer = { async fetch(_url: string, init: RequestInit) {
    const body = JSON.parse(init.body as string); bodies.push(body)
    return bodies.length === 1 ? Response.json({ jobs: ['fixture'], tip: 0, cursor: 50 }) : new Response(null, { status: 204 })
  } }
  await publishPushBatches(renderer, initial)
  assert.equal(bodies.length, 2)
  assert.equal(bodies[1].cursor, 50)
  assert.equal(bodies[1].repository, initial.repository)
  assert.deepEqual(bodies[1].jobs, ['fixture'])
  let calls = 0
  await assert.rejects(publishPushBatches({ async fetch() {
    return ++calls === 1 ? Response.json({ tip: 1, cursor: 0 }) : new Response(null, { status: 503 })
  } }, initial), /publication is pending/)
  assert.equal(calls, 2)
})
