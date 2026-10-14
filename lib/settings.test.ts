import { renameStep } from './settings-rename.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { D1Database } from '@cloudflare/workers-types'
import { d1Store } from './drivers/d1.ts'
import { memoryStore } from './drivers/memory.ts'
import {
  changeMembership,
  orgAccess,
  repoAccess,
  settingsService,
  purgeDeleted,
  type LifecycleTransport,
} from './settings.ts'
import { settingsHTTP } from './settings-http.ts'
import { match } from './api/routing.ts'
import { dispatch } from './api/dispatch.ts'
import type { Context, Control } from './api/dispatch.ts'
import {
  ownerNameAvailable,
  repoNameAvailable,
  ROUTE_NAMES,
} from './backend-names.ts'
import { RESTORE_MS } from './settings-store.ts'
import { profileInput, webpBytes } from './profile.ts'
export function database() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  for (const file of readdirSync('migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort())
    db.exec(readFileSync('migrations/' + file, 'utf8'))
  const prepare = (q: string) => {
    let args: unknown[] = []
    const statement = {
      bind(...a: unknown[]) {
        args = a
        return statement
      },
      async first() {
        return db.prepare(q).get(...(args as never[])) ?? null
      },
      async all() {
        return { results: db.prepare(q).all(...(args as never[])) }
      },
      async run() {
        const result = db.prepare(q).run(...(args as never[]))
        return { meta: { changes: Number(result.changes) } }
      },
    }
    return statement
  }
  const d1 = {
    prepare,
    async batch(list: { run(): Promise<unknown> }[]) {
      db.exec('BEGIN')
      try {
        const result = []
        for (const stmt of list) result.push(await stmt.run())
        db.exec('COMMIT')
        return result
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
  } as unknown as D1Database
  return { db, d1, st: d1Store(d1) }
}
async function fixture(memory = false) {
  const sql = database(),
    st = memory ? memoryStore() : sql.st
  for (const name of ['owner', 'adminuser', 'member', 'outsider', 'second']) {
    await st.prepareClaim(name, 'ed25519:' + name, name + '@example.com', name)
    await st.finalizeClaim(name)
  }
  await st.createOrg('acme', 'Original', 'owner')
  await st.addOrgMember('acme', 'adminuser', 'admin')
  await st.addOrgMember('acme', 'member', 'member')
  const repos = new Map([
      ['acme/demo', { name: 'demo', description: 'Original' }],
      ['owner/demo', { name: 'demo', description: 'Personal' }],
    ]),
    purged: string[] = [],
    transport: LifecycleTransport = {
      async resumeRename() {},
      async branches() {
        return ['main', 'feature']
      },
      async defaultBranch() {},
      async startRename(job) {
        await st.settings.saveRename(job)
        for (
          let i = 0;
          i < 20 && !(await renameStep(st, transport, job));
          i++
        ) {}
        if (job.phase === 'failed') throw Error('Copy failed: Transport failed')
      },
      async list(owner) {
        return [...repos]
          .filter(([k]) => k.startsWith(owner + '/'))
          .map(([, v]) => v)
      },
      async exists(owner, repo) {
        const r = repos.get(`${owner}/${repo}`)
        if (!r) throw Object.assign(new Error('Not found'), { status: 404 })
        return r
      },
      async copy(from, to) {
        repos.set(to, { ...repos.get(from)!, name: to.split('/')[1] })
      },
      async purge(key) {
        purged.push(key)
        repos.delete(key)
      },
      async discard(key) {
        repos.delete(key)
      },
      async renameHooks() {},
      async rebind() {},
      async suspend() {},
    }
  return {
    ...sql,
    st,
    repos,
    purged,
    transport,
    handler: settingsService(st, transport),
  }
}
function context(
  name: string,
  id: string,
  params: Record<string, string> = {},
  body: Record<string, unknown> = {},
): Context {
  const route = awaitRoutes().find((r) => r.id === id)!
  return {
    principal: {
      id: name,
      name,
      publicKey: 'ed25519:' + name,
      scopes: null,
      repos: null,
    },
    route,
    params,
    body,
    query: {},
    request: new Request(
      'http://forge/api/v1' +
        route.path.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? 'x'),
      { method: route.method },
    ),
  }
}
import { routes } from './api/contract.ts'
const awaitRoutes = () => routes
const actors = ['', 'member', 'adminuser', 'owner', 'outsider']
test('permission table: account/org/repo pages and profile writes assert persisted effects', async () => {
  for (const actor of actors) {
    const f = await fixture(),
      orgAllowed = ['owner', 'adminuser'].includes(actor)
    const op = context(
      actor,
      'updateOrgProfile',
      { org: 'acme' },
      { displayName: actor || 'anonymous', description: 'Updated ' + actor },
    )
    if (orgAllowed) {
      assert.ok(await orgAccess(f.st, 'acme', actor))
      await f.handler(op)
      assert.equal((await f.st.settings.profile('acme')).displayName, actor)
      assert.equal((await f.st.getOrg('acme'))?.description, 'Updated ' + actor)
    } else {
      await assert.rejects(orgAccess(f.st, 'acme', actor), { status: 404 })
      await assert.rejects(f.handler(op), { status: 404 })
      assert.equal((await f.st.settings.profile('acme')).displayName, '')
    }
    if (orgAllowed) {
      assert.ok(await repoAccess(f.st, 'acme', actor))
      await f.handler(
        context(
          actor,
          'updateRepository',
          { owner: 'acme', repo: 'demo' },
          { description: 'By ' + actor },
        ),
      )
      assert.equal(
        (await f.st.settings.state('acme/demo')).description,
        'By ' + actor,
      )
    } else {
      await assert.rejects(repoAccess(f.st, 'acme', actor), { status: 404 })
      await assert.rejects(
        f.handler(
          context(
            actor,
            'updateRepository',
            { owner: 'acme', repo: 'demo' },
            { description: 'Forbidden' },
          ),
        ),
        { status: 404 },
      )
      assert.equal((await f.st.settings.state('acme/demo')).description, null)
    }
    if (actor) {
      await f.handler(
        context(
          actor,
          'updateProfile',
          {},
          { displayName: 'Personal ' + actor },
        ),
      )
      assert.equal(
        (await f.st.settings.profile(actor)).displayName,
        'Personal ' + actor,
      )
    } else
      await assert.rejects(
        f.handler(
          context(actor, 'updateProfile', {}, { displayName: 'anonymous' }),
        ),
        { status: 404 },
      )
    f.db.close()
  }
})
test('admin guard: members and outsiders cannot add members through shared POST/PUT handler', async () => {
  for (const actor of actors) {
    const f = await fixture(true)
    if (['owner', 'adminuser'].includes(actor)) {
      await changeMembership(f.st, 'acme', actor, 'outsider', 'admin')
      assert.equal(await f.st.orgRole('acme', 'outsider'), 'admin')
      await changeMembership(f.st, 'acme', actor, 'outsider', null)
      assert.equal(await f.st.orgRole('acme', 'outsider'), null)
    } else {
      await assert.rejects(
        changeMembership(f.st, 'acme', actor, 'outsider', 'admin'),
        { status: 404 },
      )
      assert.equal(await f.st.orgRole('acme', 'outsider'), null)
    }
  }
})
test('last-owner guard: leave, demotion and removal preserve the owner', async () => {
  const f = await fixture(true)
  for (const role of ['admin', 'member', null] as const) {
    await assert.rejects(
      changeMembership(f.st, 'acme', 'owner', 'owner', role),
      { status: 409 },
    )
    assert.equal(await f.st.orgRole('acme', 'owner'), 'owner')
  }
  await assert.rejects(
    changeMembership(f.st, 'acme', 'owner', 'owner', null, true),
    { status: 409 },
  )
  assert.equal(await f.st.orgRole('acme', 'owner'), 'owner')
  await changeMembership(f.st, 'acme', 'owner', 'second', 'owner')
  await changeMembership(f.st, 'acme', 'owner', 'owner', null, true)
  assert.equal(await f.st.orgRole('acme', 'owner'), null)
  assert.equal(await f.st.orgRole('acme', 'second'), 'owner')
})
test('only owners grant or remove owner roles; SQL prevents concurrent last-owner removals', async () => {
  const f = await fixture()
  await assert.rejects(
    changeMembership(f.st, 'acme', 'adminuser', 'second', 'owner'),
    { status: 403 },
  )
  await assert.rejects(
    changeMembership(f.st, 'acme', 'adminuser', 'owner', 'admin'),
    { status: 403 },
  )
  await changeMembership(f.st, 'acme', 'owner', 'second', 'owner')
  const attempts = await Promise.allSettled([
    changeMembership(f.st, 'acme', 'owner', 'owner', null),
    changeMembership(f.st, 'acme', 'second', 'second', null),
  ])
  assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1)
  const rejected = attempts.find(
    (r) => r.status === 'rejected',
  ) as PromiseRejectedResult
  assert.equal(rejected.reason.status, 409)
  assert.equal(
    rejected.reason.message,
    'The last owner cannot leave, be demoted, or be removed',
  )
  assert.equal(
    (await f.st.orgMembers('acme')).filter((m) => m.role === 'owner').length,
    1,
  )
  f.db.close()
})
test('owner guard: only owners may rename/archive/delete orgs and repos', async () => {
  for (const actor of actors) {
    for (const kind of ['Org', 'Repo'])
      for (const verb of ['rename', 'archive', 'delete']) {
        const f = await fixture(true),
          params =
            kind === 'Org' ? { org: 'acme' } : { owner: 'acme', repo: 'demo' },
          body =
            verb === 'rename'
              ? { name: 'renamed' }
              : verb === 'archive'
                ? { archived: true }
                : { confirm: kind === 'Org' ? 'acme' : 'acme/demo' },
          key = kind === 'Org' ? 'acme' : 'acme/demo'
        if (actor === 'owner') {
          await f.handler(context(actor, verb + kind, params, body))
          assert.equal(
            verb === 'rename'
              ? await f.st.settings.canonical(key)
              : verb === 'archive'
                ? (await f.st.settings.state(key)).archived
                : !!(await f.st.settings.state(key)).deletedAt,
            verb === 'rename'
              ? kind === 'Org'
                ? 'renamed'
                : 'acme/renamed'
              : true,
          )
        } else {
          await assert.rejects(
            f.handler(context(actor, verb + kind, params, body)),
            { status: 404 },
          )
          assert.equal(await f.st.settings.canonical(key), key)
          assert.equal((await f.st.settings.state(key)).archived, false)
          assert.equal((await f.st.settings.state(key)).deletedAt, null)
        }
      }
  }
})
test('rename publishes all repo names atomically; web/API/git clone paths redirect, DO identities persist', async () => {
  const f = await fixture()
  await f.st.settings.putState(await f.st.settings.state('acme/demo'))
  await f.st.putScore('acme/demo@sha#build', 'cached')
  await f.handler(
    context('owner', 'renameOrg', { org: 'acme' }, { name: 'renamed' }),
  )
  assert.equal(await f.st.getScore('renamed/demo@sha#build'), 'cached')
  assert.equal(await f.st.getOrg('acme'), null)
  assert.equal((await f.st.getOrg('renamed'))?.name, 'renamed')
  assert.equal(await f.st.orgRole('renamed', 'adminuser'), 'admin')
  assert.equal((await f.st.settings.state('renamed/demo')).id, 'acme/demo')
  assert.equal(await f.st.nameTaken('acme'), true)
  for (const path of [
    '/acme/demo',
    '/orgs/acme/settings/general',
    '/api/v1/repos/acme/demo',
    '/api/orgs/acme',
    '/acme/demo.git/info/refs?service=git-upload-pack',
    '/git/acme/demo.git/git-receive-pack',
  ]) {
    const r = await settingsHTTP(
      new Request('http://forge' + path),
      f.st,
      async () => {
        throw Error('Old URL reached upstream')
      },
    )
    assert.equal(r.status, 308)
    assert.ok(r.headers.get('location')?.includes('renamed'))
  }
  await f.handler(
    context(
      'owner',
      'renameRepo',
      { owner: 'renamed', repo: 'demo' },
      { name: 'second' },
    ),
  )
  assert.equal((await f.st.settings.state('renamed/second')).id, 'acme/demo')
  assert.equal(await f.st.settings.canonical('acme/demo'), 'renamed/second')
  f.db.close()
})
test('failed org copy never switches visible names or membership', async () => {
  const f = await fixture()
  f.repos.set('acme/second', { name: 'second', description: null })
  let count = 0
  f.transport.copy = async (from, to) => {
    if (++count === 2) throw Error('Copy failed')
    f.repos.set(to, { ...f.repos.get(from)!, name: to.split('/')[1] })
  }
  await assert.rejects(
    f.handler(
      context('owner', 'renameOrg', { org: 'acme' }, { name: 'renamed' }),
    ),
    /Copy failed/,
  )
  assert.equal((await f.st.getOrg('acme'))?.name, 'acme')
  assert.equal(await f.st.getOrg('renamed'), null)
  assert.equal(await f.st.orgRole('acme', 'owner'), 'owner')
  assert.equal(f.repos.has('renamed/demo'), false)
  assert.equal((await f.st.settings.state('acme')).moving, false)
  f.db.close()
})
test('archive fences git push, issues, PRs, Actions and hooks; unarchive restores writes', async () => {
  const f = await fixture()
  await f.handler(
    context('owner', 'archiveOrg', { org: 'acme' }, { archived: true }),
  )
  for (const [path, method] of [
    ['/acme/demo.git/info/refs?service=git-receive-pack', 'GET'],
    ['/git/acme/demo.git/git-receive-pack', 'POST'],
    ['/api/v1/repos/acme/demo/issues', 'POST'],
    ['/api/repos/acme/demo/pulls/1', 'POST'],
    ['/api/v1/repos/acme/demo/actions/workflows/ci.yml/dispatches', 'POST'],
    ['/api/v1/orgs/acme/hooks', 'POST'],
  ]) {
    let writes = 0
    const r = await settingsHTTP(
      new Request('http://forge' + path, { method }),
      f.st,
      async () => {
        writes++
        return Response.json({ ok: true })
      },
    )
    assert.equal(r.status, 409)
    assert.equal(writes, 0)
  }
  const read = await settingsHTTP(
    new Request('http://forge/acme/demo'),
    f.st,
    async (r) => new Response(r.headers.get('x-gild-archive')),
  )
  assert.match(await read.text(), /archived/)
  assert.equal(read.headers.get('cache-control'), 'no-store')
  await f.handler(
    context('owner', 'archiveOrg', { org: 'acme' }, { archived: false }),
  )
  let writes = 0
  await settingsHTTP(
    new Request('http://forge/api/v1/repos/acme/demo/issues', {
      method: 'POST',
    }),
    f.st,
    async () => {
      writes++
      return Response.json({ ok: true })
    },
  )
  assert.equal(writes, 1)
  f.db.close()
})
test('delete hides org and repos, owners can restore in 7 days; purge removes repos/members/state', async () => {
  const f = await fixture()
  await assert.rejects(
    f.handler(
      context('owner', 'deleteOrg', { org: 'acme' }, { confirm: 'wrong' }),
    ),
    { status: 422 },
  )
  await f.handler(
    context('owner', 'deleteOrg', { org: 'acme' }, { confirm: 'acme' }),
  )
  assert.equal(await f.st.getOrg('acme'), null)
  assert.equal((await f.st.orgsFor('owner')).length, 0)
  assert.equal(
    (await f.st.owners()).some((o) => o.name === 'acme'),
    false,
  )
  assert.equal(await f.st.nameTaken('acme'), true)
  const r = await settingsHTTP(
    new Request('http://forge/acme/demo'),
    f.st,
    async () => {
      throw Error('Deleted repo read')
    },
  )
  assert.equal(r.status, 404)
  await assert.rejects(
    f.handler(context('adminuser', 'restoreOrg', { org: 'acme' })),
    { status: 404 },
  )
  await f.handler(context('owner', 'restoreOrg', { org: 'acme' }))
  assert.equal((await f.st.orgsFor('owner')).length, 1)
  await f.handler(
    context('owner', 'deleteOrg', { org: 'acme' }, { confirm: 'acme' }),
  )
  await purgeDeleted(f.st, f.transport, Date.now() + RESTORE_MS - 100)
  assert.equal(f.purged.length, 0)
  await purgeDeleted(f.st, f.transport, Date.now() + RESTORE_MS + 100)
  assert.ok(f.purged.includes('acme/demo'))
  assert.equal(await f.st.getOrg('acme'), null)
  assert.equal((await f.st.orgMembers('acme')).length, 0)
  assert.equal(
    f.db
      .prepare('SELECT count(*) as n FROM settings_entities WHERE key LIKE ?')
      .get('acme%')?.n,
    0,
  )
  await assert.rejects(
    f.handler(context('owner', 'restoreOrg', { org: 'acme' })),
    { status: 404 },
  )
  f.db.close()
})
test('repo delete uses owner/repo confirmation and restores stable state before deadline', async () => {
  const f = await fixture()
  await assert.rejects(
    f.handler(
      context(
        'owner',
        'deleteRepo',
        { owner: 'owner', repo: 'demo' },
        { confirm: 'demo' },
      ),
    ),
    { status: 422 },
  )
  await f.handler(
    context(
      'owner',
      'deleteRepo',
      { owner: 'owner', repo: 'demo' },
      { confirm: 'owner/demo' },
    ),
  )
  await assert.rejects(
    f.handler(
      context('outsider', 'restoreRepo', { owner: 'owner', repo: 'demo' }),
    ),
    { status: 404 },
  )
  await f.handler(
    context('owner', 'restoreRepo', { owner: 'owner', repo: 'demo' }),
  )
  assert.equal((await f.st.settings.state('owner/demo')).deletedAt, null)
  f.db.close()
})
test('reserved names share claim/create/rename validation; app root route list is exhaustive', async () => {
  const roots = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory()
        ? d.name.startsWith('(')
          ? roots(join(path, d.name))
          : d.name.startsWith('[')
            ? []
            : [d.name]
        : [],
    )
  assert.deepEqual([...new Set(roots('app'))].sort(), [...ROUTE_NAMES].sort())
  const f = await fixture()
  assert.equal(ownerNameAvailable('settings'), false)
  await f.st.prepareClaim(
    'settings',
    'ed25519:reserved',
    'x@example.com',
    'reserved',
  )
  assert.equal(await f.st.finalizeClaim('reserved'), false)
  assert.equal(await f.st.nameTaken('orgs'), true)
  await assert.rejects(
    f.handler(
      context('owner', 'renameOrg', { org: 'acme' }, { name: 'settings' }),
    ),
    { status: 422 },
  )
  f.db.close()
})
test('settings pages are no-store and pictures are validated by actual WebP dimensions', async () => {
  const f = await fixture()
  for (const path of [
    '/settings/profile',
    '/orgs/acme/settings/general',
    '/acme/demo/settings/actions',
  ]) {
    const r = await settingsHTTP(
      new Request('http://forge' + path),
      f.st,
      async () =>
        new Response('settings', {
          headers: { 'cache-control': 'public, max-age=3600' },
        }),
    )
    assert.equal(r.headers.get('cache-control'), 'no-store')
  }
  assert.equal(
    profileInput.safeParse({ url: 'javascript:alert(1)' }).success,
    false,
  )
  assert.equal(
    profileInput.safeParse({ picture: 'https://evil.example' }).success,
    false,
  )
  assert.throws(() => webpBytes('data:image/webp;base64,AAAA'), /Picture/)
  f.db.close()
})

test('shared name reservations serialize claim/org creation and release failed rename targets', async () => {
  const f = await fixture()
  await f.st.prepareClaim('same', 'ed25519:same', 'same@example.com', 'race')
  await f.st.createOrg('same', null, 'owner')
  assert.equal(await f.st.finalizeClaim('race'), false)
  assert.equal(await f.st.getClaim('same'), null)
  await f.st.settings.reserve('destination')
  await f.st.prepareClaim(
    'destination',
    'ed25519:destination',
    'd@example.com',
    'reserved',
  )
  assert.equal(await f.st.finalizeClaim('reserved'), false)
  await assert.rejects(f.st.createOrg('destination', null, 'owner'), {
    status: 409,
  })
  await f.st.settings.unreserve('destination')
  const claimed = await f.st.finalizeClaim('reserved')
  assert.ok(claimed)
  assert.equal(claimed.name, 'destination')
  f.transport.copy = async () => {
    throw Error('Transport failed')
  }
  await assert.rejects(
    f.handler(
      context('owner', 'renameOrg', { org: 'acme' }, { name: 'available' }),
    ),
    /Transport failed/,
  )
  assert.equal(await f.st.nameTaken('available'), false)
  f.db.close()
})
test('repo rename cleanup retains the organization namespace and rekeys only its caches', async () => {
  const f = await fixture()
  await f.st.putScore('acme/demo@sha#build', 'wanted')
  await f.st.putScore('other/acme@sha#build', 'other')
  await f.st.putChange('tree:acme/demo:sha', new Uint8Array([1, 2]))
  await f.st.putChange('tree:other/acme:sha', new Uint8Array([3]))
  await f.handler(
    context(
      'owner',
      'renameRepo',
      { owner: 'acme', repo: 'demo' },
      { name: 'next' },
    ),
  )
  assert.equal(await f.st.getScore('acme/next@sha#build'), 'wanted')
  assert.equal(await f.st.getScore('other/acme@sha#build'), 'other')
  assert.deepEqual(
    await f.st.getChange('tree:acme/next:sha'),
    new Uint8Array([1, 2]),
  )
  assert.deepEqual(await f.st.settings.garbage(), [
    { key: 'acme/demo', org: true },
  ])
  const cleanup = []
  f.transport.discard = async (key, org) => {
    cleanup.push({ key, org })
    f.repos.delete(key)
  }
  await purgeDeleted(f.st, f.transport)
  assert.deepEqual(cleanup, [{ key: 'acme/demo', org: true }])
  assert.equal(f.repos.has('acme/demo'), false)
  assert.equal(f.repos.has('acme/next'), true)
  assert.equal(await f.st.settings.canonical('acme/demo'), 'acme/next')
  f.db.close()
})

test('case variants cannot bypass archive or deletion fences', async () => {
  const f = await fixture()
  await f.handler(
    context('owner', 'archiveOrg', { org: 'acme' }, { archived: true }),
  )
  let writes = 0
  const forward = async () => {
    writes++
    return Response.json({ ok: true })
  }
  const first = await settingsHTTP(
    new Request(
      'http://forge/AcMe/DEMO.git/info/refs?service=git-receive-pack',
    ),
    f.st,
    forward,
  )
  assert.equal(first.status, 308)
  const blocked = await settingsHTTP(
    new Request(first.headers.get('location')!),
    f.st,
    forward,
  )
  assert.equal(blocked.status, 409)
  assert.equal(writes, 0)
  await f.handler(
    context(
      'owner',
      'deleteRepo',
      { owner: 'owner', repo: 'demo' },
      { confirm: 'owner/demo' },
    ),
  )
  const alias = await settingsHTTP(
    new Request('http://forge/api/v1/repos/OWNER/DEMO/issues', {
      method: 'POST',
    }),
    f.st,
    forward,
  )
  assert.equal(alias.status, 308)
  assert.equal(
    (
      await settingsHTTP(
        new Request(alias.headers.get('location')!, { method: 'POST' }),
        f.st,
        forward,
      )
    ).status,
    404,
  )
  assert.equal(writes, 0)
  f.db.close()
})

test('bounded profile writes reject oversized links/email before changing D1', async () => {
  const f = await fixture(),
    principal = {
      id: 'owner',
      name: 'owner',
      publicKey: 'ed25519:owner',
      scopes: null,
      repos: null,
    },
    control = {
      rate() {
        return {
          limit: 10000,
          remaining: 9999,
          reset: Date.now() + 3600000,
          allowed: true,
        }
      },
      begin() {
        return { kind: 'new' as const }
      },
      finish() {},
      release() {},
    }
  for (const [path, key] of [
    ['/user/profile', 'owner'],
    ['/orgs/acme/profile', 'acme'],
  ]) {
    const initial = {
      ...(await f.st.settings.profile(key)),
      url: 'https://example.com',
    }
    await f.st.settings.saveProfile(key, initial)
    for (const body of [
      { url: 'https://example.com/' + 'a'.repeat(2048) },
      { socialLinks: ['https://example.com/' + 'a'.repeat(2048)] },
      { publicEmail: 'a'.repeat(300) + '@example.com' },
    ]) {
      const r = await dispatch(
        new Request('http://forge/api/v1' + path, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        {
          authenticate: async () => principal,
          control: async () => control,
          authorize: async () => {},
          execute: f.handler,
        },
      )
      assert.deepEqual(await f.st.settings.profile(key), initial)
      assert.equal(r.status, 422)
    }
  }
  f.db.close()
})

test('scheduled cron wiring invokes purge and age-gated picture GC through the production Worker', async () => {
  const { build } = await import('esbuild')
  const { mkdirSync, writeFileSync, unlinkSync } = await import('node:fs')
  const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'))
  assert.ok(
    config.triggers?.crons?.length,
    'The production scheduled handler needs a configured cron',
  )
  assert.ok(
    config.triggers.crons.every(
      (cron: string) => cron.trim().split(/\s+/).length === 5,
    ),
  )
  const f = await fixture()
  const state = await f.st.settings.state('owner/demo')
  state.deletedAt = Date.now() - RESTORE_MS - 100
  await f.st.settings.putState(state)
  f.db
    .prepare(
      'INSERT INTO profile_pictures(hash,bytes,created_at) VALUES (?,?,?)',
    )
    .run('old', new Uint8Array([1]), Date.now() - 7200000)
  f.db
    .prepare('INSERT INTO profile_pictures(hash,bytes) VALUES (?,?)')
    .run('upload-in-flight', new Uint8Array([2]))
  f.db
    .prepare(
      'INSERT INTO profile_pictures(hash,bytes,created_at) VALUES (?,?,?)',
    )
    .run('referenced', new Uint8Array([3]), Date.now() - 7200000)
  await f.st.settings.saveProfile('owner', {
    ...(await f.st.settings.profile('owner')),
    picture: '/avatars/referenced',
  })
  let flushes = 0
  Object.assign(globalThis, {
    __settingsFixture: {
      transport: f.transport,
      flush: async () => {
        flushes++
      },
    },
  })
  const result = await build({
    entryPoints: ['worker.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [
      {
        name: 'worker-bindings',
        setup(b) {
          b.onResolve(
            {
              filter:
                /(?:\.open-next\/worker\.js|core\.wasm|import\/do$|channel\/do$|settings-production$|d1-outbox$|consumer$|(?:repo-index|pool|queue|hub|control|settings-rename)-do$)/,
            },
            (args) => ({ path: args.path, namespace: 'bindings' }),
          )
          b.onLoad({ filter: /.*/, namespace: 'bindings' }, () => ({
            contents: `
        export default {}; export const DOQueueHandler=0,DOShardedTagCache=0,BucketCachePurge=0,RepoIndex=0,RunQueue=0,ForgeEvents=0,ApiControl=0,SettingsRename=0,RunnerPool=0,RepoImport=0,RepoChannel=0;
        export const lifecycleTransport=async()=>globalThis.__settingsFixture.transport;
        export const flushAgentEvents=()=>globalThis.__settingsFixture.flush();
        export const consumeWebhooks=async()=>{};
      `,
            loader: 'js',
          }))
        },
      },
    ],
  })
  mkdirSync('.tmp', { recursive: true })
  const path = `.tmp/settings-worker-${crypto.randomUUID()}.mjs`
  writeFileSync(path, result.outputFiles[0].text)
  try {
    const { default: worker } = await import('../' + path)
    assert.equal(typeof worker.scheduled, 'function')
    await worker.scheduled({ cron: config.triggers.crons[0] }, { DB: f.d1 })
    assert.equal(flushes, 1)
    assert.ok(
      f.purged.includes('owner/demo'),
      'Configured production cron purges expired Git repos',
    )
    assert.equal(
      f.db.prepare('SELECT hash FROM profile_pictures WHERE hash=?').get('old'),
      undefined,
    )
    assert.ok(
      f.db
        .prepare('SELECT hash FROM profile_pictures WHERE hash=?')
        .get('upload-in-flight'),
    )
    assert.ok(
      f.db
        .prepare('SELECT hash FROM profile_pictures WHERE hash=?')
        .get('referenced'),
    )
  } finally {
    unlinkSync(path)
    f.db.close()
  }
})

test('archived and moving repositories allow clone/fetch upload-pack POST but refuse receive-pack', async () => {
  for (const property of ['archived', 'moving'] as const) {
    const f = await fixture(),
      state = await f.st.settings.state('owner/demo')
    state[property] = true
    await f.st.settings.putState(state)
    for (const prefix of ['/owner/demo.git', '/git/owner/demo.git']) {
      for (const [tail, method, status] of [
        ['/info/refs?service=git-upload-pack', 'GET', 200],
        ['/git-upload-pack', 'POST', 200],
        ['/info/refs?service=git-receive-pack', 'GET', 409],
        ['/git-receive-pack', 'POST', 409],
      ] as const) {
        let forwarded = 0
        const r = await settingsHTTP(
          new Request('http://forge' + prefix + tail, { method }),
          f.st,
          async () => {
            forwarded++
            return new Response('Git response')
          },
        )
        assert.equal(r.status, status, property + prefix + tail)
        assert.equal(forwarded, status === 200 ? 1 : 0)
      }
    }
    f.db.close()
  }
})

test('CSRF gate refuses cross-site cookie mutations before persisted changes; same-origin and bearer work', async () => {
  const f = await fixture()
  for (const [path, method] of [
    ['/api/account/profile', 'PATCH'],
    ['/api/account/picture', 'PUT'],
    ['/api/account/picture', 'DELETE'],
    ['/api/orgs/acme/picture', 'DELETE'],
    ['/api/account/tokens', 'POST'],
    ['/api/orgs/acme/memberships/member', 'PUT'],
    ['/api/orgs/acme/rename', 'POST'],
    ['/api/repos/owner/demo/archive', 'PUT'],
    ['/api/repos/owner/demo', 'DELETE'],
    ['/api/repos/owner/demo/actions/settings/secrets/SECRET', 'PUT'],
  ]) {
    const forward = async () => {
      await f.st.settings.saveProfile('owner', {
        ...(await f.st.settings.profile('owner')),
        displayName: 'Written',
      })
      return Response.json({ ok: true })
    }
    for (const headers of [
      {
        cookie: 'gild_session=signed',
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
      {
        cookie: 'gild_session=signed',
        origin: 'http://forge',
        'sec-fetch-site': 'cross-site',
      },
      { cookie: 'gild_session=signed' },
    ]) {
      const r = await settingsHTTP(
        new Request('http://forge' + path, { method, headers }),
        f.st,
        forward,
      )
      assert.equal(r.status, 403, path)
      assert.equal((await f.st.settings.profile('owner')).displayName, '')
    }
    for (const headers of [
      {
        cookie: 'gild_session=signed',
        origin: 'http://forge',
        'sec-fetch-site': 'same-origin',
      },
      { authorization: 'Bearer fixture', origin: 'https://evil.example' },
    ]) {
      const r = await settingsHTTP(
        new Request('http://forge' + path, { method, headers }),
        f.st,
        forward,
      )
      assert.equal(r.status, 200)
      assert.equal(
        (await f.st.settings.profile('owner')).displayName,
        'Written',
      )
      await f.st.settings.saveProfile('owner', {
        ...(await f.st.settings.profile('owner')),
        displayName: '',
      })
    }
  }
  f.db.close()
})

test('purge isolates failed cleanup and deleted items, revokes scoped tokens, and still collects old pictures', async () => {
  const { settingsScheduled } = await import('./settings-scheduled.ts')
  const f = await fixture()
  for (const key of ['acme/demo', 'owner/demo']) {
    const state = await f.st.settings.state(key)
    state.deletedAt = Date.now() - RESTORE_MS - 100
    await f.st.settings.putState(state)
  }
  f.db
    .prepare('INSERT INTO settings_cleanup(key,org) VALUES (?,1)')
    .run('broken/old')
  f.transport.discard = async () => {
    throw Error('cleanup fixture failure')
  }
  const purge = f.transport.purge
  f.transport.purge = async (key, id) => {
    if (key === 'acme/demo') throw Error('purge fixture failure')
    await purge(key, id)
  }
  for (const [hash, repos] of [
    ['scoped', '["owner/demo","other/safe"]'],
    ['untouched', '["other/safe"]'],
    ['all', null],
  ])
    f.db
      .prepare(
        'INSERT INTO api_tokens(token_hash,name,public_key,created_at,expires_at,repos) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(hash, 'owner', 'key', 0, Date.now() + 10000, repos)
  f.db
    .prepare(
      'INSERT INTO profile_pictures(hash,bytes,created_at) VALUES (?, ?, ?)',
    )
    .run('orphan', new Uint8Array([1]), 0)
  await settingsScheduled(
    f.d1,
    async () => f.transport,
    async () => {
      throw Error('flush fixture failure')
    },
  )
  assert.ok(f.purged.includes('owner/demo'))
  assert.ok((await f.st.settings.states()).some((s) => s.key === 'acme/demo'))
  assert.equal(
    f.db
      .prepare('SELECT token_hash FROM api_tokens WHERE token_hash=?')
      .get('scoped'),
    undefined,
  )
  assert.ok(
    f.db
      .prepare('SELECT token_hash FROM api_tokens WHERE token_hash=?')
      .get('untouched'),
  )
  assert.ok(
    f.db
      .prepare('SELECT token_hash FROM api_tokens WHERE token_hash=?')
      .get('all'),
  )
  assert.equal(
    f.db
      .prepare('SELECT hash FROM profile_pictures WHERE hash=?')
      .get('orphan'),
    undefined,
  )
  f.db.close()
})

test('rename reclaims its own alias without redirect loops; unrelated owners cannot squat aliases', async () => {
  for (const memory of [false, true]) {
    const f = await fixture(memory)
    await f.handler(
      context('owner', 'renameOrg', { org: 'acme' }, { name: 'nextorg' }),
    )
    await f.handler(
      context('owner', 'renameOrg', { org: 'nextorg' }, { name: 'acme' }),
    )
    assert.equal(await f.st.settings.canonical('acme'), 'acme')
    assert.equal(await f.st.settings.canonical('nextorg'), 'acme')
    assert.ok(await f.st.getOrg('acme'))
    await f.st.createOrg('other', null, 'outsider')
    await assert.rejects(
      f.handler(
        context('outsider', 'renameOrg', { org: 'other' }, { name: 'nextorg' }),
      ),
      { status: 409 },
    )
    await f.handler(
      context(
        'owner',
        'renameRepo',
        { owner: 'owner', repo: 'demo' },
        { name: 'next' },
      ),
    )
    await f.handler(
      context(
        'owner',
        'renameRepo',
        { owner: 'owner', repo: 'next' },
        { name: 'demo' },
      ),
    )
    assert.equal(await f.st.settings.canonical('owner/demo'), 'owner/demo')
    assert.equal(await f.st.settings.canonical('owner/next'), 'owner/demo')
    assert.ok(f.repos.has('owner/demo'))
    assert.ok(
      !(await f.st.settings.garbage()).some((g) => g.key === 'owner/demo'),
    )
    f.db.close()
  }
})

test('rename is accepted while a push holds a lease, then copies in durable steps after it drains', async () => {
  const f = await fixture()
  f.transport.startRename = async (job) => {
    await f.st.settings.saveRename(job)
  }
  const lease = await f.st.settings.lease('owner/demo')
  const result = await f.handler(
    context(
      'owner',
      'renameRepo',
      { owner: 'owner', repo: 'demo' },
      { name: 'next' },
    ),
  )
  assert.equal(result.status, 202)
  let job = (await f.st.settings.renameJob('owner/demo'))!
  for (let i = 0; i < 110; i++)
    assert.equal(await renameStep(f.st, f.transport, job), false)
  assert.equal(job.phase, 'waiting')
  assert.ok(!f.repos.has('owner/next'))
  await f.st.settings.release(lease!)
  for (let i = 0; i < 20; i++) {
    job = (await f.st.settings.renameJob(job.id))!
    if (await renameStep(f.st, f.transport, job)) break
  }
  assert.equal(job.phase, 'complete')
  assert.equal(await f.st.settings.canonical('owner/demo'), 'owner/next')
  assert.equal((await f.st.settings.state('owner/next')).moving, false)
  f.db.close()
})

test('repository names reject .git suffixes and case variants; oversized avatars fail before decoding', () => {
  assert.equal(repoNameAvailable('demo'), true)
  for (const name of ['demo.git', 'demo.GIT', 'Demo'])
    assert.equal(repoNameAvailable(name), false, name)
  const original = globalThis.atob
  globalThis.atob = () => {
    throw Error('Decoded oversized input')
  }
  try {
    assert.throws(
      () => webpBytes('data:image/webp;base64,' + 'A'.repeat(90000)),
      /at most 64 KB/,
    )
  } finally {
    globalThis.atob = original
  }
})

test('default branch Switch persists only an existing code branch and updates the index', async () => {
  const f = await fixture(),
    changes: string[] = []
  f.transport.defaultBranch = async (key, branch) => {
    changes.push(key + ':' + branch)
  }
  await f.handler(
    context(
      'owner',
      'updateRepository',
      { owner: 'owner', repo: 'demo' },
      { defaultBranch: 'feature' },
    ),
  )
  assert.equal(
    (await f.st.settings.state('owner/demo')).defaultBranch,
    'feature',
  )
  assert.deepEqual(changes, ['owner/demo:feature'])
  for (const branch of ['missing', '_meta'])
    await assert.rejects(
      f.handler(
        context(
          'owner',
          'updateRepository',
          { owner: 'owner', repo: 'demo' },
          { defaultBranch: branch },
        ),
      ),
      { status: 422 },
    )
  assert.equal(
    (await f.st.settings.state('owner/demo')).defaultBranch,
    'feature',
  )
  f.db.close()
})

test('Git HEAD default advertisement follows the selected branch in v0 and v2', async () => {
  const { defaultAdvertisement } = await import('./git-default.ts')
  const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, '0') + s
  const main = 'a'.repeat(40),
    feature = 'b'.repeat(40)
  for (const head of [
    `${main} HEAD\0multi_ack symref=HEAD:refs/heads/main\n`,
    `${main} HEAD symref-target:refs/heads/main\n`,
  ]) {
    const refs =
      pkt(head) +
      pkt(main + ' refs/heads/main\n') +
      pkt(feature + ' refs/heads/feature\n') +
      '0000'
    const next = defaultAdvertisement(refs, 'feature')
    assert.ok(next.includes(feature + ' HEAD'))
    assert.ok(next.includes('refs/heads/feature'))
    assert.ok(!next.includes('HEAD:refs/heads/main'))
    assert.ok(!next.includes('symref-target:refs/heads/main'))
    assert.equal(defaultAdvertisement(next, 'feature'), next)
  }
})

test('org purge attempts every sibling after one repo fails and retains retryable owner state', async () => {
  const f = await fixture(),
    org = await f.st.settings.state('acme')
  org.deletedAt = Date.now() - RESTORE_MS - 100
  await f.st.settings.putState(org)
  for (const key of ['acme/demo', 'acme/second'])
    await f.st.settings.putState(await f.st.settings.state(key))
  const attempted: string[] = []
  f.transport.purge = async (key) => {
    attempted.push(key)
    if (key === 'acme/demo') throw Error('One repo failed')
  }
  await purgeDeleted(f.st, f.transport)
  assert.deepEqual(attempted, ['acme/demo', 'acme/second', 'acme'])
  assert.ok((await f.st.settings.states()).some((s) => s.key === 'acme'))
  f.db.close()
})

test('picture reupload refreshes grace time for an existing unreferenced hash', async () => {
  const { settingsScheduled } = await import('./settings-scheduled.ts')
  const f = await fixture()
  f.db
    .prepare(
      'INSERT INTO profile_pictures(hash,bytes,created_at) VALUES (?,?,?)',
    )
    .run('reused', new Uint8Array([1]), 0)
  await f.st.settings.savePicture('reused', new Uint8Array([1]))
  await settingsScheduled(
    f.d1,
    async () => f.transport,
    async () => {},
  )
  assert.ok(
    f.db
      .prepare('SELECT hash FROM profile_pictures WHERE hash=?')
      .get('reused'),
  )
  f.db.close()
})

test('org and child rename/archive locks exclude one another', async () => {
  for (const memory of [false, true]) {
    const f = await fixture(memory)
    await f.st.settings.lock('acme/demo')
    await assert.rejects(f.st.settings.lock('acme'), { status: 409 })
    await f.st.settings.unlock('acme/demo')
    await f.st.settings.lock('acme')
    await assert.rejects(f.st.settings.lock('acme/demo'), { status: 409 })
    await f.st.settings.unlock('acme')
    f.db.close()
  }
})

test('repo creation publishes a reserved destination without leaving it hidden or releasing its name', async () => {
  const { entity } = await import('./settings-store.ts')
  const f = await fixture()
  await f.st.settings.reserve('owner/new-repo')
  await assert.rejects(f.st.settings.reserve('owner/new-repo'), { status: 409 })
  assert.equal(
    (
      await settingsHTTP(
        new Request('http://forge/owner/new-repo'),
        f.st,
        async () => new Response('created'),
      )
    ).status,
    404,
  )
  await f.st.settings.putState(entity('owner/new-repo'))
  await f.st.settings.unreserve('owner/new-repo')
  assert.equal(
    (
      await settingsHTTP(
        new Request('http://forge/owner/new-repo'),
        f.st,
        async () => new Response('created'),
      )
    ).status,
    200,
  )
  await assert.rejects(f.st.settings.reserve('owner/new-repo'), { status: 409 })
  f.db.close()
})

test('lifecycle fencing preserves API-stack malformed-path 400 responses before forwarding', async () => {
  const f = await fixture()
  for (const path of [
    '/api/v1/repos/owner/%zz/issues',
    '/owner/%zz.git/git-upload-pack',
  ]) {
    const r = await settingsHTTP(
      new Request('http://forge' + path, { method: 'POST' }),
      f.st,
      async () => {
        throw Error('Malformed path reached handler')
      },
    )
    assert.equal(r.status, 400)
  }
  f.db.close()
})

test('cron recovers persisted rename after scheduling RPC failure without releasing its fence', async () => {
  const { settingsScheduled } = await import('./settings-scheduled.ts')
  const f = await fixture(),
    resumed: string[] = []
  f.transport.startRename = async (job) => {
    await f.st.settings.saveRename(job)
    throw Error('Scheduling RPC interrupted')
  }
  f.transport.resumeRename = async (id) => {
    resumed.push(id)
  }
  const r = await f.handler(
    context(
      'owner',
      'renameRepo',
      { owner: 'owner', repo: 'demo' },
      { name: 'next' },
    ),
  )
  assert.equal(r.status, 202)
  assert.equal((await f.st.settings.state('owner/demo')).moving, true)
  assert.ok((await f.st.settings.state('owner/next')).id.startsWith('reserve:'))
  await settingsScheduled(
    f.d1,
    async () => f.transport,
    async () => {},
  )
  assert.deepEqual(resumed, ['owner/demo'])
  let job = (await f.st.settings.renameJob('owner/demo'))!
  for (let i = 0; i < 20; i++) {
    job = (await f.st.settings.renameJob(job.id))!
    if (await renameStep(f.st, f.transport, job)) break
  }
  assert.equal(job.phase, 'complete')
  assert.equal((await f.st.settings.state('owner/next')).moving, false)
  f.db.close()
})

test('runner settings intent marker is minted at the Worker boundary and cannot be forged', async()=>{
 const f=await fixture()
 const url='https://gild.gg/api/runner-settings/orgs/acme/actions/runner-groups'
 let forwarded=false
 const bad=await settingsHTTP(new Request(url,{method:'POST',headers:{cookie:'gild_session=fixture',origin:'https://evil.example','x-gild-browser-intent':'same-origin'}}),f.st,async()=>{forwarded=true;return new Response('bad')})
 assert.equal(bad.status,403);assert.equal(forwarded,false)
 const good=await settingsHTTP(new Request(url,{method:'POST',headers:{cookie:'gild_session=fixture',origin:'https://gild.gg'}}),f.st,async r=>{assert.equal(r.headers.get('x-gild-browser-intent'),'same-origin');return new Response('ok')})
 assert.equal(good.status,200)
 await settingsHTTP(new Request(url,{headers:{'x-gild-browser-intent':'same-origin'}}),f.st,async r=>{assert.equal(r.headers.get('x-gild-browser-intent'),null);return new Response('ok')})
 f.db.close()
})

test('DELETE pictures preserves profile fields and blobs, isolates accounts, and requires org admin access', async () => {
  const { profileView } = await import('./profile-view.ts')
  const { openapi } = await import('./api/openapi.ts')
  for (const memory of [false, true]) {
    const f = await fixture(memory)
    const saved = {
      ...(await f.st.settings.profile('owner')),
      displayName: 'Owner',
      picture: '/avatars/shared',
    }
    await f.st.settings.savePicture('shared', new Uint8Array([1, 2]))
    await f.st.settings.saveProfile('owner', saved)
    // /user always targets the authenticated caller, never somebody else's profile.
    await f.handler(context('outsider', 'deletePicture'))
    assert.equal(
      (await f.st.settings.profile('owner')).picture,
      '/avatars/shared',
    )
    await assert.rejects(f.handler(context('unclaimed', 'deletePicture')), {
      status: 404,
    })
    const result = await f.handler(context('owner', 'deletePicture'))
    assert.deepEqual(result.data, { ...saved, picture: null })
    assert.equal((await profileView(f.st, 'owner')).picture.source, 'Gravatar')
    assert.ok(
      await f.st.settings.picture('shared'),
      'Content hash remains readable for other profiles/caches',
    )
    for (const actor of ['member', 'outsider', 'owner', 'adminuser']) {
      await f.st.settings.saveProfile('acme', {
        ...saved,
        publicEmail: 'org@example.com',
      })
      const c = context(actor, 'deleteOrgPicture', { org: 'acme' })
      if (['owner', 'adminuser'].includes(actor)) {
        await f.handler(c)
        assert.equal((await f.st.settings.profile('acme')).picture, null)
        assert.equal(
          (await profileView(f.st, 'acme', true)).picture.source,
          'Gravatar',
        )
      } else {
        await assert.rejects(f.handler(c), { status: 404 })
        assert.equal(
          (await f.st.settings.profile('acme')).picture,
          saved.picture,
        )
      }
    }
    // Run actual dispatch behind the production CSRF gate and assert stored state.
    for (const [path, name] of [
      ['/user/picture', 'owner'],
      ['/orgs/acme/picture', 'acme'],
    ]) {
      await f.st.settings.saveProfile(name, saved)
      const run = async (origin: string) => {
        const r = new Request('http://forge/api/v1' + path, {
          method: 'DELETE',
          headers: {
            cookie: 'gild_session=fixture',
            origin,
            'sec-fetch-site':
              origin === 'http://forge' ? 'same-origin' : 'cross-site',
          },
        })
        return settingsHTTP(r, f.st, (request) =>
          dispatch(request, {
            authenticate: async () =>
              context('owner', 'deletePicture').principal,
            execute: f.handler,
            authorize: async () => {},
            control: async () =>
              ({
                rate: () => ({
                  allowed: true,
                  limit: 10000,
                  remaining: 9999,
                  reset: Date.now() + 3600000,
                }),
                begin: () => ({ kind: 'new', claim: 'fixture' }),
                activate: () => true,
                finish: () => {},
                release: () => {},
              }) satisfies Control,
          }),
        )
      }
      assert.equal((await run('https://evil.example')).status, 403)
      assert.equal((await f.st.settings.profile(name)).picture, saved.picture)
      const r = await run('http://forge')
      assert.equal(r.status, 200, await r.clone().text())
      assert.equal((await r.json()).picture, null)
      assert.equal((await f.st.settings.profile(name)).picture, null)
    }
    f.db.close()
  }
  for (const path of ['/user/picture', '/orgs/{org}/picture'])
    assert.ok(openapi().paths[path].delete)
})
