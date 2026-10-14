import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { EventStore } from './events/store.ts'
import { EventOutbox } from './events/outbox.ts'
import {
  publicAddress,
  hookURL,
  publicDestination,
  signature,
  retryDelay,
} from './events/security.ts'
import { metadataEvents, healthEvent } from './events/payloads.ts'
import { hookInput } from './api/events-contract.ts'
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
  return { db, sql, events: new EventStore(sql) }
}
test('GitHub HMAC fixture and exponential delays', async () => {
  assert.equal(
    await signature("It's a Secret to Everybody", 'Hello, World!'),
    'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
  )
  assert.deepEqual([1, 2, 3, 4, 8].map(retryDelay), [5, 10, 20, 40, 640])
})
test('SSRF: URL normalization, all DNS answers and IP families', async () => {
  for (const ip of [
    '127.0.0.1',
    '0.0.0.0',
    '10.1.2.3',
    '172.31.1.2',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.1.2',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
    '2002:7f00:1::',
  ])
    assert.equal(publicAddress(ip), false, ip)
  for (const url of [
    'http://localhost',
    'http://0177.0.0.1',
    'http://2130706433',
    'http://0x7f000001',
    'http://[::1]',
    'https://user:pass@example.com',
    'file:///etc/passwd',
    'http://host.local',
  ])
    assert.throws(() => hookURL(url), undefined, url)
  await assert.rejects(
    publicDestination(
      'https://example.com',
      async () => ['8.8.8.8', '127.0.0.1'],
      new AbortController().signal,
    ),
  )
  assert.equal(
    (
      await publicDestination(
        'https://example.com:8443/a',
        async () => ['8.8.8.8'],
        new AbortController().signal,
      )
    ).address,
    '8.8.8.8',
  )
  assert.equal(publicAddress('2606:4700:4700::1111'), true)
})
test('durable outbox survives failed send; hub dedupes a crash after acknowledgement', async () => {
  const { sql, events } = fixture(),
    outbox = new EventOutbox(sql),
    e = {
      id: 'source-1',
      event: 'push' as const,
      repository: 'acme/demo',
      payload: { ref: 'refs/heads/main' },
    }
  outbox.put(e)
  await assert.rejects(
    outbox.flush(async () => {
      events.append(e)
      throw Error('crash')
    }),
  )
  outbox.put(e)
  await outbox.flush(async (event) => events.append(event))
  outbox.put(e)
  await outbox.flush(async (event) => events.append(event))
  assert.equal(events.read(['acme/demo'], 0, 'acme').events.length, 1)
  assert.equal(
    [...sql.exec('SELECT 1 FROM event_outbox WHERE done=0')].length,
    0,
  )
})
test('cursor resume filters repositories and private agent audience without gaps', () => {
  const { events } = fixture()
  for (const [id, repository, audience] of [
    ['1', 'acme/demo', undefined],
    ['2', 'other/private', undefined],
    ['3', null, 'other'],
    ['4', null, 'acme'],
  ] as const)
    events.append({ id, event: 'issues', repository, audience, payload: {} })
  const a = events.read(['acme/demo'], 0, 'acme', 1),
    b = events.read(['acme/demo'], Number(a.cursor), 'acme')
  assert.deepEqual(
    a.events.map((e) => e.id),
    ['1'],
  )
  assert.deepEqual(
    b.events.map((e) => e.id),
    ['4'],
  )
  assert.equal(b.cursor, '4')
})
test('hook secret redacted and delivery logs capped at 100; redelivery preserves payload', () => {
  const { events, sql } = fixture(),
    h = events.create(
      'repo:acme/demo',
      hookInput.parse({
        config: { url: 'https://example.com', secret: 'fixture-secret' },
      }),
      'https://gild.gg',
    )
  assert.equal(JSON.stringify(h).includes('fixture-secret'), false)
  for (let i = 0; i < 105; i++) {
    const e = {
      id: 'e' + i,
      event: 'push' as const,
      repository: 'acme/demo',
      payload: { i },
    }
    events.append(e)
    const id = events.enqueue(h.id, e)
    sql.exec("UPDATE hook_deliveries SET state='success' WHERE id=?", id)
  }
  events.trim(h.id)
  assert.equal([...sql.exec('SELECT * FROM hook_deliveries')].length, 100)
  const d = events.deliveries(h.id)[0]
  assert.equal(typeof d.id, 'number')
  assert.ok(d.id > 0)
  assert.match(d.guid, /^[0-9a-f-]{36}$/)
  assert.equal(Number(d.request.payload.i) >= 0, true)
  assert.deepEqual(JSON.parse(d.request.wire), d.request.payload)
  assert.equal(events.deliveryGuid(d.id), d.guid)
  const next = events.enqueue(h.id, events.event('e104')!)
  assert.ok(events.viewDelivery(next).id > 105)
})
test('metadata emit points describe real changes once, and removed health rules are reported', () => {
  const item = {
      schema: 1,
      number: 1,
      title: 'A',
      body: 'B',
      author: 'acme',
      createdAt: new Date().toISOString(),
      state: 'open',
      labels: [],
      claim: null,
    },
    before = { '.gild/1/issue/issue.json': item },
    after = {
      '.gild/1/issue/issue.json': { ...item, state: 'closed', labels: ['bug'] },
      '.gild/1/issue/c-1-x.json': {
        id: 'x',
        author: 'acme',
        body: 'hello',
        createdAt: item.createdAt,
      },
    }
  const e = metadataEvents(before, after, 'acme/demo', 'acme')
  assert.deepEqual(
    e.map((e) => [e.event, e.payload.action]),
    [
      ['issues', 'closed'],
      ['issues', 'labeled'],
      ['issue_comment', 'created'],
    ],
  )
  assert.equal(metadataEvents(after, after, 'acme/demo', 'acme').length, 0)
  const prev = {
      lines: 1,
      calibrated: false,
      scores: {
        quality: 100,
        containment: 100,
        legibility: 100,
        security: 70,
        modularity: 100,
      },
      rules: [
        {
          rule: 'risk',
          category: 'security' as const,
          language: 'TypeScript',
          describes: 'Risk',
          remedy: 'fix',
          deducted: 30,
          total_findings: 1,
          findings: [],
        },
      ],
    },
    next = { ...prev, scores: { ...prev.scores, security: 100 }, rules: [] }
  const scores = healthEvent('acme/demo', 'b', 'a', next, prev).payload
    .scores as any[]
  assert.equal(scores[0].rules[0].deducted, 0)
  assert.equal(scores[0].before, 70)
  assert.equal(scores[0].after, 100)
})

test('delivery diagnostics decode chunked Unicode, interim statuses and bounded bodies', async () => {
  const { decodeResponse } = await import('./events/http.ts'),
    enc = new TextEncoder(),
    body = enc.encode('received ✓'),
    response = Buffer.concat([
      enc.encode(
        'HTTP/1.1 103 Early Hints\r\nLink: </asset>\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' +
          body.length.toString(16) +
          ';fixture=yes\r\n',
      ),
      body,
      enc.encode('\r\n0\r\n\r\n'),
    ])
  assert.equal(decodeResponse(response).body, 'received ✓')
  assert.equal(decodeResponse(response).status, 200)
  assert.equal(
    decodeResponse(enc.encode('HTTP/1.1 200 OK\r\n\r\n' + 'x'.repeat(9000)))
      .body.length,
    8192,
  )
  assert.equal(
    decodeResponse(enc.encode('HTTP/1.1 200 OK\r\n\r\n' + 'x'.repeat(9000)))
      .truncated,
    true,
  )
  assert.throws(() => decodeResponse(enc.encode('not HTTP')), /headers/)
})


test('owner runner events require owner audience access and never leak through repo access', () => {
  const f = fixture()
  f.events.append({id:'owner',event:'runner',repository:null,audience:'acme',payload:{action:'online'}})
  assert.equal(f.events.read(['acme/demo'],0,'member').events.length,0)
  assert.equal(f.events.read(['acme/demo'],0,'admin',100,['acme']).events.length,1)
  assert.equal(f.events.read(['acme/demo'],0,'',100,[]).events.length,0)
  f.db.close()
})

test('partial scans never claim a health improvement or regression', () => {
  const complete = { lines: 1, scores: { quality: 90, containment: 90, legibility: 90, security: 90, modularity: 90 }, rules: [], calibrated: false }
  const partial = { ...complete, incomplete: 'c-family-unavailable' as const, scores: { ...complete.scores, security: 100 } }
  assert.deepEqual(healthEvent('acme/demo', 'b', 'a', partial, complete).payload.scores, [])
  assert.deepEqual(healthEvent('acme/demo', 'b', 'a', complete, partial).payload.scores, [])
})
