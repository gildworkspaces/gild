import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publicMutation } from './public-mutation.ts'

const request = (path: string, method = 'POST') => new Request('https://gild.test' + path, { method })
test('authentication-only challenge, answer and signout skip public invalidation and publication decisions', () => {
  for (const path of ['/api/auth/challenge', '/api/auth/answer', '/api/auth/signout'])
    for (const suffix of ['', '/', '?challenge=private'])
      assert.equal(publicMutation(request(path + suffix)), false, path + suffix)
})
test('auth exclusion is exact and POST-only; claims, revocation, unknown writes and content still invalidate', () => {
  for (const path of ['/api/auth/revoke-agent', '/api/auth/answer/content', '/api/auth/answer-extra', '/api/v1/auth/answer', '/api/claim/answer', '/api/agents/requests', '/api/account/profile'])
    assert.equal(publicMutation(request(path)), true, path)
  for (const method of ['DELETE', 'PATCH', 'PUT'])
    assert.equal(publicMutation(request('/api/auth/challenge', method)), true, method)
})
test('runner transport and import progress do not invalidate public grants or enqueue pages', () => {
  for (const prefix of ['/api/v1', '/api']) {
    for (const operation of ['poll', 'heartbeat', 'logs', 'step'])
      assert.equal(publicMutation(request(`${prefix}/repos/owner/repo/actions/runners/${operation}`)), false)
    for (const operation of ['claim', 'credentials', 'heartbeat'])
      assert.equal(publicMutation(request(`${prefix}/repos/owner/repo/import/${operation}`)), false)
    assert.equal(publicMutation(request(`${prefix}/users/owner/imports/poll`)), false)
    assert.equal(publicMutation(request(`${prefix}/orgs/owner/actions/runners/poll`)), false)
  }
  assert.equal(publicMutation(request('/owner/repo.git/git-upload-pack')), false)
})
test('access revocations, content writes and completed runs retain immediate publication', () => {
  for (const [method, path] of [
    ['PATCH', '/api/v1/repos/owner/repo/visibility'],
    ['DELETE', '/api/v1/repos/owner/repo'],
    ['DELETE', '/api/v1/orgs/owner'],
    ['DELETE', '/api/v1/repos/owner/repo/collaborators/user'],
    ['POST', '/api/repos/owner/repo/issues/1'],
    ['POST', '/api/v1/repos/owner/repo/import/finish'],
    ['POST', '/api/v1/repos/owner/repo/actions/runners/finish'],
    ['POST', '/owner/repo.git/git-receive-pack'],
  ]) assert.equal(publicMutation(request(path, method)), true, method + ' ' + path)
  assert.equal(publicMutation(request('/api/v1/repos/owner/repo', 'GET')), false)
})
