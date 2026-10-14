import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import type { D1Database } from '@cloudflare/workers-types'
import { d1Store } from './drivers/d1.ts'
import { repoAccess } from './repo-read.ts'
import { purgeDeleted, type LifecycleTransport } from './settings.ts'
import { account, setAccount, restoreAccount, accountLifecycle, accountGate, accountOperation, TRIAL_MS, ACCOUNT_RETENTION_MS, DAY_MS } from './accounts.ts'

function database() {
  const db = new DatabaseSync(':memory:')
  for (const f of readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + f, 'utf8'))
  const statement = (sql: string, values: unknown[] = []) => ({
    sql, values,
    bind: (...args: unknown[]) => statement(sql, args),
    async first() { return db.prepare(sql).get(...(values as never[])) ?? null },
    async all() { return { results: db.prepare(sql).all(...(values as never[])), success: true, meta: {} } },
    async run() { return { results: [], success: true, meta: { changes: Number(db.prepare(sql).run(...(values as never[])).changes) } } },
  })
  const d1 = {
    prepare: (sql: string) => statement(sql),
    async batch(list: ReturnType<typeof statement>[]) {
      return list.map(s => /^\s*(SELECT|WITH)/i.test(s.sql)
        ? { results: db.prepare(s.sql).all(...(s.values as never[])), success: true, meta: {} }
        : { results: [], success: true, meta: { changes: Number(db.prepare(s.sql).run(...(s.values as never[])).changes) } })
    },
  } as unknown as D1Database
  return { db, d1, st: d1Store(d1) }
}

/** An account with a claim, a token, an agent, a star, an org membership and one public repository. */
function seed(db: DatabaseSync) {
  db.exec(`
    INSERT INTO claims(name,public_key,email,claimed_at) VALUES ('sam','ed25519:k','s@example.com','2026-10-01');
    INSERT INTO api_tokens(token_hash,name,public_key,created_at,expires_at) VALUES ('t1','sam','k',1,9999999999999),('t2','sam/bot','k',1,9999999999999),('t3','other','k',1,9999999999999);
    INSERT INTO agents(name,sponsor,label,created_at) VALUES ('sam/bot','sam','bot','2026-10-01');
    INSERT INTO stars(repo,name,created_at) VALUES ('x/y','sam','2026-10-01');
    INSERT INTO orgs(name,created_by,created_at) VALUES ('team','other','2026-10-01');
    INSERT INTO org_members(org,member,role,added_at) VALUES ('team','sam','member','2026-10-01'),('team','other','owner','2026-10-01');
    INSERT INTO settings_entities(key,id) VALUES ('sam/code','repo-1');
    INSERT INTO repo_access(id,meta,acl,pending) VALUES ('repo-1','m','{"schema":1,"visibility":"public"}',0)`)
}
const visible = async (st: ReturnType<typeof d1Store>) => !!(await repoAccess({ store: st, index: async () => null } as never, 'sam', 'code'))
const gate = (d1: D1Database, name: string, method: string, params: Record<string, string> = {}, id = 'createIssue') =>
  accountGate(n => account(d1, n), { id: 'p', name }, { id }, params, method)

test('a trial has full access for 30 days, then is read-only for everyone for 30 more, then is purged', async () => {
  const { db, d1, st } = database(); seed(db)
  const t0 = Date.UTC(2026, 9, 1)
  await setAccount(d1, st, 'sam', 'trial', { by: 'admin', now: t0 })
  assert.equal((await account(d1, 'sam')).trialEndsAt, t0 + TRIAL_MS)
  assert.equal(await gate(d1, 'sam', 'POST', { owner: 'sam', repo: 'code' }), null, 'trial writes')

  assert.deepEqual(await accountLifecycle(d1, st, t0 + TRIAL_MS - 1), { trialsEnded: [], unpaidExpired: [] })
  assert.deepEqual(await accountLifecycle(d1, st, t0 + TRIAL_MS), { trialsEnded: ['sam'], unpaidExpired: [] })
  const unpaid = await account(d1, 'sam')
  assert.equal(unpaid.status, 'unpaid')
  assert.equal(unpaid.deleteAfter, t0 + TRIAL_MS + ACCOUNT_RETENTION_MS)
  // Read-only for all: reads pass, writes by the owner or anyone else are 402.
  assert.equal(await visible(st), true)
  assert.equal(await gate(d1, 'sam', 'GET', { owner: 'sam', repo: 'code' }), null)
  assert.equal((await gate(d1, 'sam', 'POST', { owner: 'sam', repo: 'code' }))?.status, 402)
  assert.equal((await gate(d1, 'sam/bot', 'POST', {}))?.status, 402, "the account's agents")
  assert.equal((await gate(d1, 'other', 'POST', { owner: 'sam', repo: 'code' }))?.status, 402, 'a collaborator writing to it')
  assert.equal(await gate(d1, 'other', 'POST', { owner: 'other', repo: 'mine' }), null, 'other accounts are untouched')

  // Day 60: deleted and purged on the same cron run.
  const end = t0 + TRIAL_MS + ACCOUNT_RETENTION_MS
  assert.deepEqual(await accountLifecycle(d1, st, end), { trialsEnded: [], unpaidExpired: ['sam'] })
  assert.equal(await visible(st), false, 'hidden at once')
  const purged: string[] = []
  const transport = { discard: async () => {}, purge: async (key: string) => { purged.push(key) } } as unknown as LifecycleTransport
  await purgeDeleted(st, transport, end)
  assert.deepEqual(purged.sort(), ['sam', 'sam/code'])
  const left = (sql: string) => db.prepare(sql).all().length
  assert.equal(left("SELECT 1 FROM owner_names WHERE name='sam'"), 0, 'the name is free again')
  assert.equal(left("SELECT 1 FROM claims WHERE name='sam'"), 0)
  assert.equal(left("SELECT 1 FROM api_tokens WHERE name IN ('sam','sam/bot')"), 0)
  assert.equal(left("SELECT 1 FROM agents WHERE sponsor='sam'"), 0)
  assert.equal(left("SELECT 1 FROM stars WHERE name='sam'"), 0)
  assert.equal(left("SELECT 1 FROM org_members WHERE member='sam'"), 0)
  assert.equal(left("SELECT 1 FROM accounts WHERE name='sam'"), 0)
  assert.equal(left("SELECT 1 FROM settings_entities WHERE key LIKE 'sam%'"), 0)
  assert.equal(left("SELECT 1 FROM api_tokens WHERE name='other'"), 1, 'others keep their tokens')
  assert.equal(left("SELECT 1 FROM org_members WHERE org='team'"), 1, 'the org keeps its other members')
})

test('a user deletes their account: hidden at once, restorable for 30 days, then purged', async () => {
  const { db, d1, st } = database(); seed(db)
  const t0 = Date.UTC(2026, 9, 1)
  const c = (id: string, body: Record<string, unknown> = {}, name = 'sam') =>
    accountOperation({ route: { id }, params: {}, body, principal: { name } }, { db: d1, store: st }, (s, m) => { throw Object.assign(new Error(m), { status: s }) })
  await assert.rejects(c('deleteAccount', { confirm: 'wrong' }), /Type sam to confirm/)
  const deleted = await c('deleteAccount', { confirm: 'sam' })
  assert.equal(deleted.status, 'deleted')
  assert.equal(await visible(st), false)
  assert.equal((await gate(d1, 'sam', 'GET', { owner: 'x', repo: 'y' }))?.status, 403, 'a deleted caller is refused everything')
  assert.equal(await gate(d1, 'sam', 'POST', {}, 'restoreAccount'), null, 'except restoring')
  assert.equal((await c('restoreAccount')).status, 'active')
  assert.equal(await visible(st), true)

  // Past the window, restore is refused and the purge takes it.
  await setAccount(d1, st, 'sam', 'deleted', { by: 'sam', now: t0 })
  await assert.rejects(restoreAccount(d1, st, 'sam', 'sam', t0 + ACCOUNT_RETENTION_MS), /restore window/)
  const purged: string[] = []
  await purgeDeleted(st, { discard: async () => {}, purge: async (k: string) => { purged.push(k) } } as unknown as LifecycleTransport, t0 + ACCOUNT_RETENTION_MS)
  assert.ok(purged.includes('sam/code'))
})

test('a restored trial ends when it would have; an agent never manages an account', async () => {
  const { db, d1, st } = database(); seed(db)
  const t0 = Date.UTC(2026, 9, 1)
  await setAccount(d1, st, 'sam', 'trial', { by: 'admin', now: t0 })
  await setAccount(d1, st, 'sam', 'deleted', { by: 'sam', now: t0 + 5 * DAY_MS })
  assert.equal((await restoreAccount(d1, st, 'sam', 'sam', t0 + 6 * DAY_MS)).trialEndsAt, t0 + TRIAL_MS)
  await assert.rejects(accountOperation({ route: { id: 'account' }, params: {}, body: {}, principal: { name: 'sam/bot' } }, { db: d1, store: st }, (s, m) => { throw new Error(`${s} ${m}`) }), /403/)
})

test('only a site admin sets another account\'s status', async () => {
  const { db, d1, st } = database(); seed(db)
  const set = (name: string) => accountOperation({ route: { id: 'setAccount' }, params: { name: 'sam' }, body: { status: 'unpaid' }, principal: { name } }, { db: d1, store: st }, (s, m) => { throw new Error(`${s} ${m}`) })
  await assert.rejects(set('other'), /404/)
  db.exec("INSERT INTO site_admins(name) VALUES ('boss')")
  assert.equal((await set('boss')).status, 'unpaid')
  assert.equal((await set('boss')).writable, false)
})
