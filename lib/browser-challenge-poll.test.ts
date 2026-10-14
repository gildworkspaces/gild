import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pollBrowserChallenge } from './browser-challenge-poll.ts'
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

test('terminal 404 stops polling and offers recovery exactly once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0, expired = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('', { status: 404 }) })
  const stop = pollBrowserChallenge('/api/auth/status?challenge=old', () => assert.fail('expired flow must not complete'), () => expired++)
  try {
    t.mock.timers.tick(1500); await flush()
    assert.equal(expired, 1, 'terminal 404 must offer recovery')
    t.mock.timers.tick(60000); await flush()
    assert.equal(calls, 1, 'expired flow must stop polling')
  } finally { stop(); t.mock.restoreAll() }
})

test('polls never overlap and completion cancels future requests', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0, completed = 0, reply!: (response: Response) => void
  t.mock.method(globalThis, 'fetch', () => { calls++; return new Promise<Response>(resolve => { reply = resolve }) })
  const stop = pollBrowserChallenge('/api/claim/status?challenge=current', () => completed++, () => assert.fail('valid flow must not expire'))
  try {
    t.mock.timers.tick(1500); await flush()
    t.mock.timers.tick(30000); await flush()
    assert.equal(calls, 1, 'pending request must not overlap another poll')
    reply(Response.json({ status: 'pending' })); await flush()
    t.mock.timers.tick(1500); await flush()
    assert.equal(calls, 2)
    reply(Response.json({ status: 'done', name: 'fixture' })); await flush()
    assert.equal(completed, 1)
    t.mock.timers.tick(30000); await flush()
    assert.equal(calls, 2)
  } finally { stop(); t.mock.restoreAll() }
})

test('transient failures retry but cleanup suppresses a late completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0, reply!: (response: Response) => void
  t.mock.method(globalThis, 'fetch', () => {
    calls++
    return calls === 1 ? Promise.reject(Error('transport')) : new Promise<Response>(resolve => { reply = resolve })
  })
  const stop = pollBrowserChallenge('/api/auth/status?challenge=current', () => assert.fail('unmounted flow must not complete'), () => assert.fail('transport failure must not expire'))
  try {
    t.mock.timers.tick(1500); await flush()
    t.mock.timers.tick(1500); await flush()
    assert.equal(calls, 2)
    stop(); reply(Response.json({ status: 'ok' })); await flush()
    t.mock.timers.tick(30000); await flush()
    assert.equal(calls, 2)
  } finally { stop(); t.mock.restoreAll() }
})
