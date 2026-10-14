import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { d1Store } from './drivers/d1.ts'
import { memoryStore } from './drivers/memory.ts'
import type { ForgeStore } from './backend.ts'
import type { D1Database } from '@cloudflare/workers-types'
import { browserProofHash, BROWSER_PROOF_ORIGIN } from './browser-proof.ts'
import { settingsHTTP } from './settings-http.ts'
import { verifySessionCookie } from './session-cookie.ts'

const origin = 'https://gild.example.test'
const secret = 'disposable-browser-session-fixture-secret'
const globals = globalThis as unknown as { __browserStore: ForgeStore }
const key = generateKeyPairSync('ed25519')
const publicKey = 'ed25519:' + key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const proof = (challenge: string) => ({ challenge, publicKey, signature: sign(null, Buffer.from(challenge), key.privateKey).toString('base64') })

function database() {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'))
  const d1 = { prepare(sql: string) {
    let values: never[] = []
    const statement = {
      bind(...args: never[]) { values = args; return statement },
      async first() { return db.prepare(sql).get(...values) ?? null },
      async all() { return { results: db.prepare(sql).all(...values) } },
      async run() { return { meta: { changes: Number(db.prepare(sql).run(...values).changes) } } },
    }
    return statement
  } } as unknown as D1Database
  return { db, d1, store: d1Store(d1) }
}

// Bundle the actual route entrypoints, session signer and bootstrap signature
// verifier. Only deployment binding lookup and unrelated agent routes are replaced.
async function routes() {
  mkdirSync('.tmp', { recursive: true })
  const work = mkdtempSync(resolve('.tmp/browser-proof-'))
  const entrypoints = {
    challenge: 'app/api/auth/challenge/route.ts', answer: 'app/api/auth/answer/route.ts',
    auth: 'app/api/auth/status/route.ts', prepare: 'app/api/claim/prepare/route.ts',
    claimAnswer: 'app/api/claim/answer/route.ts', claim: 'app/api/claim/status/route.ts', token: 'app/api/tokens/route.ts',
  }
  await build({ entryPoints: entrypoints, outdir: work, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'fixture-bindings', setup(b) {
    b.onResolve({ filter: /^next\/(server|headers)$/ }, args => ({ path: args.path + '.js', external: true }))
    b.onResolve({ filter: /(?:^@\/lib\/backend$|\/backend(?:\.ts)?$)/ }, () => ({ path: 'backend', namespace: 'fixture' }))
    b.onResolve({ filter: /^@opennextjs\/cloudflare$/ }, () => ({ path: 'bindings', namespace: 'fixture' }))
    b.onResolve({ filter: /\/agentRequests$/ }, () => ({ path: 'agents', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'backend'
      ? 'export const store=async()=>globalThis.__browserStore;export const binding=async()=>null;export const decorateStore=()=>{}'
      : args.path === 'bindings' ? `export const getCloudflareContext=()=>({env:{SESSION_SECRET:${JSON.stringify(secret)}}})`
      : 'export const fileRequest=()=>{throw Error("unused agent route")};export const collect=fileRequest', loader: 'js' }))
  } }] })
  const handlers: Record<string, { POST?: (r: Request) => Promise<Response>; GET?: (r: Request) => Promise<Response> }> = {}
  for (const name of Object.keys(entrypoints)) handlers[name] = await import(pathToFileURL(join(work, name + '.mjs')).href)
  return { handlers, close() { rmSync(work, { recursive: true, force: true }) } }
}
const compiled = await routes()
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => new Request(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const statusRequest = (kind: string, challenge: string, cookie?: string, headers: Record<string, string> = {}) => new Request(origin + `/api/${kind}/status?challenge=${encodeURIComponent(challenge)}`, { headers: { ...(cookie ? { cookie } : {}), ...headers } })
const cookiePair = (r: Response) => r.headers.get('set-cookie')!.split(';')[0]
const status = (kind: string, challenge: string, cookie?: string, headers?: Record<string, string>) => compiled.handlers[kind].GET!(statusRequest(kind, challenge, cookie, headers))

for (const driver of ['sqlite', 'memory']) for (const kind of ['auth', 'claim']) {
  test(`${driver} ${kind}: actual routes bind browser, consume once, and preserve terminal token proof`, async () => {
    const sql = database(), st = driver === 'sqlite' ? sql.store : memoryStore()
    globals.__browserStore = st
    try {
      const begin = () => kind === 'auth'
        ? compiled.handlers.challenge.POST!(post('/api/auth/challenge', {}, { origin, 'sec-fetch-site': 'same-origin' }))
        : compiled.handlers.prepare.POST!(post('/api/claim/prepare', { name: 'browseruser', email: 'browser@example.test', publicKey }, { origin, 'sec-fetch-site': 'same-origin' }))
      const started = await begin()
      assert.equal(started.status, 200)
      const { challenge } = await started.json(), cookie = cookiePair(started)
      assert.match(started.headers.get('set-cookie')!, /HttpOnly; Secure; SameSite=Strict/)
      assert.match(cookie, /^__Host-gild_(auth|claim)_state=[a-f0-9]{64}$/)
      assert.equal(started.headers.get('cache-control'), 'no-store')
      const pending = await status(kind, challenge, cookie)
      assert.deepEqual(await pending.json(), { status: 'pending' })
      assert.equal(pending.headers.get('set-cookie'), null)
      const answerHandler = compiled.handlers[kind === 'auth' ? 'answer' : 'claimAnswer'].POST!
      assert.equal((await answerHandler(post('/api/' + kind + '/answer', { ...proof(challenge), signature: 'bad' }))).status, 403)
      assert.equal((await answerHandler(post('/api/' + kind + '/answer', proof(challenge)))).status, 200)
      for (const invalid of [undefined, cookie.replace(/[a-f0-9]{64}$/, '0'.repeat(64)), cookie.replace('_' + kind + '_', '_' + (kind === 'auth' ? 'claim' : 'auth') + '_')]) {
        const denied = await status(kind, challenge, invalid)
        assert.equal(denied.status, 404, 'another browser must not receive a session')
        assert.equal(denied.headers.get('set-cookie'), null)
      }
      for (const headers of [{ 'sec-fetch-site': 'cross-site' }, { origin: 'https://other.example.test' }]) {
        assert.equal((await status(kind, challenge, cookie, headers)).status, 404)
      }
      assert.equal((await status(kind, challenge, cookie + '; ' + cookie)).status, 404)
      // Distinct store instances over the same SQLite database exercise the
      // conditional D1 write, rather than relying on a JavaScript lock.
      const replies = await Promise.all(Array.from({ length: 8 }, () => {
        if (driver === 'sqlite') globals.__browserStore = d1Store(sql.d1)
        return status(kind, challenge, cookie)
      }))
      assert.equal(replies.filter(r => r.status === 200).length, 1, 'exactly one completion can issue a session')
      assert.equal(replies.filter(r => r.status === 404).length, 7)
      assert.equal(pending.headers.get('cache-control'), 'private, no-store')
      const success = replies.find(r => r.status === 200)!
      assert.deepEqual(await success.json(), kind === 'auth' ? { status: 'ok' } : { status: 'done', name: 'browseruser' })
      const session = success.headers.getSetCookie().find(v => v.startsWith('gild_session='))!.split(';')[0].slice('gild_session='.length)
      assert.equal((await verifySessionCookie(session, secret))?.publicKey, publicKey, 'actual session HMAC verifies for the terminal key')
      assert.ok(success.headers.getSetCookie().some(v => v.startsWith('__Host-gild_' + kind + '_state=;') && v.includes('Max-Age=0')))
      assert.equal((await status(kind, challenge, cookie)).status, 404, 'proof cannot be replayed')
      if (kind === 'auth') {
        const token = await compiled.handlers.token.POST!(post('/api/tokens', proof(challenge)))
        assert.equal(token.status, 200, 'browser consumption does not delete CLI key proof')
        assert.match((await token.json()).token, /^gf_/)
      }
    } finally { sql.db.close() }
  })
  test(`${driver} ${kind}: expired and unbound legacy challenges cannot mint a browser session`, async t => {
    const sql = database(), st = driver === 'sqlite' ? sql.store : memoryStore()
    globals.__browserStore = st
    let now = Date.now(); t.mock.method(Date, 'now', () => now)
    try {
      const state = 'a'.repeat(64), hash = await browserProofHash(state), challenge = 'expired-proof'
      if (kind === 'auth') { await st.createChallenge(challenge, hash); await st.answerChallenge(challenge, publicKey, 'fixture') }
      else { await st.prepareClaim('expireduser', publicKey, 'x@example.test', challenge, hash); await st.finalizeClaim(challenge) }
      now += 10 * 60 * 1000 + 1
      const expired = await status(kind, challenge, `__Host-gild_${kind}_state=${state}`)
      assert.equal(expired.status, 404); assert.equal(expired.headers.get('set-cookie'), null)
      if (kind === 'auth') { await st.createChallenge('legacy'); await st.answerChallenge('legacy', publicKey, 'fixture') }
      else { await st.prepareClaim('legacyuser', publicKey, 'x@example.test', 'legacy'); await st.finalizeClaim('legacy') }
      assert.equal((await status(kind, 'legacy', `__Host-gild_${kind}_state=${state}`)).status, 404)
    } finally { t.mock.restoreAll(); sql.db.close() }
  })
}
test('cross-origin browser initiation is rejected; CLI challenge shape stays unchanged', async () => {
  globals.__browserStore = memoryStore()
  for (const handler of [compiled.handlers.challenge.POST!, compiled.handlers.prepare.POST!]) {
    assert.equal((await handler(post('/api/auth/challenge', {}, { origin: 'https://other.example.test', 'sec-fetch-site': 'cross-site' }))).status, 403)
  }
  const terminal = await compiled.handlers.challenge.POST!(post('/api/auth/challenge', {}))
  assert.equal(terminal.status, 200)
  assert.deepEqual(Object.keys(await terminal.json()), ['challenge'])
})
test('Worker origin marker is rewritten at ingress before OpenNext reconstructs URLs', async () => {
  const st = memoryStore()
  for (const path of ['/api/auth/challenge', '/api/auth/status', '/api/claim/prepare', '/api/claim/status']) {
    const r = new Request(origin + path, { headers: { [BROWSER_PROOF_ORIGIN]: 'https://other.example.test' } })
    await settingsHTTP(r, st, async forwarded => {
      assert.equal(forwarded.headers.get(BROWSER_PROOF_ORIGIN), origin)
      return new Response('ok')
    })
  }
  await settingsHTTP(new Request(origin + '/docs', { headers: { [BROWSER_PROOF_ORIGIN]: origin } }), st, async forwarded => {
    assert.equal(forwarded.headers.get(BROWSER_PROOF_ORIGIN), null)
    return new Response('ok')
  })
})
test.after(() => compiled.close())
