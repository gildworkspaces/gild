import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { memoryStore } from './drivers/memory.ts'
import { d1Store } from './drivers/d1.ts'

mkdirSync('.tmp', { recursive: true })
await build({
  stdin: { contents: "export {fileRequest,decide,collect,joinChallenge} from './lib/agentRequests'; export {createToken,verifyToken} from './lib/tokens'", resolveDir: process.cwd() },
  outfile: '.tmp/agent-request-revocation.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external',
  plugins: [{ name: 'agent-host-fixtures', setup(b) {
    // Production request/approval/collection, tokens and crypto are retained.
    // Tests use no repository grants or Cloudflare host/event delivery.
    b.onResolve({ filter: /^\.\/backend$/ }, () => ({ path: 'backend', namespace: 'fixture' }))
    b.onResolve({ filter: /^\.\/access$/ }, () => ({ path: 'access', namespace: 'fixture' }))
    b.onResolve({ filter: /^\.\/repo-(read|index)$/ }, () => ({ path: 'repository', namespace: 'fixture' }))
    b.onResolve({ filter: /^\.\/events\/d1-outbox$/ }, () => ({ path: 'events', namespace: 'fixture' }))
    b.onResolve({ filter: /^@opennextjs\/cloudflare$/ }, () => ({ path: 'cloudflare', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ loader: 'js', contents: ({
      backend: "export const NAME_RE=/^[a-z0-9][a-z0-9-]{0,38}$/;export const AGENT_LABEL_RE=/^[a-z0-9][a-z0-9-]{0,30}$/;export async function store(){return globalThis.agentRevocationFixture}",
      access: "export const GRANTS=['pr','review','queue'];export const isAgent=n=>n.includes('/');export const mayWrite=async()=>{throw Error('Unexpected repository check')};export const capabilities=mayWrite;export const setAgentGrants=mayWrite",
      repository: "export const readyIndex=async()=>{throw Error('Unexpected repository check')};export const mayRead=readyIndex",
      events: "export async function flushAgentEvents(){throw Error('Host event delivery unavailable')}",
      cloudflare: "export function getCloudflareContext(){throw Error('Host bindings unavailable')}",
    } as Record<string, string>)[path] }))
  } }],
})
const api = await import('../.tmp/agent-request-revocation.mjs')

function sqliteStore() {
  const sql = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter(name => name.endsWith('.sql')).sort())
    sql.exec(readFileSync('migrations/' + file, 'utf8'))
  const prepare = (query: string, args: any[] = []) => ({
    bind: (...values: any[]) => prepare(query, values),
    first: async (column?: string) => { const row: any = sql.prepare(query).get(...args); return column ? row?.[column] ?? null : row ?? null },
    all: async () => ({ results: sql.prepare(query).all(...args), success: true }),
    run: async () => { const result = sql.prepare(query).run(...args); return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } } },
  })
  const db = { prepare, batch: async (statements: any[]) => {
    sql.exec('BEGIN')
    try { const results = []; for (const statement of statements) results.push(await statement.run()); sql.exec('COMMIT'); return results }
    catch (error) { sql.exec('ROLLBACK'); throw error }
  } }
  return { store: d1Store(db as any), close: () => sql.close() }
}
async function fixture(driver: string) {
  const f = driver === 'sqlite' ? sqliteStore() : { store: memoryStore(), close() {} }
  ;(globalThis as any).agentRevocationFixture = f.store
  const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const publicKey = 'ed25519:' + Buffer.from(await crypto.subtle.exportKey('raw', key.publicKey)).toString('base64')
  await f.store.prepareClaim('owner', publicKey, 'fixture@example.test', 'claim')
  assert.ok(await f.store.finalizeClaim('claim'))
  const sign = async (id: string) => Buffer.from(await crypto.subtle.sign('Ed25519', key.privateKey, new TextEncoder().encode(api.joinChallenge(id)))).toString('base64')
  return { ...f, publicKey, sign }
}

for (const driver of ['memory', 'sqlite']) {
  test(driver + ': revoked label request returns409 without changing identity, pending requests or old token denial', async () => {
    const f = await fixture(driver)
    try {
      const original = await f.store.createAgent('owner', 'old', f.publicKey, 'owner')
      const token = await api.createToken(original.name, f.publicKey)
      assert.ok(await api.verifyToken(token))
      await f.store.revokeAgent(original.name)
      const before = structuredClone(await f.store.getAgent(original.name))
      assert.equal(await api.verifyToken(token), null)
      await assert.rejects(api.fileRequest({ sponsor: '@OWNER', label: 'OLD', publicKey: f.publicKey }), (error: any) => error.status === 409)
      assert.deepEqual(await f.store.getAgent(original.name), before)
      assert.deepEqual(await f.store.pendingRequestsFor('owner'), [])
      assert.equal(await api.verifyToken(token), null)
    } finally { f.close() }
  })
  test(driver + ': legacy pending request for revoked label cannot be approved or collect a token; owner can deny', async () => {
    const f = await fixture(driver)
    try {
      await f.store.createAgent('owner', 'old', f.publicKey, 'owner')
      await f.store.revokeAgent('owner/old')
      const before = structuredClone(await f.store.getAgent('owner/old'))
      const r = await f.store.createAgentRequest({ id: 'legacy', sponsor: 'owner', label: 'old', publicKey: f.publicKey, repo: null, grants: [], note: null })
      await assert.rejects(api.decide(r.id, 'owner', 'approve', []), (error: any) => error.status === 409)
      assert.equal((await f.store.getAgentRequest(r.id))?.status, 'pending')
      assert.equal((await f.store.getAgentRequest(r.id))?.tokenIssued, false)
      assert.deepEqual(await f.store.getAgent('owner/old'), before)
      assert.deepEqual(await api.collect(r.id, await f.sign(r.id)), { status: 'pending' })
      assert.deepEqual(await api.decide(r.id, 'owner', 'deny'), { status: 'denied' })
    } finally { f.close() }
  })
  test(driver + ': fresh label still approves, collects once, and rejects later reuse or collection after revocation', async () => {
    const f = await fixture(driver)
    try {
      const r = await api.fileRequest({ sponsor: 'owner', label: 'new', publicKey: f.publicKey })
      await assert.rejects(api.decide(r.id, 'other', 'approve'), (error: any) => error.status === 403)
      assert.equal((await api.decide(r.id, 'owner', 'approve')).status, 'approved')
      const signature = await f.sign(r.id), collected = await api.collect(r.id, signature)
      assert.ok(await api.verifyToken(collected.token))
      await assert.rejects(api.collect(r.id, signature), (error: any) => error.status === 409)
      await assert.rejects(api.fileRequest({ sponsor: 'owner', label: 'new', publicKey: f.publicKey }), (error: any) => error.status === 409)
      await f.store.revokeAgent('owner/new')
      assert.equal(await api.verifyToken(collected.token), null)
      await assert.rejects(api.collect(r.id, signature), (error: any) => error.status === 404)
    } finally { f.close() }
  })
}
