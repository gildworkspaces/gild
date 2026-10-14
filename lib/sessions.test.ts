import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { SessionStore } from './sessions/store.ts'
import {
  receiptPayload,
  receiptSchema,
  sessionInput,
} from './api/sessions-contract.ts'
import { sessionHandler } from './api/sessions.ts'
import { routes } from './api/contract.ts'
import type { Index } from './api/indexed.ts'
import type { Context } from './api/dispatch.ts'
const fixture = () => {
  const db = new DatabaseSync(':memory:')
  const sql = {
    exec: (q: string, ...args: any[]) => {
      if (!args.length && q.includes(';')) {
        db.exec(q)
        return []
      }
      return db.prepare(q).all(...args) as any
    },
  }
  return { db, store: new SessionStore(sql) }
}
const draft = () =>
  receiptSchema.parse({
    id: randomUUID(),
    agent: 'acme/bot',
    repository: 'acme/demo',
    target: 'pull:1',
    started_at: '2026-10-08T01:00:00Z',
    model: 'any-harness',
    created_at: '2026-10-08T01:00:00Z',
    updated_at: '2026-10-08T01:00:00Z',
    version: 1,
    closed: false,
    reported_by: 'agent',
  })
test('closed receipts cannot be altered, even with a matching revision', () => {
  const { store } = fixture(),
    a = draft()
  store.put(a, 0)
  const closed = {
    ...a,
    version: 2,
    closed: true,
    ended_at: '2026-10-08T01:01:00Z',
  }
  store.put(closed, 1)
  assert.throws(
    () => store.put({ ...closed, version: 3, notes: 'tamper' }, 2),
    /immutable/,
  )
  assert.deepEqual(store.get(a.id), closed)
})
test('receipt ownership, target and stale concurrent revisions are enforced', () => {
  const { store } = fixture(),
    a = draft()
  store.put(a, 0)
  assert.throws(
    () => store.put({ ...a, agent: 'acme/other', version: 2 }, 1),
    /original agent/,
  )
  assert.throws(
    () => store.put({ ...a, target: 'pull:2', version: 2 }, 1),
    /target/,
  )
  store.put({ ...a, version: 2, notes: 'winner' }, 1)
  assert.throws(
    () => store.put({ ...a, version: 2, notes: 'loser' }, 1),
    /changed/,
  )
  assert.equal(store.get(a.id)?.notes, 'winner')
})
test('receipt collections remain mutable and paged across index recreation', () => {
  const { store, db } = fixture()
  for (let i = 0; i < 3; i++) store.put(draft(), 0)
  const reopened = new SessionStore({
    exec: (q: string, ...args: any[]) => {
      if (!args.length && q.includes(';')) {
        db.exec(q)
        return []
      }
      return db.prepare(q).all(...args) as any
    },
  })
  assert.equal(reopened.list('pull:1', 1, 0).total, 3)
  assert.notEqual(
    reopened.list('pull:1', 1, 0).receipts[0].id,
    reopened.list('pull:1', 1, 1).receipts[0].id,
  )
})
test('session input validates dates, paths, usage and command outcomes', () => {
  const a = { started_at: '2026-10-08T01:00:00Z', model: 'model' }
  assert.equal(sessionInput.parse(a).ended_at, null)
  assert.equal(
    sessionInput.safeParse({ ...a, ended_at: '2026-10-07T01:00:00Z' }).success,
    false,
  )
  assert.equal(
    sessionInput.safeParse({
      ...a,
      files: { read: ['../secret'], written: [] },
    }).success,
    false,
  )
  assert.equal(sessionInput.safeParse({ ...a, tokens_in: -1 }).success, false)
})
test('agent attribution omits token proof and lookup hashes; spoofed agent/human are rejected', async () => {
  const { store } = fixture(),
    token = 'gf_generated_test_only',
    index = {
      metaItem: async () => ({ item: {} }),
      sessionGet: async (id: string) => store.get(id),
      sessionPut: async (data: ReturnType<typeof draft>, version: number) =>
        store.put(data, version),
    } as unknown as Index,
    c: Context = {
      request: new Request(
        'https://gild.gg/api/v1/repos/acme/demo/pulls/1/sessions',
        { method: 'POST', headers: { authorization: 'Bearer ' + token } },
      ),
      route: routes.find((r) => r.id === 'createPullSession')!,
      params: { owner: 'acme', repo: 'demo', number: '1' },
      query: {},
      body: {
        started_at: '2026-10-08T01:00:00Z',
        ended_at: '2026-10-08T01:01:00Z',
        model: 'model',
        commands: [{ name: 'false', exit_code: 1, duration_ms: 50 }],
      },
      principal: {
        id: 'fingerprint',
        name: 'acme/bot',
        publicKey: 'public',
        scopes: ['pulls:write'],
        repos: ['acme/demo'],
      },
    }
  const response = (await sessionHandler(c, index)).data as any
  assert.equal('token_fingerprint' in response, false)
  assert.equal('signature' in response, false)
  const r = receiptSchema.parse(response)
  assert.equal(r.reported_by, 'agent')
  for (const field of ['signature', 'token_fingerprint', 'public_key']) assert.equal(field in r, false)
  assert.equal(JSON.stringify(r).includes(token), false)
  assert.equal(JSON.stringify(r).includes('fingerprint'), false)
  assert.equal(r.commands[0].exit_code, 1)
  await assert.rejects(
    sessionHandler({ ...c, body: { ...c.body, agent: 'other/bot' } }, index),
    /match/,
  )
  await assert.rejects(
    sessionHandler(
      { ...c, principal: { ...c.principal, name: 'acme' } },
      index,
    ),
    /agent token/,
  )
})

test('secrets are redacted and long commands capped before session SQL storage', () => {
  const {store, db} = fixture()
  const credentials = [
    'gf_0123456789abcdef0123456789abcdef', 'gr_0123456789abcdef0123456789abcdef',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'github_pat_abcdefghijklmnopqrstuvwxyz0123456789',
    'AKIA0123456789ABCDEF', 'ASIA0123456789ABCDEF',
    'R4nD0mCloudflareToken8abcdefghijKLMNopqXYZ',
    'a9f3c1d7e2b40685a9f3c1d7e2b40685',
  ]
  const a = draft(), value = credentials.join(' ') + ' API_KEY="short-value"'
  store.put({...a, commands:[{name:'curl '+value,exit_code:0,duration_ms:1},{name:'echo '+ 'long '.repeat(800),exit_code:0,duration_ms:1}],notes:value},0)
  const stored = db.prepare('SELECT json FROM session_receipts WHERE id=?').get(a.id)!.json as string
  for (const credential of [...credentials,'short-value']) assert.equal(stored.includes(credential),false,credential)
  const r = store.get(a.id)!
  assert.ok(r.commands[1].name.length <= 1024)
  assert.match(r.commands[1].name,/truncated/)
  assert.match(r.notes,/redacted/)
})
test('one agent cannot exhaust the target cap and may still revise its existing report', () => {
  const {store} = fixture()
  let last = draft()
  for(let i=0;i<100;i++){last=draft();store.put(last,0)}
  assert.throws(()=>store.put(draft(),0),/per agent/)
  assert.equal(store.list('pull:1').total,100)
  store.put({...last,version:2,notes:'revised'},1)
  store.put({...draft(),agent:'acme/other'},0)
  assert.equal(store.list('pull:1').total,101)
})
test('server receipt reads check repo visibility before loading reports', async () => {
  const {readSessionReceipts} = await import('./sessions/read-access.ts')
  let reads=0
  const s:any={store:{orgRole:async()=>null},index:async()=>({metaFile:async()=>'{"visibility":"private"}',sessionList:async()=>{reads++;return {receipts:[draft()]}}})}
  assert.deepEqual(await readSessionReceipts(s,'acme','demo','pull:1',null),[])
  assert.deepEqual(await readSessionReceipts(s,'acme','demo','pull:1','outsider'),[])
  assert.equal(reads,0)
  assert.equal((await readSessionReceipts(s,'acme','demo','pull:1','acme')).length,1)
  assert.equal(reads,1)
})

test('live state persists, coexists with old receipts and forbids private payload fields', async () => {
  const { store } = fixture()
  const index = {
    metaItem: async () => ({ item: {} }),
    sessionGet: async (id: string) => store.get(id),
    sessionPut: async (data: ReturnType<typeof draft>, version: number) => store.put(data, version),
  } as unknown as Index
  const context = {
    route: routes.find(r => r.id === 'createPullSession')!,
    params: { owner: 'acme', repo: 'demo', number: '1' }, query: {},
    principal: { name: 'acme/bot' },
  } as unknown as Context
  const input = { id: randomUUID(), started_at: '2026-10-08T01:00:00Z', model: 'claude' }
  for (const status of ['busy', 'idle', 'waiting', 'tool_start', 'tool_end', 'ended'] as const) {
    const state = { status, ...(status === 'tool_start' ? { tool: 'Edit' } : {}), last_activity: '2026-10-08T01:01:00Z' }
    const body = { ...input, state, ...(status === 'ended' ? { ended_at: state.last_activity } : {}) }
    await sessionHandler({ ...context, body }, index)
    assert.deepEqual(store.get(input.id)?.state, state)
    assert.equal(store.get(input.id)?.closed, status === 'ended')
  }
  const old = draft(); store.put(old, 0)
  assert.equal(store.get(old.id)?.state, undefined)
  for (const extra of [{ text: 'prompt' }, { raw: { arguments: 'private' } }, { tool: 'Bash secret args' }]) {
    assert.equal(sessionInput.safeParse({ ...input, state: { status: 'busy', last_activity: '2026-10-08T01:01:00Z', ...extra } }).success, false)
  }
})
