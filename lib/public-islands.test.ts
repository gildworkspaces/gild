import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publicIslandsHTTP } from './fragments/islands.ts'
import type { FragmentReads } from './fragments/http'
import type { PagePointer } from './fragments/types'
const pointer = { scope: '', entity: 'acme/demo', tip: '1'.repeat(40) } as PagePointer
const reads: FragmentReads = { publicPointer: async () => pointer, access: async () => null, pointer: async () => null }
test('viewer credentials never enter anonymous islands; denied public access never forwards', async () => {
  let calls = 0
  const forward = async () => { calls++; return Response.json({ name: null, starred: false, write: false }) }
  const ctx = { waitUntil() {} }
  for (const headers of [{ cookie: 'gild_session=viewer' }, { authorization: 'Bearer viewer' }])
    assert.equal(await publicIslandsHTTP(new Request('https://gild.gg/api/repos/acme/demo/islands', { headers }), reads, ctx, forward), null)
  const denied = { ...reads, publicPointer: async () => null }
  assert.equal(await publicIslandsHTTP(new Request('https://gild.gg/api/repos/acme/demo/islands'), denied, ctx, forward), null)
  assert.equal(calls, 0)
})
test('personalized data from an anonymous handler fails closed', async () => {
  const request = new Request('https://gild.gg/api/repos/acme/demo/islands')
  for (const data of [{ name: 'viewer', starred: false, write: false }, { name: null, starred: true, write: false }, { name: null, starred: false, write: true }])
    assert.equal(await publicIslandsHTTP(request, reads, { waitUntil() {} }, async () => Response.json(data)), null)
})
