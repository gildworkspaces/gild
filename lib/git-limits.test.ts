import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { limitedBody, packBudget, checkRefBudget, FILE_BYTES, REPO_BYTES } from './git-limits.ts'
import { ApiControlStore } from './api/control-store.ts'
import { historyRate } from './fragments/rate.ts'
function packet(type: number, value: Buffer, base = Buffer.alloc(0)) {
  let size = value.length, first = (type << 4) | (size & 15)
  size = Math.floor(size / 16)
  const header = [first | (size ? 128 : 0)]
  while (size) { const next = size & 127; size = Math.floor(size / 128); header.push(next | (size ? 128 : 0)) }
  const pack = Buffer.concat([Buffer.from('5041434b0000000200000001', 'hex'), Buffer.from(header), base, deflateSync(value)])
  return Buffer.concat([Buffer.from('0000'), pack, createHash('sha1').update(pack).digest()])
}
function variable(value: number) {
  const out: number[] = []
  do { const next = value & 127; value = Math.floor(value / 128); out.push(next | (value ? 128 : 0)) } while (value)
  return Buffer.from(out)
}
function control() {
  const db = new DatabaseSync(':memory:')
  return new ApiControlStore({ exec(q: string, ...args: (string | number)[]) {
    if (!args.length && q.includes(';')) { db.exec(q); return [] }
    return db.prepare(q).all(...args) as never
  } })
}
test('real zlib pack objects and delta results are bounded before forwarding', () => {
  assert.equal(packBudget(packet(3, Buffer.from('hello'))), 5)
  assert.throws(() => packBudget(packet(3, Buffer.alloc(FILE_BYTES + 1))), /100 MiB/)
  const delta = Buffer.concat([variable(1), variable(FILE_BYTES + 1), Buffer.from([1, 65])])
  assert.throws(() => packBudget(packet(7, delta, Buffer.alloc(20))), /Delta result/)
  const corrupt = packet(3, Buffer.from('hello')); corrupt[corrupt.length - 1] ^= 1
  assert.throws(() => packBudget(corrupt), /checksum/)
  assert.equal(packBudget(Buffer.from('0000')), 0)
})
test('a declared transfer over 2 GiB is rejected without allocating it', async () => {
  await assert.rejects(limitedBody(new Request('https://git.test', {method:'POST',body:'x',headers:{'content-length':String(2*1024*1024*1024+1)}})), /2 GiB/)
})
test('durable reservations prevent concurrent pushes exceeding repository budget', () => {
  const c = control()
  assert.equal(c.reserveBytes('first', 20, REPO_BYTES - 30, REPO_BYTES), true)
  assert.equal(c.reserveBytes('second', 20, 0, REPO_BYTES), false)
  c.releaseBytes('first')
  assert.equal(c.reserveBytes('second', 20, 0, REPO_BYTES), true)
  for (let i = 0; i < 30; i++) assert.equal(c.rate(0, 30).allowed, true)
  assert.equal(c.rate(0, 30).allowed, false)
})
test('small packs cannot fan out unbounded render jobs through ref updates', () => {
  const existing = Array.from({ length: 500 }, (_, i) => `refs/tags/${i}`)
  assert.throws(() => checkRefBudget(existing, [{ ref: 'refs/tags/new', sha: '1'.repeat(40) }]), /500 branch\/tag/)
  checkRefBudget(existing, [{ ref: 'refs/tags/1', sha: '0'.repeat(40) }, { ref: 'refs/tags/new', sha: '1'.repeat(40) }])
  assert.throws(() => checkRefBudget([], Array.from({ length: 101 }, (_, i) => ({ ref: `refs/tags/${i}`, sha: '1'.repeat(40) }))), /100 ref-update/)
})
test('cold history is limited independently by account and IP, with Retry-After', async () => {
  const states = new Map<string, ApiControlStore>()
  const ns = { idFromName: (key: string) => key, get: (key: unknown) => {
    if (!states.has(String(key))) states.set(String(key), control())
    return { rate: async (now: number, limit: number) => states.get(String(key))!.rate(now, limit) }
  } }
  const request = (ip: string) => new Request('https://gild.test', { headers: { 'cf-connecting-ip': ip } })
  for (let i = 0; i < 600; i++) assert.equal(await historyRate(request(String(i)), ns, 'reader'), null)
  const account = await historyRate(request('new'), ns, 'reader')
  assert.equal(account?.status, 429); assert.ok(Number(account?.headers.get('retry-after')) > 0)
  for (let i = 0; i < 120; i++) assert.equal(await historyRate(request('same'), ns, null), null)
  assert.equal((await historyRate(request('same'), ns, null))?.status, 429)
})

test('unique object reservations charge duplicates once and refund ambiguous outcomes', () => {
  const c = control(), a = {hash:'a',size:50}, b = {hash:'b',size:40}
  assert.equal(c.reserveObjects('one',[a,a],[a],100),true)
  c.finishObjects('one',true)
  assert.equal(c.reserveObjects('two',[a,b],[a],100),true)
  assert.equal(c.reserveObjects('three',[{hash:'c',size:20}],[],100),false)
  c.finishObjects('two',false)
  assert.equal(c.reserveObjects('three',[{hash:'c',size:20}],[],100),true)
  c.finishObjects('three',true)
  assert.equal(c.reserveObjects('replay',[a,{hash:'c',size:20}],[],100),true)
})
test('history keys isolate repos and missing IPs; signed-in NAT does not consume anonymous allowance', async () => {
  const seen: string[] = []
  const ns = {idFromName:(s:string)=>{seen.push(s);return s},get:()=>({rate:async()=>({allowed:true,reset:0})})} as any
  const req = new Request('https://gild.test/o/r/commit/'+ 'a'.repeat(40))
  assert.equal((await historyRate(req,ns,null,'o/r'))?.status,429)
  assert.equal((await historyRate(req,ns,null,'o/r'))?.status,429)
  assert.equal(seen.length,0,'missing IP never creates a shared or bypass bucket')
  await historyRate(req,ns,'viewer','o/r');await historyRate(req,ns,'viewer','o/s')
  assert.notEqual(seen[0],seen[1])
  const denied = await historyRate(req,{idFromName:s=>s,get:()=>({rate:async()=>({allowed:false,reset:Math.floor(Date.now()/1000)+60})})} as any,'viewer','o/r')
  assert.match(await denied!.text(),/href="\/o\/r"/)
  const evil = await historyRate(new Request('https://gild.test/x?repo=/evil.example/x'),{idFromName:s=>s,get:()=>({rate:async()=>({allowed:false,reset:0})})} as any,'viewer','/evil.example/x')
  assert.match(await evil!.text(),/href="\/"/,'429 link never leaves the site')
})
