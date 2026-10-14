import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contributorPath } from './privacy-http.ts'
import { mayContribute, type ReadServices } from './repo-read.ts'

const at = (path: string) => contributorPath(new URL(path, 'https://gild.gg'))

test('Actions, Agents and Score are contributor sections, on pages and every API', () => {
  for (const path of [
    '/acme/demo/actions', '/acme/demo/actions/runs/3', '/acme/demo/agents', '/acme/demo/agents/package', '/acme/demo/score',
    '/api/v1/repos/acme/demo/actions/runs', '/api/v1/repos/acme/demo/actions/runs/3/logs', '/api/v1/repos/acme/demo/health',
    '/api/v1/repos/acme/demo/health/abc', '/api/v1/repos/acme/demo/channel/messages', '/api/v1/repos/acme/demo/channel/stream',
    '/api/v1/repos/acme/demo/agents', '/api/v1/repos/acme/demo/pulls/1/sessions', '/api/v1/repos/acme/demo/commits/abc/sessions',
    '/api/repos/acme/demo/actions', '/api/repos/acme/demo/orchestrators', '/api/repos/acme/demo/agent-package',
    '/api/repos/acme/demo/islands?channel=1', '/api/fragments/acme/demo?page=score',
    '/api/v1/repos/acme/demo/collaborators', '/api/repos/acme/demo/collaborators',
  ]) assert.equal(at(path), true, path)
  for (const path of [
    '/acme/demo', '/acme/demo/issues', '/acme/demo/pulls/1', '/api/v1/repos/acme/demo/issues', '/api/v1/repos/acme/demo/pulls/1',
    '/api/repos/acme/demo/islands', '/api/fragments/acme/demo?page=home', '/acme', '/agents', '/settings/agents',
  ]) assert.equal(at(path), false, path)
})

const services = (acl: object, orgs: Record<string, string> = {}): ReadServices => ({
  store: { orgRole: async (_org: string, member: string) => orgs[member] ?? null, getRepoAccess: async () => ({ meta: null, acl, pending: false }), settings: { state: async (k: string) => ({ id: k }) } } as never,
  index: async () => null,
})

test('contributors: the owner, org members and ACL names; never anonymous or outsiders, on a public repository', async () => {
  const acl = { schema: 1, visibility: 'public', write: ['@writer'], read: ['@reader'], agents: { '@sami/bob': [] } }
  const s = services(acl, { member: 'member' })
  for (const name of ['acme', 'member', 'writer', 'reader', 'sami/bob'])
    assert.equal(await mayContribute(s, 'acme', 'demo', name, { meta: null, acl, pending: false } as never), true, name)
  for (const name of [null, 'outsider', 'sami/eve'])
    assert.equal(await mayContribute(s, 'acme', 'demo', name, { meta: null, acl, pending: false } as never), false, String(name))
})

test('a contributor section is never wider than reading the repository: a private repository agent still needs grants', async () => {
  const acl = { schema: 1, visibility: 'private', agents: { '@acme/empty': [], '@acme/granted': ['pr'] } }
  const s = services(acl)
  assert.equal(await mayContribute(s, 'acme', 'secret', 'acme/empty', { meta: null, acl, pending: false } as never), false)
  assert.equal(await mayContribute(s, 'acme', 'secret', 'acme/granted', { meta: null, acl, pending: false } as never), true)
})
