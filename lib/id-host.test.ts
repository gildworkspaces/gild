import test from 'node:test'
import assert from 'node:assert/strict'
import { hostRedirect } from './id-host.ts'

const go = (url: string, method = 'GET') => hostRedirect(new Request(url, { method }), 'https://gild.gg')

test('account, security and billing pages move to id.gild.gg', () => {
  assert.equal(go('https://gild.gg/auth/device?next=%2Fa%2Fb'), 'https://id.gild.gg/auth/device?next=%2Fa%2Fb')
  assert.equal(go('https://gild.gg/settings'), 'https://id.gild.gg/settings')
  assert.equal(go('https://gild.gg/settings/billing?repo=x'), 'https://id.gild.gg/settings/billing?repo=x')
  assert.equal(go('https://gild.gg/orgs/acme/settings/billing'), 'https://id.gild.gg/orgs/acme/settings/billing')
  assert.equal(go('https://gild.gg/keys'), 'https://id.gild.gg/keys')
})

test('repository management stays on gild.gg', () => {
  for (const path of ['/', '/acme/repo', '/settings/agents', '/settings/runners', '/orgs/acme/settings/general', '/explore'])
    assert.equal(go('https://gild.gg' + path), null)
  assert.equal(go('https://id.gild.gg/acme/repo?tab=x'), 'https://gild.gg/acme/repo?tab=x')
  assert.equal(go('https://id.gild.gg/settings/runners'), 'https://gild.gg/settings/runners')
  assert.equal(go('https://id.gild.gg/'), 'https://gild.gg/')
})

test('id.gild.gg serves its own pages, assets and APIs; writes never redirect', () => {
  for (const path of ['/settings/profile', '/auth/claim', '/api/auth/status', '/_next/static/x.js', '/favicon.svg', '/gild-fragments/v/router.js', '/brand/gild-mark.svg'])
    assert.equal(go('https://id.gild.gg' + path), null)
  assert.equal(go('https://gild.gg/api/auth/challenge'), null)
  assert.equal(go('https://gild.gg/settings/billing', 'POST'), null)
  assert.equal(hostRedirect(new Request('http://localhost:3000/settings/billing'), 'https://gild.gg'), null)
})
