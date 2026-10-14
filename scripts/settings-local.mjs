import { gravatarNetwork, verifyGravatar } from './gravatar-browser.mjs'
import { promisify } from 'node:util'
import { routes } from '../lib/api/contract.ts'
import { match } from '../lib/api/routing.ts'
// Full OpenNext app on local workerd with actual D1/DOs and a local Git/Artifacts
// transport. No remote credentials or remote writes; fixtures are disposable.
import { createServer } from 'node:http'
import { spawn, spawnSync, execFileSync, execFile } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { randomBytes, createHash, createHmac } from 'node:crypto'
import { launchChrome } from './chrome.mjs'
import assert from 'node:assert/strict'
import { forgeFixture } from './forge-fixture.mjs'
const fixture=await forgeFixture({repoList:process.argv.includes('--repo-list')})
const {work,gitRoot,git,seedRepo,metadata,tokens,server,origin,worker,cookie,sessionSecret,sha,orgSha,config,state}=fixture
const validated = new Set()
const request = async (actor, path, method = 'GET', body) => {
  const response = await fetch(origin + path, {
    method,
    headers: {
      authorization: 'Bearer ' + tokens[actor],
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  const found = path.startsWith('/api/v1/')
    ? match(method, path.slice(7))
    : null
  if (response.ok && found?.route.phase === 'D') {
    const data = await response.clone().json(),
      parsed = found.route.output.safeParse(data)
    assert.equal(
      parsed.success,
      true,
      found.route.id + ' ' + JSON.stringify(data),
    )
    validated.add(found.route.id)
  }
  return response
}
async function waitRename(path) {
  for (let i = 0; i < 120; i++) {
    const r = await request('avatest', path)
    if (r.status === 308) {
      path = new URL(r.headers.get('location')).pathname
      continue
    }
    assert.equal(r.status, 200, await r.clone().text())
    const { job } = await r.json()
    if (job?.phase === 'complete') return job
    assert.notEqual(job?.phase, 'failed', job?.error)
    await new Promise((r) => setTimeout(r, 250))
  }
  throw Error('Rename alarm did not finish')
}
// Git receive-pack and direct fixture ref changes do not promise that API
// authorization can already read the refreshed index. Probe the actual read
// boundary so both alarm work and the ref-advertisement cache must converge.
async function waitIndex(key) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const response = await request('avatest', '/api/v1/repos/' + key + '/actions')
    if (response.status === 200) return response.json()
    assert.ok(
      [404, 503].includes(response.status),
      'Unexpected Actions readiness response: ' + response.status + ' ' + await response.text(),
    )
    await new Promise((r) => setTimeout(r, 250))
  }
  throw Error('Repository API/index did not become ready: ' + key)
}
async function dispatchRenamed() {
  const response = await request(
    'avatest',
    '/api/v1/repos/settingsrenamed/renamed/actions/workflows/ci.yml/dispatches',
    'POST',
    { ref: 'main' },
  )
  assert.equal(response.status, 201, await response.text())
}
let browser
async function verify() {
  for (let i = 0; i < 100; i++) {
    if (worker.exitCode !== null) throw Error(fixture.logs)
    try {
      await fetch(origin + '/api/v1/openapi.json')
      break
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  const ready = await fetch(origin + '/api/v1/openapi.json')
  assert.equal(ready.status, 200, await ready.text())
  console.log('Full OpenNext workerd fixture ready')
  if (process.argv.includes('--repo-list')) {
    browser = await launchChrome()
    await (await import('./repo-list-browser.mjs')).verifyRepoList({browser,origin,request,cookie,work,gitRoot,git,workerLog:()=>fixture.logs})
    return
  }
  if (process.argv.includes('--dispatch-race')) {
    // Picture DELETEs use the real product routes before both renames.
    for (const path of [
      '/api/v1/user/picture',
      '/api/v1/orgs/settingstest/picture',
    ]) {
      const response = await request('avatest', path, 'DELETE')
      assert.equal(response.status, 200, await response.text())
    }
    await request('avatest', '/api/v1/repos/settingstest/demo/actions')
    await waitIndex('settingstest/demo')
    for (const [path, name] of [
      ['/api/v1/orgs/settingstest/rename', 'settingsrenamed'],
      ['/api/v1/repos/settingsrenamed/demo/rename', 'renamed'],
    ]) {
      const response = await request('avatest', path, 'POST', { name })
      assert.equal(response.status, 202, await response.text())
      await waitRename(path)
    }
    const response = await fetch(
      origin + '/__fixture/refresh?key=settingsrenamed/renamed',
    )
    assert.equal(response.status, 200)
    assert.equal((await response.json()).ready, false)
    await waitIndex('settingsrenamed/renamed')
    await dispatchRenamed()
    console.log(
      'Delayed index refresh after picture DELETEs and double rename: dispatch 201. Evidence: ' + work,
    )
    return
  }
  for (const [path, method, body] of [
    ['/api/account/profile', 'PATCH', { displayName: 'Cross-site' }],
    ['/api/orgs/settingstest/memberships/outsider', 'PUT', { role: 'owner' }],
    ['/api/orgs/settingstest/rename', 'POST', { name: 'stolen' }],
    ['/api/orgs/settingstest/archive', 'PUT', { archived: true }],
    ['/api/orgs/settingstest', 'DELETE', { confirm: 'settingstest' }],
    ['/api/account/picture', 'PUT', { data: 'bad' }],
    ['/api/account/picture', 'DELETE', {}],
    ['/api/orgs/settingstest/picture', 'DELETE', {}],
    [
      '/api/repos/avatest/glance-test/actions/settings/secrets/CSRF',
      'PUT',
      { value: 'forbidden' },
    ],
  ]) {
    const denied = await fetch(origin + path, {
      method,
      headers: {
        cookie: 'gild_session=' + cookie('avatest'),
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    assert.equal(denied.status, 403, path)
  }
  assert.notEqual(
    (await (await request('avatest', '/api/v1/user/profile')).json())
      .displayName,
    'Cross-site',
  )
  assert.equal(
    (
      await (await request('avatest', '/api/orgs/settingstest')).json()
    ).members.some((m) => m.member === 'outsider'),
    false,
  )
  console.log(
    'Cross-site cookie settings/member/lifecycle/picture/secret requests refused before writes',
  )

  browser = await launchChrome()
  const page = await browser.newPage()
  const present = await gravatarNetwork(page)
  await page.context().addCookies([
    {
      name: 'gild_session',
      value: cookie('avatest'),
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
    },
  ])
  // Index through the real git service before capturing; no fake response data.
  for (const path of [
    '/avatest/glance-test',
    '/settingstest/demo',
    '/settingstest/tools',
    '/settingstest/runner-images',
  ]) {
    await page.goto(origin + path)
    await page.waitForTimeout(1000)
  }
  for (const [actor, allowed] of [
    ['', false],
    ['member', false],
    ['adminuser', true],
    ['avatest', true],
    ['outsider', false],
  ]) {
    const ctx = await browser.newContext()
    if (actor)
      await ctx.addCookies([
        {
          name: 'gild_session',
          value: cookie(actor),
          domain: '127.0.0.1',
          path: '/',
        },
      ])
    const p = await ctx.newPage()
    for (const path of [
      '/orgs/settingstest/settings/general',
      '/orgs/settingstest/settings/members',
      '/settingstest/demo/settings/general',
      '/settingstest/demo/settings/actions',
      '/settingstest/demo/settings/webhooks',
    ]) {
      const r = await p.goto(origin + path)
      assert.equal(r.status(), allowed ? 200 : 404, actor + ' ' + path)
      if (!allowed)
        assert.equal(
          await p.getByRole('link', { name: 'Settings', exact: true }).count(),
          0,
        )
    }
    for (const section of [
      'profile',
      'organizations',
      'keys',
      'tokens',
      'agents',
      'runners',
    ]) {
      const account = await p.goto(origin + '/settings/' + section)
      assert.equal(account.status(), actor ? 200 : 404, actor + ' ' + section)
    }
    await ctx.close()
  }
  console.log(
    'Browser permission table passed: anonymous/member/admin/owner/outsider',
  )
  for (const [path, method, body] of [
    ['/user/profile', 'GET'],
    ['/user/profile', 'PATCH', { displayName: 'Ava Test' }],
    ['/orgs/settingstest/profile', 'GET'],
    ['/orgs/settingstest/profile', 'PATCH', { displayName: 'gild' }],
    ['/orgs/settingstest/memberships/second', 'PUT', { role: 'member' }],
    ['/orgs/settingstest/memberships/second', 'DELETE'],
    [
      '/repos/avatest/glance-test',
      'PATCH',
      { description: 'A real local Git repository' },
    ],
    ['/orgs/settingstest/archive', 'PUT', { archived: true }],
    ['/orgs/settingstest/archive', 'PUT', { archived: false }],
    [
      '/repos/avatest/glance-test',
      'DELETE',
      { confirm: 'avatest/glance-test' },
    ],
    ['/repos/avatest/glance-test/restore', 'POST', {}],
  ]) {
    const r = await request('avatest', '/api/v1' + path, method, body)
    assert.equal(r.status, 200, await r.text())
  }
  await request(
    'avatest',
    '/api/v1/orgs/settingstest/memberships/second',
    'PUT',
    { role: 'member' },
  )
  let leave = await request(
    'second',
    '/api/v1/user/memberships/orgs/settingstest',
    'DELETE',
  )
  assert.equal(leave.status, 200, await leave.text())
  const picture = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 128
    c.height = 128
    c.getContext('2d').fillStyle = '#2f6fd6'
    c.getContext('2d').fillRect(0, 0, 128, 128)
    return c.toDataURL('image/webp')
  })
  const saved = await request('avatest', '/api/v1/user/picture', 'PUT', {
    data: picture,
  })
  assert.equal(saved.status, 200, await saved.clone().text())
  const profile = await saved.json(),
    avatar = await fetch(origin + profile.picture),
    bytes = Buffer.from(await avatar.arrayBuffer())
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    profile.picture.split('/').pop(),
  )
  assert.match(avatar.headers.get('cache-control'), /immutable/)

  if (process.argv.includes('--gravatar')) {
    await request('avatest', '/api/v1/orgs/settingstest/profile', 'PATCH', {
      displayName: 'gild',
      publicEmail: 'hello@example.com',
      description: 'The forge for people and agents',
      url: 'https://gild.gg',
      location: 'Canada',
    })
    await request('avatest', '/api/v1/orgs/settingstest/picture', 'PUT', {
      data: picture,
    })
    await verifyGravatar({
      page, browser, origin, request, cookie, picture, present,
    })
    for (const id of ['deletePicture', 'deleteOrgPicture'])
      assert.ok(validated.has(id), 'Real DELETE response validates: ' + id)
    console.log('Gravatar local fixture passed. Evidence: ' + work)
    return
  }
  // Real write-route permission matrix. Rejections must leave stored values intact.
  for (const actor of ['', 'member', 'adminuser', 'avatest', 'outsider']) {
    const allowed = ['adminuser', 'avatest'].includes(actor),
      who = actor || 'anonymous'
    for (const [path, method, body] of [
      ['/orgs/settingstest/profile', 'PATCH', { location: who }],
      ['/orgs/settingstest/picture', 'PUT', { data: picture }],
      ['/orgs/settingstest/picture', 'DELETE', undefined],
      ['/orgs/settingstest/memberships/second', 'PUT', { role: 'admin' }],
      ['/repos/settingstest/demo', 'PATCH', { description: who }],
    ]) {
      const r = await request(actor, '/api/v1' + path, method, body)
      assert.equal(
        r.status,
        allowed ? 200 : actor ? 404 : 401,
        who + ' ' + path + ' ' + (await r.text()),
      )
    }
    const membership = await (
      await request('avatest', '/api/orgs/settingstest')
    ).json()
    assert.equal(
      membership.members.some((m) => m.member === 'second'),
      allowed,
    )
    if (allowed) {
      const r = await request(
        actor,
        '/api/v1/orgs/settingstest/memberships/second',
        'DELETE',
      )
      assert.equal(r.status, 200)
      assert.equal(
        (
          await (await request('avatest', '/api/orgs/settingstest')).json()
        ).members.some((m) => m.member === 'second'),
        false,
      )
    } else {
      assert.equal(
        (
          await request(
            actor,
            '/api/v1/orgs/settingstest/memberships/member',
            'DELETE',
          )
        ).status,
        actor ? 404 : 401,
      )
      assert.equal(
        (
          await (await request('avatest', '/api/orgs/settingstest')).json()
        ).members.some((m) => m.member === 'member'),
        true,
      )
    }
    for (const [path, method, body] of [
      ['/actions/settings', 'PUT', { required: ['permission.yml'] }],
      [
        '/actions/settings/secrets/MATRIX_TEST',
        'PUT',
        { value: 'disposable-' + who },
      ],
    ]) {
      const r = await request(
        actor,
        '/api/v1/repos/settingstest/demo' + path,
        method,
        body,
      )
      assert.equal(
        r.status,
        allowed ? 200 : actor ? 403 : 401,
        who + ' ' + path + ' ' + (await r.text()),
      )
    }
    const secrets = await (
      await request(
        'avatest',
        '/api/v1/repos/settingstest/demo/actions/settings/secrets',
      )
    ).json()
    assert.equal(
      secrets.secrets.some((s) => s.name === 'MATRIX_TEST'),
      allowed,
    )
    if (allowed) {
      const stored = await (
        await fetch(
          origin +
            '/__fixture/state?key=settingstest/demo&expected=' +
            encodeURIComponent('disposable-' + who),
        )
      ).json()
      assert.equal(stored.secretMatches, true)
      assert.deepEqual(
        (
          await (
            await request('avatest', '/api/v1/repos/settingstest/demo/actions')
          ).json()
        ).required,
        ['permission.yml'],
      )
      assert.equal(
        (
          await request(
            actor,
            '/api/v1/repos/settingstest/demo/actions/settings/secrets/MATRIX_TEST',
            'DELETE',
          )
        ).status,
        200,
      )
      assert.equal(
        (
          await (
            await request(
              'avatest',
              '/api/v1/repos/settingstest/demo/actions/settings/secrets',
            )
          ).json()
        ).secrets.length,
        0,
      )
    } else {
      assert.equal(
        (
          await request(
            actor,
            '/api/v1/repos/settingstest/demo/actions/settings/secrets/MATRIX_TEST',
            'DELETE',
          )
        ).status,
        actor ? 403 : 401,
      )
    }
    for (const kind of ['orgs/settingstest', 'repos/settingstest/demo'])
      for (const [operation, method, body] of [
        ['rename', 'POST', { name: 'forbidden' }],
        ['archive', 'PUT', { archived: true }],
        ['', 'DELETE', { confirm: kind.slice(kind.indexOf('/') + 1) }],
        ['restore', 'POST', {}],
      ])
        if (actor !== 'avatest') {
          const r = await request(
            actor,
            '/api/v1/' + kind + (operation ? '/' + operation : ''),
            method,
            body,
          )
          assert.equal(
            r.status,
            actor ? 404 : 401,
            who + ' ' + kind + ' ' + operation + ' ' + (await r.text()),
          )
        }
    const legacy = await request(
      actor,
      '/api/v1/orgs/settingstest/members',
      'POST',
      { member: 'second', role: 'member' },
    )
    assert.equal(legacy.status, allowed ? 201 : actor ? 404 : 401)
    assert.equal(
      (
        await (await request('avatest', '/api/orgs/settingstest')).json()
      ).members.some((m) => m.member === 'second'),
      allowed,
    )
    if (allowed)
      assert.equal(
        (
          await request(
            actor,
            '/api/v1/orgs/settingstest/memberships/second',
            'DELETE',
          )
        ).status,
        200,
      )
    const accountPicture = await request(actor, '/api/v1/user/picture', 'PUT', {
      data: picture,
    })
    assert.equal(accountPicture.status, actor ? 200 : 401)
    if (actor)
      assert.equal(
        (await (await request(actor, '/api/v1/user/profile')).json()).picture,
        (await accountPicture.json()).picture,
      )
    const departed = await request(
      actor,
      '/api/v1/user/memberships/orgs/settingstest',
      'DELETE',
    )
    assert.equal(
      departed.status,
      ['member', 'adminuser'].includes(actor)
        ? 200
        : actor === 'avatest'
          ? 409
          : actor
            ? 404
            : 401,
    )
    if (['member', 'adminuser'].includes(actor)) {
      assert.equal(
        (
          await (await request('avatest', '/api/orgs/settingstest')).json()
        ).members.some((m) => m.member === actor),
        false,
      )
      assert.equal(
        (
          await request(
            'avatest',
            '/api/v1/orgs/settingstest/memberships/' + actor,
            'PUT',
            { role: actor === 'adminuser' ? 'admin' : 'member' },
          )
        ).status,
        200,
      )
    }
    for (const resource of [
      '/orgs/settingstest/hooks',
      '/repos/settingstest/demo/hooks',
    ]) {
      const hook = await request(actor, '/api/v1' + resource, 'POST', {
        name: 'web',
        active: false,
        events: ['push'],
        config: {
          url: 'https://hooks.fixture.test/hook',
          secret: 'local-matrix-hook',
          content_type: 'json',
          insecure_ssl: '0',
        },
      })
      assert.equal(
        hook.status,
        allowed ? 201 : actor ? 403 : 401,
        who + ' ' + resource + ' ' + (await hook.clone().text()),
      )
      if (allowed) {
        const h = await hook.json()
        assert.equal(
          (await (await request('avatest', '/api/v1' + resource)).json()).some(
            (row) => row.id === h.id,
          ),
          true,
        )
        assert.equal(
          (
            await request(actor, '/api/v1' + resource + '/' + h.id, 'PATCH', {
              active: true,
            })
          ).status,
          200,
        )
        assert.equal(
          (
            await (
              await request('avatest', '/api/v1' + resource + '/' + h.id)
            ).json()
          ).active,
          true,
        )
        assert.equal(
          (await request(actor, '/api/v1' + resource + '/' + h.id, 'DELETE'))
            .status,
          200,
        )
        assert.equal(
          (await (await request('avatest', '/api/v1' + resource)).json()).some(
            (row) => row.id === h.id,
          ),
          false,
        )
      } else
        for (const method of ['PATCH', 'DELETE'])
          assert.equal(
            (
              await request(
                actor,
                '/api/v1' + resource + '/999',
                method,
                method === 'PATCH' ? { active: true } : undefined,
              )
            ).status,
            actor ? 403 : 401,
          )
    }
    const orgName = 'created-' + (actor || 'anonymous')
    const created = await request(actor, '/api/orgs', 'POST', {
      name: orgName,
      description: 'Disposable matrix organization',
    })
    assert.equal(created.status, actor ? 201 : 401)
    const token = await request(actor, '/api/v1/user/tokens', 'POST', {
      label: 'Disposable matrix token',
      scopes: ['repo:read'],
    })
    assert.equal(token.status, actor ? 201 : 401)
    if (actor) {
      assert.equal(
        (await (await request(actor, '/api/orgs/' + orgName)).json()).members[0]
          .role,
        'owner',
      )
      assert.equal(
        (
          await request(actor, '/api/v1/orgs/' + orgName, 'DELETE', {
            confirm: orgName,
          })
        ).status,
        200,
      )
      const issued = await token.json()
      assert.equal(
        (await (await request(actor, '/api/v1/user/tokens')).json()).some(
          (t) => t.id === issued.id,
        ),
        true,
      )
      assert.equal(
        (await request(actor, '/api/v1/user/tokens/' + issued.id, 'DELETE'))
          .status,
        200,
      )
      assert.equal(
        (await (await request(actor, '/api/v1/user/tokens')).json()).some(
          (t) => t.id === issued.id,
        ),
        false,
      )
    }
    if (actor) {
      const updated = await request(actor, '/api/v1/user/profile', 'PATCH', {
        displayName: who,
      })
      assert.equal(updated.status, 200)
      assert.equal(
        (await (await request(actor, '/api/v1/user/profile')).json())
          .displayName,
        who,
      )
    } else
      assert.equal(
        (
          await request(actor, '/api/v1/user/profile', 'PATCH', {
            displayName: who,
          })
        ).status,
        401,
      )
  }
  assert.equal(
    (
      await request(
        'avatest',
        '/api/v1/orgs/settingstest/memberships/avatest',
        'DELETE',
      )
    ).status,
    409,
  )
  assert.equal(
    (
      await request(
        'avatest',
        '/api/v1/user/memberships/orgs/settingstest',
        'DELETE',
      )
    ).status,
    409,
  )
  assert.equal(
    (
      await request(
        'avatest',
        '/api/v1/orgs/settingstest/memberships/avatest',
        'PUT',
        { role: 'admin' },
      )
    ).status,
    409,
  )
  assert.equal(
    (
      await request(
        'adminuser',
        '/api/v1/orgs/settingstest/memberships/second',
        'PUT',
        { role: 'owner' },
      )
    ).status,
    403,
  )
  assert.equal(
    (await request('avatest', '/api/orgs', 'POST', { name: 'orgs' })).status,
    422,
  )
  assert.equal(
    (
      await fetch(origin + '/api/claim/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'settings',
          publicKey: 'ed25519:' + 'A'.repeat(60),
          email: 'fixture@example.com',
        }),
      })
    ).status,
    400,
  )
  assert.equal(
    (await fetch(origin + '/__fixture/scheduled?expire=1')).status,
    200,
  )
  console.log(
    'Real settings write permission matrix and last-owner/reserved-name checks passed',
  )

  const oversized = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 1024
    c.height = 512
    const x = c.getContext('2d')
    ;['#e2b54a', '#7fc77a', '#c792ea', '#2f6fd6'].forEach((color, i) => {
      x.fillStyle = color
      x.fillRect(i * 256, 0, 256, 512)
    })
    return { png: c.toDataURL('image/png'), webp: c.toDataURL('image/webp') }
  })
  assert.equal(
    (
      await request('avatest', '/api/v1/user/picture', 'PUT', {
        data: oversized.webp,
      })
    ).status,
    422,
  )
  await page.goto(origin + '/orgs/settingstest/settings/general')
  await page.locator('input[type=file]').setInputFiles({
    name: 'profile.png',
    mimeType: 'image/png',
    buffer: Buffer.from(oversized.png.split(',')[1], 'base64'),
  })
  await page
    .getByRole('status')
    .filter({ hasText: 'Picture updated' })
    .waitFor()
  const photo = await (
    await request('avatest', '/api/v1/orgs/settingstest/profile')
  ).json()
  assert.match(photo.picture, /^\/avatars\/[a-f0-9]{64}$/)
  const timings = await page.evaluate(async (url) => {
    const samples = []
    for (const cache of ['reload', 'default']) {
      const start = performance.now(),
        r = await fetch(url, { cache })
      await r.arrayBuffer()
      samples.push({
        ms: Math.round((performance.now() - start) * 100) / 100,
        cacheControl: r.headers.get('cache-control'),
      })
    }
    return samples
  }, photo.picture)
  console.log('Picture HTTP first/repeat samples: ' + JSON.stringify(timings))
  await page.goto(origin + '/orgs/settingstest/settings/general')
  await page.getByLabel('Display name', { exact: true }).fill('gild')
  await page
    .getByLabel('Public email', { exact: true })
    .fill('hello@example.com')
  await page
    .getByLabel('Description', { exact: true })
    .fill('The forge for people and agents')
  await page.getByLabel('URL', { exact: true }).fill('https://gild.gg')
  await page.getByLabel('Location', { exact: true }).fill('Canada')
  await page
    .getByRole('button', { name: 'Update profile', exact: true })
    .click()
  await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor()
  await page.goto(origin + '/orgs/settingstest/settings/members')
  await page.getByLabel('Add by gild name').fill('outsider')
  await page.getByRole('button', { name: 'Add member', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Member added' }).waitFor()
  assert.equal(
    (
      await (await request('avatest', '/api/orgs/settingstest')).json()
    ).members.find((m) => m.member === 'outsider').role,
    'member',
  )
  await page.getByLabel('Role for outsider').selectOption('admin')
  await page.getByRole('status').filter({ hasText: 'Role updated' }).waitFor()
  assert.equal(
    (
      await (await request('avatest', '/api/orgs/settingstest')).json()
    ).members.find((m) => m.member === 'outsider').role,
    'admin',
  )
  await page.goto(origin + '/avatest/glance-test/settings/actions')
  await page.getByLabel('Name', { exact: true }).fill('SETTINGS_TEST')
  await page.getByLabel('Value', { exact: true }).fill('local-fixture-value')
  await page.getByRole('button', { name: 'Add or update secret' }).click()
  await page.getByRole('status').waitFor()
  assert.equal(
    (
      await (
        await request(
          'avatest',
          '/api/v1/repos/avatest/glance-test/actions/settings/secrets',
        )
      ).json()
    ).secrets[0].name,
    'SETTINGS_TEST',
  )
  await page.getByLabel('Workflow files').fill('ci.yml\nsecurity.yml')
  await page.getByRole('button', { name: 'Save required workflows' }).click()
  await page.getByRole('status').waitFor()
  const registered = await request(
    'avatest',
    '/api/v1/repos/avatest/glance-test/actions/runners',
    'POST',
    {
      name: 'mac-mini',
      labels: ['self-hosted', 'macOS'],
      os: 'macos',
      arch: 'arm64',
    },
  )
  assert.equal(registered.status, 201, await registered.text())
  console.log('Real browser profile/member/role/secret/workflow forms passed')
  await page.goto(origin + '/avatest/glance-test/settings/general')
  assert.deepEqual(
    (
      await page
        .getByLabel('Default branch', { exact: true })
        .locator('option')
        .allTextContents()
    ).sort(),
    ['feature', 'main'],
  )
  await page
    .getByLabel('Default branch', { exact: true })
    .selectOption('feature')
  await page.getByRole('button', { name: 'Switch', exact: true }).click()
  await page
    .getByRole('status')
    .filter({ hasText: 'Default branch switched' })
    .waitFor()
  assert.equal(
    (
      await (
        await request('avatest', '/api/v1/repos/avatest/glance-test')
      ).json()
    ).default_branch,
    'feature',
  )
  for (const version of ['0', '2']) {
    const dest = join(work, 'default-' + version)
    await promisify(execFile)(
      'git',
      [
        '-c',
        'protocol.version=' + version,
        'clone',
        origin + '/avatest/glance-test.git',
        dest,
      ],
      { timeout: 60000 },
    )
    assert.equal(git(dest, 'branch', '--show-current'), 'feature')
  }
  await request('avatest', '/api/repos/avatest/glance-test', 'PATCH', {
    defaultBranch: 'main',
  })
  await page.goto(origin + '/settingstest')
  assert.equal(
    await page.getByRole('heading', { name: 'Runners', exact: true }).count(),
    0,
  )
  await request('avatest', '/api/repos/settingstest/demo', 'PATCH', {
    description: 'The forge for people and agents',
  })
  await request('avatest', '/api/repos/settingstest/tools', 'PATCH', {
    description: 'Command line tools for the forge',
  })
  await request('avatest', '/api/repos/settingstest/runner-images', 'PATCH', {
    description: 'Self-hosted runner setup and workflows',
  })
  const orgRunner = await request(
    'avatest',
    '/api/v1/repos/settingstest/demo/actions/runners',
    'POST',
    {
      name: 'overview-runner',
      labels: ['self-hosted'],
      os: 'macos',
      arch: 'arm64',
    },
  )
  assert.equal(orgRunner.status, 201)
  const overviewTimes = []
  for (let i = 0; i < 2; i++) {
    const start = Date.now(),
      r = await page.goto(origin + '/settingstest')
    assert.equal(r.status(), 200)
    await page
      .getByRole('heading', { name: 'Repositories', exact: true })
      .waitFor()
    overviewTimes.push(Date.now() - start)
    assert.ok(await page.getByRole('link', { name: 'New repo' }).count())
    assert.ok((await page.locator('main').innerText()).includes('TypeScript'))
    assert.ok((await page.locator('main').innerText()).includes('cqx '))
    assert.equal(
      await page.getByRole('heading', { name: 'Members', exact: true }).count(),
      0,
    )
  }
  console.log(
    'Org Overview first/cached page timings (ms): ' +
      JSON.stringify(overviewTimes),
  )

  const screenshots = resolve('docs/settings/screenshots')
  mkdirSync(screenshots, { recursive: true })
  for (const theme of ['dark', 'light'])
    for (const width of [1400, 400]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.evaluate(
        (theme) => localStorage.setItem('gild.theme', theme),
        theme,
      )
      for (const [area, path] of [
        ['account', '/settings/organizations'],
        ['org', '/orgs/settingstest/settings/general'],
        ['members', '/orgs/settingstest/settings/members'],
        ['repo', '/avatest/glance-test/settings/general'],
        ['actions', '/avatest/glance-test/settings/actions'],
        ['main', '/settingstest'],
      ]) {
        const response = await page.goto(origin + path)
        assert.equal(response.status(), 200, path)
        await page.waitForTimeout(300)
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
          'No horizontal overflow ' + width + ' ' + path,
        )
        await page.screenshot({
          path: join(screenshots, `${area}-${width}-${theme}.png`),
          fullPage: true,
        })
        if (area === 'repo') {
          await page
            .getByRole('button', {
              name: 'Delete this repository',
              exact: true,
            })
            .click()
          await page
            .getByRole('dialog')
            .getByRole('textbox')
            .fill('avatest/glance-test')
          await page.screenshot({
            path: join(screenshots, `delete-${width}-${theme}.png`),
            fullPage: true,
          })
          await page
            .getByRole('button', { name: 'Cancel', exact: true })
            .click()
        }
      }
    }
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await request(
          'avatest',
          '/api/v1/repos/avatest/glance-test/actions/workflows/ci.yml/dispatches',
          'POST',
          { ref: 'main' },
        )
      ).status,
      201,
    )
  const corner = join(work, 'corner.json')
  writeFileSync(
    corner,
    JSON.stringify({
      secret: sessionSecret,
      owner: 'avatest',
      org: 'settingstest',
      repo: 'glance-test',
      sha,
    }),
  )
  const check = spawn('npm', ['run', 'test:corner', '--', origin, corner], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let cornerLog = ''
  for (const stream of [check.stdout, check.stderr])
    stream.on('data', (b) => {
      cornerLog += b
    })
  const code = await new Promise((r) => check.on('exit', r))
  writeFileSync(join(work, 'corner.log'), cornerLog)
  assert.equal(code, 0, cornerLog)
  console.log(cornerLog.trim())
  const uploaded = await request(
    'avatest',
    '/api/v1/orgs/settingstest/picture',
    'PUT',
    { data: picture },
  )
  assert.equal(uploaded.status, 200, await uploaded.text())

  assert.equal(
    (
      await request(
        'avatest',
        '/api/v1/repos/settingstest/demo/actions/settings/secrets/ORG_SECRET',
        'PUT',
        { value: 'local-purge-fixture' },
      )
    ).status,
    200,
  )
  assert.equal(
    (
      await request(
        'avatest',
        '/api/v1/repos/settingstest/demo/actions/runners',
        'POST',
        {
          name: 'org-runner',
          labels: ['self-hosted'],
          os: 'macos',
          arch: 'arm64',
        },
      )
    ).status,
    201,
  )
  assert.equal(
    (
      await request(
        'avatest',
        '/api/v1/repos/settingstest/demo/hooks',
        'POST',
        {
          name: 'web',
          active: true,
          events: ['push'],
          config: {
            url: 'https://hooks.fixture.test/hook',
            content_type: 'json',
            secret: 'disposable-fixture-hook-key',
            insecure_ssl: '0',
          },
        },
      )
    ).status,
    201,
  )
  // Actual git clone follows HTTP redirects and preserves all branches/tags/_meta.
  const pushLease = (
    await (
      await fetch(origin + '/__fixture/lease?key=settingstest/demo')
    ).json()
  ).lease
  assert.ok(pushLease)
  let response = await request(
    'avatest',
    '/api/v1/orgs/settingstest/rename',
    'POST',
    { name: 'settingsrenamed' },
  )
  assert.equal(response.status, 202, await response.text())
  // The request returns while a real write lease is held; the alarm keeps it queued.
  const waiting = (
    await (await request('avatest', '/api/v1/orgs/settingstest/rename')).json()
  ).job
  assert.equal(waiting.phase, 'waiting')
  for (const theme of ['dark', 'light'])
    for (const width of [1400, 400]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.evaluate(
        (theme) => localStorage.setItem('gild.theme', theme),
        theme,
      )
      await page.goto(origin + '/orgs/settingstest/settings/general')
      await page
        .getByRole('status')
        .filter({ hasText: 'Rename queued' })
        .waitFor()
      await page.screenshot({
        path: join(screenshots, `rename-${width}-${theme}.png`),
        fullPage: true,
      })
    }
  await fetch(origin + '/__fixture/lease?release=' + pushLease)
  await waitRename('/api/v1/orgs/settingstest/rename')
  response = await fetch(origin + '/settingstest/demo', { redirect: 'manual' })
  assert.equal(response.status, 308)
  response = await request('avatest', '/api/v1/repos/settingstest/demo')
  assert.equal(response.status, 308)
  const clone = join(work, 'clone')
  await promisify(execFile)(
    'git',
    ['clone', origin + '/settingstest/demo.git', clone],
    { timeout: 60000 },
  )
  assert.equal(git(clone, 'rev-parse', 'HEAD'), orgSha)
  assert.ok(git(clone, 'branch', '-a').includes('_meta'))
  assert.ok(git(clone, 'tag').includes('v1'))
  response = await request(
    'avatest',
    '/api/v1/repos/settingsrenamed/demo/rename',
    'POST',
    { name: 'renamed' },
  )
  assert.equal(response.status, 202, await response.text())
  await waitRename('/api/v1/repos/settingsrenamed/demo/rename')
  await promisify(execFile)('git', ['fetch', 'origin'], {
    cwd: clone,
    timeout: 60000,
  })
  await promisify(execFile)(
    'git',
    [
      '-c',
      'http.extraHeader=Authorization: Bearer ' + tokens.avatest,
      'push',
      'origin',
      'HEAD:refs/heads/redirect-push',
    ],
    { cwd: clone, timeout: 60000 },
  )
  assert.equal(
    git(
      join(gitRoot, 'o-settingsrenamed', 'renamed.git'),
      'rev-parse',
      'redirect-push',
    ),
    orgSha,
  )
  await waitIndex('settingsrenamed/renamed')
  await dispatchRenamed()

  // Keep the visual/profile scenario after the rename/dispatch lifecycle.
  await verifyGravatar({
    page, browser, origin, request, cookie, picture, present,
    org: 'settingsrenamed',
  })
  response = await request(
    'avatest',
    '/api/v1/repos/settingsrenamed/renamed/archive',
    'PUT',
    { archived: true },
  )
  assert.equal(response.status, 200, await response.text())
  const archivedClone = join(work, 'archived-clone')
  await promisify(execFile)(
    'git',
    ['clone', origin + '/settingsrenamed/renamed.git', archivedClone],
    { timeout: 60000 },
  )
  const physical = join(gitRoot, 'o-settingsrenamed', 'renamed.git')
  git(physical, 'branch', 'fetch-while-archived', orgSha)
  await promisify(execFile)(
    'git',
    ['fetch', 'origin', 'fetch-while-archived'],
    { cwd: clone, timeout: 60000 },
  )
  assert.equal(git(clone, 'rev-parse', 'FETCH_HEAD'), orgSha)
  console.log(
    'Archived native Git clone and upload-pack fetch pass; push is fenced',
  )
  const push = await promisify(execFile)(
    'git',
    [
      '-c',
      'http.extraHeader=Authorization: Bearer ' + tokens.avatest,
      'push',
      'origin',
      'HEAD:refs/heads/test-archive',
    ],
    { cwd: clone, timeout: 60000 },
  )
    .then((r) => ({ status: 0, stderr: r.stderr }))
    .catch((e) => ({ status: e.code, stderr: e.stderr }))
  assert.notEqual(push.status, 0)
  assert.match(push.stderr, /409|read-only/)
  const stopped = await waitIndex('settingsrenamed/renamed')
  assert.equal(stopped.workflow_runs.length, 1)
  assert.equal(stopped.workflow_runs[0].conclusion, 'cancelled')
  assert.equal(
    (
      await request(
        'avatest',
        '/api/v1/repos/settingsrenamed/renamed/archive',
        'PUT',
        { archived: false },
      )
    ).status,
    200,
  )
  response = await request(
    'avatest',
    '/api/v1/orgs/settingsrenamed',
    'DELETE',
    { confirm: 'settingsrenamed' },
  )
  assert.equal(response.status, 200, await response.text())
  assert.equal(
    (await request('avatest', '/api/orgs/settingsrenamed')).status,
    404,
  )
  response = await request(
    'avatest',
    '/api/v1/orgs/settingsrenamed/restore',
    'POST',
    {},
  )
  assert.equal(response.status, 200, await response.text())
  const retained = await (
    await fetch(
      origin +
        '/__fixture/state?key=settingsrenamed/renamed&id=settingstest/demo',
    )
  ).json()
  assert.equal(retained.secrets.results.length, 1)
  assert.equal(retained.runners.length, 2)
  assert.equal(retained.hooks.length, 1)
  assert.equal((await fetch(origin + '/__fixture/scheduled')).status, 200)
  assert.ok(metadata.has('o-settingsrenamed/renamed'))
  response = await request(
    'avatest',
    '/api/v1/orgs/settingsrenamed',
    'DELETE',
    { confirm: 'settingsrenamed' },
  )
  assert.equal(response.status, 200)
  assert.equal(
    (await fetch(origin + '/__fixture/scheduled?expire=1')).status,
    200,
  )
  assert.equal(metadata.has('o-settingsrenamed/renamed'), false)
  const purged = await (
    await fetch(
      origin +
        '/__fixture/state?key=settingsrenamed/renamed&id=settingstest/demo',
    )
  ).json()
  assert.equal(purged.members.results.length, 0)
  assert.equal(purged.secrets.results.length, 0)
  assert.equal(purged.hooks.length, 0)
  assert.equal(purged.runners.length, 0)
  assert.equal(purged.index.ready, false)
  assert.equal(purged.index.counts.commits, 0)
  assert.equal(
    (
      await request(
        'avatest',
        '/api/v1/orgs/settingsrenamed/restore',
        'POST',
        {},
      )
    ).status,
    404,
  )
  console.log(
    'Scheduled purge after the restore window removed physical Git repos, members, secrets, hooks and runners',
  )
  assert.deepEqual(
    [...validated].sort(),
    routes
      .filter((r) => r.phase === 'D')
      .map((r) => r.id)
      .sort(),
    'Every settings API definition validates a real response',
  )
  console.log(
    'Actual org/repo rename, old-URL git clone/fetch, archive push refusal, delete/restore and all settings response contracts passed',
  )
  console.log('Evidence: ' + work)
}
try {
  await verify()
} catch (e) {
  writeFileSync(join(work, 'failure.log'), String(e.stack))
  console.error('Evidence: ' + work)
  throw e
} finally {
  await browser?.close()
  worker.kill('SIGTERM')
  await new Promise((r) =>
    worker.exitCode !== null ? r() : worker.once('exit', r),
  )
  await new Promise((r) => server.close(r))
}
