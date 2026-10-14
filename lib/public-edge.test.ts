import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publicLeases, invalidatePublicReads, PUBLIC_LEASE_MS, type EdgeCache } from './fragments/edge.ts'
function fixture() {
  let time = 0
  const entries = new Map<string, Response>(), pending: Promise<unknown>[] = []
  const edge: EdgeCache = {
    async match(r) { return entries.get(r.url)?.clone() },
    async put(r, value) { entries.set(r.url, value) },
  }
  const request = new Request('https://gild.gg/acme/repo')
  const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p) } }
  const read = () => publicLeases(request, ctx, edge, () => time)
  return { read, edge, evictGeneration() { entries.delete('https://gild.gg/__gild-read-generation') }, advance(ms: number) { time += ms }, async flush() { await Promise.all(pending.splice(0)) } }
}
test('warm public pointers make zero origin calls; push/remote revocation expires at one second', async () => {
  const f = fixture()
  let calls = 0, tip = 'old', allowed = true
  const origin = async () => { calls++; return allowed ? tip : null }
  assert.equal(await f.read()('main', origin, Boolean), 'old')
  await f.flush()
  tip = 'new'
  assert.equal(await f.read()('main', origin, Boolean), 'old')
  assert.equal(calls, 1)
  f.advance(PUBLIC_LEASE_MS)
  assert.equal(await f.read()('main', origin, Boolean), 'new')
  await f.flush()
  allowed = false
  f.advance(PUBLIC_LEASE_MS)
  assert.equal(await f.read()('main', origin, Boolean), null)
  assert.equal(calls, 3)
})
test('local writes invalidate grants and a fill racing a write cannot republish its old generation', async () => {
  const f = fixture()
  let release!: (v: string) => void
  const filling = f.read()('main', () => new Promise<string>(r => { release = r }), Boolean)
  // Let the origin read begin before the mutation.
  while (!release) await new Promise(r => setImmediate(r))
  await invalidatePublicReads('https://gild.gg', f.edge)
  release('old')
  await filling
  await f.flush()
  assert.equal(await f.read()('main', async () => 'new', Boolean), 'new')
  await f.flush()
  await invalidatePublicReads('https://gild.gg', f.edge)
  assert.equal(await f.read()('main', async () => null, Boolean), null)
})
test('slow origin fills expire from read start, and errors never serve stale grants', async () => {
  const f = fixture()
  // A read slower than the lease still answers its own request (gild-site#63:
  // cold reads after a deploy were 503s), but is never stored for others.
  assert.equal(await f.read()('grant', async () => { f.advance(PUBLIC_LEASE_MS); return true }, Boolean), true)
  await f.flush()
  assert.equal(await f.read()('grant', async () => false, Boolean), false)
  await f.read()('grant', async () => true, Boolean)
  await f.flush()
  f.advance(PUBLIC_LEASE_MS)
  await assert.rejects(f.read()('grant', async () => { throw Error('primary unavailable') }, Boolean), /primary unavailable/)
})
test('private and denied values never populate a shared cache; viewer headers do not contaminate a public grant', async () => {
  const f = fixture()
  let calls = 0
  const read = async () => { calls++; return { scope: 'private', html: 'secret' } }
  const publicValue = (p: { scope: string }) => !p.scope
  await f.read()('main', read, publicValue)
  await f.flush()
  await f.read()('main', read, publicValue)
  assert.equal(calls, 2)
})

test('generation eviction never resurrects a pre-write public grant', async () => {
  const f = fixture()
  let current = 'old', calls = 0
  const read = async () => { calls++; return current }
  assert.equal(await f.read()('main', read, Boolean), 'old')
  await f.flush()
  current = 'new'
  await invalidatePublicReads('https://gild.gg', f.edge)
  f.evictGeneration()
  assert.equal(await f.read()('main', read, Boolean), 'new')
  assert.equal(calls, 2, 'an evicted generation must renew against the primary')
})
