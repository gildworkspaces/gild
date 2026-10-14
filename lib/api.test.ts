import { z } from 'zod'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { IndexStore } from './repo-index-store.ts'
import { dispatch, match, paginate, type Context } from './api/dispatch.ts'
import { routes } from './api/contract.ts'
import { openapi } from './api/openapi.ts'
import { SCOPES, hasScope, grantScopes, permitsRepo } from './api/scopes.ts'
import { memoryStore } from './drivers/memory.ts'
import { csrfSafe } from './csrf.ts'
const principal = {
  id: 'token',
  name: 'acme',
  publicKey: 'fixture',
  scopes: null,
  repos: null,
}
test('every declaration maps to a callable path and OpenAPI operation', () => {
  const spec = openapi()
  for (const r of routes) {
    const path = r.path.replace(/\{(\w+)\}/g, (_, name) =>
      name === 'path'
        ? 'src/a.ts'
        : name === 'ref'
          ? 'heads/main'
          : ['number', 'run', 'job'].includes(name)
            ? '1'
            : 'value',
    )
    assert.equal(match(r.method, path)?.route.id, r.id)
    assert.equal(
      (spec.paths[r.path][r.method.toLowerCase()] as { operationId: string })
        .operationId,
      r.id,
    )
  }
  assert.equal(spec.openapi, '3.1.0')
})
// Required request fields come from the same declarations as OpenAPI.
// Allowed matrix cases must reach execution, rather than merely fail input
// validation with a status other than 403.
function validInput(schema: Record<string, any>): any {
  if (schema.default !== undefined) return schema.default
  if (schema.const !== undefined) return schema.const
  if (schema.enum) return schema.enum[0]
  if (schema.anyOf) return validInput(schema.anyOf[0])
  if (schema.type === 'object')
    return Object.fromEntries(
      (schema.required ?? []).map((key: string) => [
        key,
        validInput(schema.properties[key]),
      ]),
    )
  if (schema.type === 'array')
    return Array.from({ length: schema.minItems ?? 0 }, () =>
      validInput(schema.items),
    )
  if (schema.type === 'integer' || schema.type === 'number')
    return Math.max(schema.minimum ?? 0, 1)
  if (schema.type === 'boolean') return false
  if (schema.type === 'null') return null
  if (['datetime', 'date-time'].includes(schema.format))
    return '2026-10-08T00:00:00Z'
  if (schema.format === 'uuid') return '8db9d173-28b2-4f72-987a-cc8e18bf5d13'
  if (schema.format === 'uri') return 'https://example.com'
  if (schema.pattern?.includes('\\d') || schema.pattern?.includes('[0-9]'))
    return '1'
  if (schema.pattern?.includes('{40}')) return 'a'.repeat(40)
  return 'fixture'.padEnd(schema.minLength ?? 1, 'a')
}
test('every scope x route is enforced before executing a handler', async () => {
  let calls = 0
  for (const route of routes.filter((r) => r.scope))
    for (const scope of SCOPES) {
      const params = validInput(z.toJSONSchema(route.params)),
        path = route.path.replace(/\{(\w+)\}/g, (_, key) =>
          String(params[key]),
        ),
        allowed = scope === route.scope
      const response = await dispatch(
        new Request(
          'http://local/api/v1' +
            path +
            '?' +
            new URLSearchParams(validInput(z.toJSONSchema(route.query))),
          {
            method: route.method,
            body: route.method === 'GET'
              ? undefined
              : JSON.stringify(route.id === 'updateRepository' ? {description: 'fixture'} : validInput(z.toJSONSchema(route.input))),
          },
        ),
        {
          authenticate: async () => ({ ...principal, scopes: [scope] }),
          control: async () =>
            ({
              rate: async () => ({
                limit: 10000,
                remaining: 9999,
                reset: 100000,
                allowed: true,
              }),
              begin: async () => ({ kind: 'new' }),
              finish: async () => {},
              release: async () => {},
            }) as any,
          authorize: async () => {},
          execute: async () => {
            calls++
            throw new Error('Only allowed calls can reach this')
          },
        },
      )
      if (allowed)
        assert.equal(
          response.status,
          500,
          `${route.id} allowed scope must reach execution: ${await response.clone().text()}`,
        )
      assert.equal(
        response.status === 403,
        !allowed,
        `${scope} ${route.id}: ${response.status}`,
      )
    }
  assert.equal(calls, routes.filter((r) => r.scope).length)
})
test('full-scope migration, explicit scopes and repo allow-list', async () => {
  const store = memoryStore()
  await store.saveApiToken('legacy', 'acme', 'key', Date.now() + 1000)
  const token = await store.getApiToken('legacy')
  assert.equal(token!.scopes, null)
  assert.ok(
    SCOPES.every((scope) =>
      hasScope({ ...principal, scopes: token!.scopes }, scope),
    ),
  )
  const p = { ...principal, scopes: ['repo:read'], repos: ['acme/demo'] }
  assert.ok(permitsRepo(p, 'ACME', 'demo'))
  assert.ok(!permitsRepo(p, 'acme', 'other'))
  assert.ok(!hasScope(p, 'repo:write'))
  await store.saveApiToken('new', 'acme', 'key', Date.now() + 1000, {
    scopes: ['repo:read'],
    repos: ['acme/demo'],
  })
  assert.deepEqual((await store.getApiToken('new'))!.scopes, ['repo:read'])
  assert.ok(!(await store.deleteApiToken('other', 'new')))
  assert.ok(await store.deleteApiToken('acme', 'new'))
  assert.equal(await store.getApiToken('new'), null)
})
test('agent grant cap cannot authorize hooks, actions, admin or agents', () => {
  assert.deepEqual(grantScopes([]), ['repo:read', 'channel:write'])
  assert.deepEqual(grantScopes(['pr']), [
    'repo:read',
    'channel:write',
    'repo:write',
    'issues:write',
    'pulls:write',
  ])
  assert.ok(!grantScopes(['pr', 'review', 'queue']).includes('admin'))
})
test('a review-only agent can answer in its channel but not write the repo', () => {
  const scopes = grantScopes(['review'])
  assert.ok(scopes.includes('channel:write'))
  assert.ok(!scopes.includes('repo:write') && !scopes.includes('issues:write'))
})
test('browser sessions need same-origin intent on writes', () => {
  assert.ok(
    !csrfSafe(new Request('https://gild.gg/api/issues', { method: 'POST' })),
  )
  assert.ok(
    !csrfSafe(
      new Request('https://gild.gg/api/issues', {
        method: 'POST',
        headers: { origin: 'https://evil.test' },
      }),
    ),
  )
  assert.ok(
    csrfSafe(
      new Request('https://gild.gg/api/issues', {
        method: 'POST',
        headers: { origin: 'https://gild.gg', 'sec-fetch-site': 'same-origin' },
      }),
    ),
  )
})
test('raw binary index survives restarts, and empty blobs are distinguishable', () => {
  const db = new DatabaseSync(':memory:'),
    sql = {
      exec(q: string, ...args: (string | number | null)[]) {
        if (!args.length && q.includes(';')) {
          db.exec(q)
          return []
        }
        const st = db.prepare(q)
        if (st.columns().length) return st.all(...args)
        st.run(...args)
        return []
      },
    }
  const store = new IndexStore(sql as any),
    bytes = Buffer.from([0, 255, 3, 10]),
    hash = '1'.repeat(40)
  store.putBlob({
    hash,
    size: bytes.length,
    lines: 0,
    binary: 1,
    content: null,
    language: '',
    symbols: [],
    raw: bytes.toString('base64'),
  })
  assert.deepEqual(
    Buffer.from(new IndexStore(sql as any).rawBlob(hash)!.content, 'base64'),
    bytes,
  )
  store.putBlob({
    hash: '2'.repeat(40),
    size: 0,
    lines: 0,
    binary: 0,
    content: '',
    language: '',
    symbols: [],
    raw: '',
  })
  assert.equal(store.rawBlob('2'.repeat(40))!.size, 0)
  assert.equal(store.rawBlob('3'.repeat(40)), null)
  db.close()
})
test('an agent with repo:read can read a commit\'s Actions results, like any run read', () => {
  // `gild pr checks --agent` on 10 Oct: "Requires actions scope", so neither
  // the dev nor the lead agent could see their PR's CI.
  const reads = routes.filter(r => r.method === 'GET' && ['actionRuns', 'actionRun', 'actionJobs', 'actionLogs', 'actionCommitRuns'].includes(r.id))
  assert.equal(reads.length, 5)
  for (const r of reads) {
    assert.equal(r.scope, 'repo:read', r.id)
    assert.ok(grantScopes(['review']).includes(r.scope as never), r.id)
  }
})
