import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workerStages } from './worker-stages.ts'

test('every Worker stage a request passes through is timed, then the answering stage and the total', async () => {
  let clock = 0
  const s = workerStages(() => clock)
  clock = 2; s.mark('entry')
  clock = 40; s.mark('published-page')
  clock = 340; s.mark('privacy')
  clock = 501
  const out = s.annotate(new Response('x', { status: 203, headers: { 'server-timing': 'index;dur=154, total;dur=161', 'x-a': '1' } }), 'app')
  assert.equal(out.status, 203)
  assert.equal(out.headers.get('x-a'), '1')
  assert.equal(await out.text(), 'x')
  assert.equal(out.headers.get('server-timing'),
    'index;dur=154, total;dur=161, w-entry;dur=2.0, w-published-page;dur=38.0, w-privacy;dur=300.0, w-app;dur=161.0, w-total;dur=501.0')
})
