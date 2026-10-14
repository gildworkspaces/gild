import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryStore } from './drivers/memory.ts'
import { mayRead, repoAccess } from './repo-read.ts'
import { privacyHTTP, repositoryPath } from './privacy-http.ts'
import { importCapabilityRead } from './import/privacy.ts'
import { repoList, listingBatch } from './repo-list.ts'
import { eventRepositories } from './events/repositories.ts'
import { privacyHandler } from './collaborators.ts'
const marker = 'private-unique-string-7aac18'
test('a metadata fence preserves only the exact import job heartbeat and transport', async () => {
  const { store, s } = await fixture()
  await store.fenceRepoAccess('acme/secret', 'next-meta')
  let revoked = false
  const pendingImportRead = (request: Request, owner: string, repo: string) =>
    importCapabilityRead(request, owner, repo, async (o, r, token) => {
      if (revoked || `${o}/${r}` !== 'acme/secret' || token !== 'gi_valid') throw Error('Unauthorized')
    })
  for (const [path, token, expected] of [
    ['/api/v1/repos/acme/secret/import/heartbeat', 'gi_valid', 200],
    ['/acme/secret.git/git-receive-pack', 'gi_valid', 200],
    ['/api/v1/repos/acme/secret/import/heartbeat', 'gi_wrong', 404],
    ['/api/v1/repos/acme/secret/import/heartbeat', 'gr_runner', 404],
    ['/acme/secret.git/git-upload-pack', 'gc_clone', 404],
    ['/api/v1/repos/acme/secret/contents/README.md', 'gi_valid', 404],
  ] as const) {
    let forwarded = 0
    const response = await privacyHTTP(new Request('https://gild.test' + path, { headers: { authorization: 'Bearer ' + token } }),
      { ...s, viewer: async () => null, pendingImportRead, runnerRead: async () => true },
      async () => { forwarded++; return new Response(marker) })
    assert.equal(response.status, expected, path + ':' + token)
    assert.equal(forwarded, expected === 200 ? 1 : 0)
  }
  assert.equal(await pendingImportRead(new Request('https://gild.test/api/v1/repos/acme/other/import/heartbeat', { headers: { authorization: 'Bearer gi_valid' } }), 'acme', 'other'), false)
  revoked = true
  assert.equal(await pendingImportRead(new Request('https://gild.test/api/v1/repos/acme/secret/import/heartbeat', { headers: { authorization: 'Bearer gi_valid' } }), 'acme', 'secret'), false)
})
async function fixture() {
  const store = memoryStore()
  await store.createOrg('acme', null, 'owner')
  await store.addOrgMember('acme', 'member', 'member')
  const acl = {
    visibility: 'private',
    read: ['@reader'],
    write: ['@writer'],
    agents: { '@acme/granted': ['pr'], '@acme/empty': [] },
  }
  await store.publishRepoAccess('acme/secret', 'meta-private', acl)
  const s = { store, index: async () => null }
  return { store, acl, s }
}
const viewers = [
  null,
  'outsider',
  'reader',
  'writer',
  'member',
  'acme',
  'acme/granted',
  'acme/ungranted',
  'acme/empty',
]
const paths = [
  '/acme/secret',
  '/acme/secret/issues/1',
  '/acme/secret/pulls/2',
  '/acme/secret/score',
  '/acme/secret/health',
  '/acme/secret/agents',
  '/acme/secret/actions/1',
  '/acme/secret/search',
  '/acme/secret/commit/' + 'a'.repeat(40),
  '/api/v1/repos/acme/secret/contents/README.md',
  '/api/repos/acme/secret/tree',
  '/api/repos/acme/secret/actions/runs/1/logs',
  '/git/acme/secret.git/info/refs',
  '/acme/secret.git/git-upload-pack',
  '/pf/acme/secret/v1/blob/hash',
  '/api/fragments/acme/secret',
  '/api/user/starred/acme/secret',
]
test('viewer x every repository route: shared HTTP boundary blocks content before any RPC', async () => {
  const { s } = await fixture()
  for (const name of viewers)
    for (const path of paths) {
      let calls = 0
      const principal = name
        ? { id: name, name, publicKey: '', repos: null, scopes: null }
        : null
      const response = await privacyHTTP(
        new Request('https://gild.test' + path, {
          headers: name ? { authorization: 'Bearer fixture' } : {},
        }),
        { ...s, viewer: async () => principal },
        async () => {
          calls++
          return new Response(marker, {
            headers: { 'cache-control': 'public, immutable' },
          })
        },
      )
      const allowed =
        !!name && !['outsider', 'acme/ungranted', 'acme/empty'].includes(name)
      assert.equal(
        response.status,
        allowed
          ? 200
          : /info\/refs|git-upload-pack/.test(path) && !name
            ? 401
            : 404,
        `${name}:${path}`,
      )
      assert.equal(calls, allowed ? 1 : 0, `${name}:${path}: forbidden RPC`)
      assert.equal((await response.text()).includes(marker), allowed)
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
    }
})
test('private API/git need read scope AND repo allow-list; invalid auth never falls back', async () => {
  const { s } = await fixture()
  for (const scopes of [[], ['actions']])
    for (const path of [
      '/api/v1/repos/acme/secret',
      '/acme/secret.git/info/refs',
    ]) {
      const response = await privacyHTTP(
        new Request('https://gild.test' + path, {
          headers: { authorization: 'Bearer fixture' },
        }),
        {
          ...s,
          viewer: async () => ({
            id: 'x',
            name: 'acme',
            publicKey: '',
            repos: null,
            scopes,
          }),
        },
        async () => new Response(marker),
      )
      assert.equal(response.status, 404)
    }
  const response = await privacyHTTP(
    new Request('https://gild.test/acme/secret'),
    {
      ...s,
      viewer: async () => ({
        id: 'x',
        name: 'acme',
        publicKey: '',
        repos: ['other/repo'],
        scopes: null,
      }),
    },
    async () => new Response(marker),
  )
  assert.equal(response.status, 404)
})
test('cached listings normalize mixed-case viewers and filter before scores/counts', async () => {
  const { s, acl } = await fixture(),
    snapshot = {
      acl,
      meta: 'meta-private',
      tip: 'code',
      facts: null,
      updated: null,
      issues: 1,
      pulls: 2,
    }
  const services = {
    store: s.store,
    catalog: async () => [
      {
        id: '1',
        name: 'secret',
        description: marker,
        default_branch: 'main',
        created_at: '',
        updated_at: '',
        last_push_at: null,
      },
    ],
    snapshots: async () => ({ 'acme/secret': snapshot }),
    scores: async () => ({}),
  }
  for (const name of viewers) {
    const rows = await repoList('Acme', name, services)
    assert.equal(
      rows.length,
      name && !['outsider', 'acme/ungranted', 'acme/empty'].includes(name)
        ? 1
        : 0,
    )
  }
  assert.equal((await repoList('Acme', 'Reader', services)).length, 1)
})
test('stream selection filters unrestricted/default sets and returns 404 for explicit private targets', async () => {
  const { s } = await fixture()
  for (const name of viewers) {
    const c: any = {
        query: {},
        principal: { id: 'x', name: name ?? '', scopes: null, repos: null },
      },
      read = (o: string, r: string, v: string) => mayRead(s, o, r, v)
    const repos = await eventRepositories(c, async () => ['acme/secret'], read)
    assert.equal(
      repos.length,
      name && !['outsider', 'acme/ungranted', 'acme/empty'].includes(name)
        ? 1
        : 0,
    )
  }
  const c: any = {
    query: { repos: 'acme/secret' },
    principal: { name: 'outsider', scopes: null, repos: null },
  }
  await assert.rejects(
    eventRepositories(
      c,
      async () => [],
      (o, r, v) => mayRead(s, o, r, v),
    ),
    (e: any) => e.status === 404,
  )
})
test('D1 access fence fails closed for discretionary grants and hides older ACL revision until exact publication', async () => {
  const { store, s } = await fixture()
  await store.fenceRepoAccess('acme/secret', 'public')
  await store.publishRepoAccess('acme/secret', 'public', {
    visibility: 'public',
  })
  await store.putListing('acme/secret', 1, {
    meta: 'public',
    acl: { visibility: 'public' },
    tip: null,
    facts: null,
    updated: null,
    issues: 0,
    pulls: 0,
  })
  await store.fenceRepoAccess('acme/secret', 'private-pushed')
  assert.equal(
    await store.publishRepoAccess('acme/secret', 'public', {
      visibility: 'public',
    }),
    false,
  )
  for (const name of viewers)
    assert.equal(
      await mayRead(s, 'acme', 'secret', name),
      name === 'acme' || name === 'member',
      'only current structural access survives a failed push so owners can retry',
    )
  assert.deepEqual(
    (await store.getListings(['acme/secret']))['acme/secret'].acl,
    { visibility: 'private' },
  )
  await store.publishRepoAccess('acme/secret', 'private-pushed', {
    visibility: 'private',
    read: ['@reader'],
  })
  assert.equal(await mayRead(s, 'acme', 'secret', 'outsider'), false)
  assert.equal(await mayRead(s, 'acme', 'secret', 'reader'), true)
  assert.equal(
    await store.publishRepoAccess('acme/secret', 'public', {
      visibility: 'public',
    }),
    false,
    'a late public projection cannot overwrite the completed private revision',
  )
  assert.equal(await mayRead(s, 'acme', 'secret', 'outsider'), false)
  assert.deepEqual(
    (await store.getListings(['acme/secret']))['acme/secret'].acl,
    { visibility: 'private' },
    'old snapshot revision is fenced',
  )
})
test('a warmed public fragment provenance grant is revoked by the same fence', async () => {
  const { store, s } = await fixture()
  await store.fenceRepoAccess('acme/secret', 'public')
  await store.fenceRepoAccess('acme/secret', 'public')
  await store.publishRepoAccess('acme/secret', 'public', {})
  await store.registerFragment('f/v1/blob/hash', 'acme/secret')
  assert.deepEqual(await store.fragmentRepos('f/v1/blob/hash'), ['acme/secret'])
  await store.fenceRepoAccess('acme/secret', 'private')
  assert.deepEqual(await store.fragmentRepos('f/v1/blob/hash'), [])
  await store.publishRepoAccess('acme/secret', 'private', {
    visibility: 'private',
  })
  assert.deepEqual(await store.fragmentRepos('f/v1/blob/hash'), [])
})
test('pending invitations reveal no repository details; acceptance revalidates inviter and commits role', async () => {
  const { store, s, acl } = await fixture()
  await store.inviteRepo({
    id: 'invite',
    repo: 'acme/secret',
    invitee: 'reader2',
    permission: 'read',
    inviter: 'owner',
    created_at: 'now',
  })
  const run = privacyHandler(s, {
    acl: async (o, r, _by, change) => {
      change(acl)
      await store.fenceRepoAccess(`${o}/${r}`, 'new-meta')
      await store.publishRepoAccess(`${o}/${r}`, 'new-meta', acl)
    },
  })
  const ctx: any = {
    route: { id: 'repositoryInvitations' },
    params: {},
    principal: { name: 'reader2', repos: null },
    body: {},
  }
  assert.deepEqual((await run(ctx)).data, [
    { id: 'invite', permission: 'read' },
  ])
  assert.equal(await mayRead(s, 'acme', 'secret', 'reader2'), false)
  ctx.route.id = 'acceptRepositoryInvitation'
  ctx.params.id = 'invite'
  await run(ctx)
  assert.equal(await mayRead(s, 'acme', 'secret', 'reader2'), true)
})
test('private-to-public requires exact confirmation before any metadata write', async () => {
  const { s } = await fixture()
  let writes = 0
  const run = privacyHandler(s, {
      acl: async () => {
        writes++
      },
    }),
    c: any = {
      route: { id: 'setRepoVisibility' },
      params: { owner: 'acme', repo: 'secret' },
      principal: { name: 'acme', repos: null },
      body: { visibility: 'public' },
    }
  await assert.rejects(run(c), (e: any) => e.status === 422)
  assert.equal(writes, 0)
  c.body.confirm = 'acme/secret'
  await run(c)
  assert.equal(writes, 1)
})
test('all spelling variants and static/legacy routes identify the same repository', () => {
  for (const path of paths)
    assert.deepEqual(repositoryPath(path), { owner: 'acme', repo: 'secret' })
})

test('cold listing RPC cannot bypass a pending private access fence', async () => {
  const {store,s} = await fixture()
  await store.fenceRepoAccess('acme/secret','new-private')
  const value = {meta:'old-public',acl:{},tip:'tip'} as any
  const rows = await listingBatch(store,[{id:'acme/secret',name:'secret'}],async()=>{
    await store.putListing('acme/secret',1,value)
    return value
  })
  assert.equal(await mayRead(s,'acme','secret','outsider',{meta:rows['acme/secret'].meta,acl:rows['acme/secret'].acl,pending:false}),false)
})
test('a non-reader cannot tell a private repository from a missing one', async () => {
  const { s } = await fixture()
  for (const name of [null, 'outsider'])
    for (const path of paths) {
      const send = async (p: string) => {
        const response = await privacyHTTP(
          new Request('https://gild.test' + p, {
            headers: name ? { authorization: 'Bearer fixture' } : {},
          }),
          {
            ...s,
            viewer: async () =>
              name
                ? { id: name, name, publicKey: '', repos: null, scopes: null }
                : null,
          },
          async () => new Response(marker),
        )
        return [
          response.status,
          response.headers.get('www-authenticate'),
          response.headers.get('cache-control'),
          await response.text(),
        ]
      }
      assert.deepEqual(
        await send(path.replace('secret', 'nothing-here')),
        await send(path),
        `${name}:${path}`,
      )
    }
})
