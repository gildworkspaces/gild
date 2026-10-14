import { test } from 'node:test'
import assert from 'node:assert/strict'
import { csrfSafe } from './csrf.ts'
const call = (url: string, headers: Record<string, string>) => new Request(url, { method: 'POST', headers })
test('raw ingress CSRF ignores caller-supplied trusted-origin markers', () => {
  assert.equal(csrfSafe(call('https://gild.gg/api/auth/signout', { origin: 'https://other.test', 'x-gild-browser-proof-origin': 'https://other.test', 'sec-fetch-site': 'same-origin' })), false)
  assert.equal(csrfSafe(call('https://gild.gg/api/auth/signout', { origin: 'https://gild.gg', 'x-gild-browser-proof-origin': 'https://other.test', 'sec-fetch-site': 'same-origin' })), true)
})
test('signout after trusted ingress preserves original origin across OpenNext URL reconstruction', () => {
  const request = call('http://open-next.internal/api/auth/signout', { origin: 'https://gild.gg', 'x-gild-browser-proof-origin': 'https://gild.gg', 'sec-fetch-site': 'same-origin' })
  assert.equal(csrfSafe(request), false)
  assert.equal(csrfSafe(request, { trustWorkerOrigin: true }), true)
  for (const headers of [
    { origin: 'https://other.test', 'x-gild-browser-proof-origin': 'https://gild.gg' },
    { origin: 'https://gild.gg', 'x-gild-browser-proof-origin': 'https://gild.gg', 'sec-fetch-site': 'cross-site' },
    { 'x-gild-browser-proof-origin': 'https://gild.gg' },
  ]) assert.equal(csrfSafe(call(request.url, headers), { trustWorkerOrigin: true }), false)
})
