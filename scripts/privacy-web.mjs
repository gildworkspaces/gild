// The compiled OpenNext Worker, not the transport page adapter: every app
// route and RSC representation is crawled against actual D1/DO/Git state.
import { forgeFixture } from './forge-fixture.mjs'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { launchChrome } from './chrome.mjs'
const f = await forgeFixture({ privacy: true }),
  marker = 'private-FULL-WORKER-9122',
  repo = 'settingstest/demo',
  prefix = '/api/v1/repos/' + repo
const request = (path, viewer = 'avatest', method = 'GET', body, extra = {}) =>
  fetch(f.origin + path, {
    method,
    headers: {
      ...(viewer ? { authorization: 'Bearer ' + f.tokens[viewer] } : {}),
      'cf-connecting-ip': '192.0.2.70',
      'content-type': 'application/json',
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
const json = async (r, status = 200) => {
  assert.equal(r.status, status, await r.clone().text())
  return r.json()
}
let browser
async function waitPage(path, viewer = null) {
  const end = Date.now() + 60000
  while (true) {
    const r = await request(path, viewer)
    if (r.status === 200 && r.headers.get('x-gild-state') !== 'pending') return r
    if (r.status === 202) {
      assert.equal(r.headers.get('x-gild-state'), 'pending')
      assert.equal(r.headers.get('cache-control'), 'private, no-store')
      assert.equal((await r.clone().json()).state, 'pending')
    }
    if (![200, 202, 404, 503].includes(r.status) || Date.now() > end)
      throw Error(path + ': ' + r.status + ' ' + (await r.text()))
    await new Promise((r) => setTimeout(r, 100))
  }
}
try {
  const end = Date.now() + 30000
  while (true) {
    try {
      if ((await request('/api/v1/openapi.json')).ok) break
    } catch {}
    if (Date.now() > end) throw Error('Worker startup')
    await new Promise((r) => setTimeout(r, 100))
  }
  const initial = await waitPage('/' + repo),
    publicHTML = await initial.text()
  assert.ok(publicHTML.includes(marker))
  // Real smart-HTTP push, while anonymous readers repeatedly browse the old
  // indexed tip. A pending push must never turn those reads into a 503.
  const clone = join(f.work, 'push-reader')
  await promisify(execFile)('git', ['clone', f.origin + '/' + repo + '.git', clone], { cwd: f.work })
  writeFileSync(join(clone, 'push-probe.ts'), 'export const pushProbe = "visible-after-push"\n')
  f.git(clone, 'add', 'push-probe.ts')
  f.git(clone, '-c', 'commit.gpgsign=false', 'commit', '-m', 'Push reader fixture')
  let returnedAt, pushError
  const pushStarted = performance.now()
  const pushing = promisify(execFile)('git', ['-c', 'http.extraHeader=Authorization: Bearer ' + f.tokens.avatest, 'push', 'origin', 'main'], { cwd: clone })
    .then(() => { returnedAt = performance.now() }, error => { pushError = error; returnedAt = performance.now() })
  const pushReads = []
  let visibleAt
  while (performance.now() - pushStarted < 60000) {
    const response = await request('/' + repo + '?path=push-probe.ts', null)
    pushReads.push(response.status)
    assert.equal(response.status, 200, 'public read remains available during a real Git push')
    const html = await response.text()
    if (returnedAt && html.includes('visible-after-push')) { visibleAt = performance.now(); break }
    if (pushError) throw new Error('fixture Git push failed: ' + pushError.stderr)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await pushing
  if (pushError) throw new Error('fixture Git push failed: ' + pushError.stderr)
  assert.ok(visibleAt, 'new pushed source becomes visible')
  mkdirSync('.tmp/fast-reads-2', { recursive: true })
  writeFileSync('.tmp/fast-reads-2/push-timing.json', JSON.stringify({
    gitPushMs: returnedAt - pushStarted,
    pushReturnToVisibleMs: visibleAt - returnedAt,
    publicReads: pushReads.length,
    publicErrors: pushReads.filter(status => status !== 200).length,
  }, null, 2))
  if(process.argv.includes('--push-only'))throw Object.assign(new Error('Push probe complete'),{pushOnly:true})
  const publicPointer = JSON.parse(
    publicHTML.match(/<script[^>]*id="gild-pointer"[^>]*>(.*?)<\/script>/s)[1],
  )
  // Warm an actual public artifact by its contextual hash, then revoke it.
  const publicManifest =
    '/f/' +
    publicPointer.version +
    '/manifest/' +
    publicPointer.manifest.hash +
    '?repo=' +
    repo +
    '&sha=' +
    publicPointer.tip
  assert.equal((await request(publicManifest, null)).status, 200)
  await json(
    await request(prefix + '/visibility', 'avatest', 'PATCH', {
      visibility: 'private',
    }),
  )
  assert.equal(
    (await request(publicManifest, 'outsider')).status,
    404,
    'old public hash must be revoked, including a warm cache',
  )
  // Cost guards run in the compiled production Git proxy, for a private repo.
  // These packs would reach receive-pack if its guard were disconnected.
  const variable = n => {
    const bytes = []
    do { const b = n & 127; n = Math.floor(n / 128); bytes.push(b | (n ? 128 : 0)) } while (n)
    return Buffer.from(bytes)
  }
  const command = `${f.sha} ${'7'.repeat(40)} refs/heads/cost-guard\0report-status\n`
  const pushPrefix = Buffer.from((Buffer.byteLength(command) + 4).toString(16).padStart(4, '0') + command + '0000')
  const pack = (type, content, base = Buffer.alloc(0)) => {
    let size = content.length, first = (type << 4) | (size & 15); size = Math.floor(size / 16)
    const header = [first | (size ? 128 : 0)]
    while (size) { const b = size & 127; size = Math.floor(size / 128); header.push(b | (size ? 128 : 0)) }
    const bytes = Buffer.concat([Buffer.from('5041434b0000000200000001', 'hex'), Buffer.from(header), base, deflateSync(content)])
    return Buffer.concat([pushPrefix, bytes, createHash('sha1').update(bytes).digest()])
  }
  const push = body => fetch(`${f.origin}/${repo}.git/git-receive-pack`, { method: 'POST',
    headers: { authorization: 'Bearer ' + f.tokens.avatest, 'content-type': 'application/x-git-receive-pack-request' }, body })
  const fileCap = await push(pack(3, Buffer.alloc(100 * 1024 * 1024 + 1)))
  assert.equal(fileCap.status, 413, 'compiled Git proxy rejects oversized files before forwarding')
  assert.match(await fileCap.text(), /100 MiB/)
  const deltaCap = await push(pack(7, Buffer.concat([variable(1), variable(100 * 1024 * 1024 + 1), Buffer.from([1, 65])]), Buffer.alloc(20)))
  assert.equal(deltaCap.status, 413)
  assert.match(await deltaCap.text(), /Delta result/)
  let limited
  for (let i = 0; i < 299; i++) { limited = await push(Buffer.from('0000')); if (limited.status === 429) break; await limited.text() }
  assert.equal(limited.status, 429, 'compiled proxy enforces account push rate')
  assert.ok(Number(limited.headers.get('retry-after')) > 0)
  for (const [viewer, permission] of [
    ['reader', 'read'],
    ['writer', 'write'],
  ]) {
    await json(
      await request(prefix + '/collaborators/' + viewer, 'avatest', 'PUT', {
        permission,
      }),
    )
    const invitations = await json(
      await request('/api/v1/user/repository_invitations', viewer),
    )
    await json(
      await request(
        '/api/v1/user/repository_invitations/' + invitations[0].id,
        viewer,
        'PATCH',
        {},
      ),
    )
  }
  await json(
    await request(prefix + '/agents', 'avatest', 'POST', {
      agent: 'avatest/granted',
      grants: ['pr'],
    }),
  )
  await waitPage('/' + repo, 'avatest')
  const matrix = []
  for (const viewer of [
    null,
    'outsider',
    'reader',
    'writer',
    'member',
    'avatest',
    'avatest/granted',
    'avatest/ungranted',
  ]) {
    const allowed =
        !!viewer && !['outsider', 'avatest/ungranted'].includes(viewer),
      row = { viewer: viewer ?? 'anonymous', paths: {} }
    for (const path of [
      '',
      '/issues',
      '/pulls',
      '/score',
      '/health',
      '/agents',
      '/actions',
      '/search',
    ]) {
      const response = await request('/' + repo + path, viewer)
      assert.equal(
        response.status,
        allowed ? 200 : 404,
        row.viewer + path + ': ' + (await response.clone().text()),
      )
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
      row.paths[path || 'code'] = response.status
    }
    const api = await request(prefix + '/contents/README.md', viewer)
    assert.equal(api.status, allowed ? 200 : 404)
    row.paths.API = api.status
    matrix.push(row)
  }
  const registration = await json(
    await request(
      prefix + '/actions/runners/registration-token',
      'avatest',
      'POST',
      {},
    ),
    201,
  )
  const registrationReply = await fetch(
    f.origin + prefix + '/actions/runners',
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + registration.token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'private-direct',
        os: 'linux',
        arch: 'x64',
        labels: [],
      }),
    },
  )
  assert.equal(
    registrationReply.status,
    201,
    'an owner-issued private registration may register exactly one runner',
  )
  const registered = await registrationReply.json()
  assert.equal(
    (
      await fetch(f.origin + prefix + '/contents/README.md', {
        headers: { authorization: 'Bearer ' + registered.token },
      })
    ).status,
    404,
    'runner handles cannot read arbitrary API repository paths',
  )
  assert.equal(
    (
      await fetch(f.origin + prefix + '/contents/README.md', {
        headers: { authorization: 'Bearer ' + registration.token },
      })
    ).status,
    404,
    'registration is write-only',
  )
  const agentRequest = await json(
    await request('/api/agents/requests', null, 'POST', {
      sponsor: 'avatest',
      label: 'private-audit',
      publicKey: 'ed25519:ZmFrZQ==',
      repo,
      grants: ['pr'],
      note: marker,
    }),
    201,
  )
  for (const viewer of [
    null,
    'outsider',
    'reader',
    'writer',
    'member',
    'avatest',
    'avatest/granted',
    'avatest/ungranted',
  ]) {
    const allowed =
      !!viewer && !['outsider', 'avatest/ungranted'].includes(viewer)
    const response = await request(
      '/api/agents/requests/' + agentRequest.id,
      viewer,
    )
    assert.equal(
      response.status,
      allowed ? 200 : 404,
      'owner-level agent request must share repo permissions: ' + viewer,
    )
  }
  const outsiderJoin = await json(
    await request('/api/agents/requests', null, 'POST', {
      sponsor: 'outsider',
      label: 'private-context',
      publicKey: 'ed25519:ZmFrZQ==',
      repo,
      grants: ['pr'],
      note: marker,
    }),
    201,
  )
  const pending = await json(
    await request('/api/v1/agents/requests', 'outsider'),
  )
  assert.ok(
    !JSON.stringify(pending).includes(marker),
    'API v1 request list cannot inherit sponsor access',
  )
  assert.equal(
    (await request('/api/v1/agents/requests/' + outsiderJoin.id, 'outsider'))
      .status,
    404,
  )
  assert.equal(
    (
      await request(
        '/api/agents/requests/' + outsiderJoin.id,
        'outsider',
        'POST',
        { decision: 'deny' },
      )
    ).status,
    404,
  )
  // A signed join receipt must not disclose its repository after key revocation.
  const keys = generateKeyPairSync('ed25519'),
    publicKey =
      'ed25519:' +
      keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    revokedJoin = await json(
      await request('/api/agents/requests', null, 'POST', {
        sponsor: 'avatest',
        label: 'revoked-join',
        publicKey,
        repo,
        grants: ['pr'],
        note: marker,
      }),
      201,
    )
  await json(
    await request('/api/agents/requests/' + revokedJoin.id, 'avatest', 'POST', {
      decision: 'approve',
      grants: ['pr'],
    }),
  )
  await json(await request('/api/v1/agents/revoked-join', 'avatest', 'DELETE'))
  const collected = await request(
    '/api/agents/requests/' + revokedJoin.id + '/token',
    null,
    'POST',
    {
      signature: sign(
        null,
        Buffer.from('gild-agent-join:' + revokedJoin.id),
        keys.privateKey,
      ).toString('base64'),
    },
  )
  assert.equal(
    collected.status,
    404,
    'revoked join keys cannot collect private metadata',
  )
  assert.ok(!(await collected.text()).includes(repo))
  const paths = new Set([
      '/api/agents/requests/' + agentRequest.id,
      '/api/v1/agents/requests/' + outsiderJoin.id,
      '/agents/approve/' + agentRequest.id,
    ]),
    files = []
  function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name))
      else if (/^(page\.tsx|route\.ts)$/.test(e.name))
        files.push(join(dir, e.name))
    }
  }
  walk('app')
  for (const file of files) {
    let parts = file
      .split('/')
      .slice(1, -1)
      .filter((x) => !x.startsWith('('))
    const vars = {
      owner: 'settingstest',
      repo: 'demo',
      org: 'settingstest',
      name: 'settingstest',
      user: 'settingstest',
      section: 'access',
      sha: publicPointer.tip,
      path: 'README.md',
      number: '1',
      run: '1',
      id: '1',
      agent: 'avatest/granted',
      workflow: 'ci.yml',
    }
    parts = parts.map((x) =>
      x.startsWith('[')
        ? (vars[
            x.replaceAll('[', '').replaceAll(']', '').replaceAll('.', '')
          ] ?? '1')
        : x,
    )
    paths.add('/' + parts.join('/'))
  }
  for (const path of paths)
    for (const rsc of [false, true]) {
      const response = await request(
          path,
          'outsider',
          'GET',
          undefined,
          rsc ? { rsc: '1' } : {},
        ),
        body = await response.text()
      assert.ok(
        !body.includes(marker) &&
          !body.includes(Buffer.from(marker).toString('base64')),
        path + ' leaked private body',
      )
      assert.ok(
        !JSON.stringify([...response.headers]).includes(marker),
        path + ' leaked private header',
      )
    }
  // Exercise the settings extension points in the actual rendered UI.
  browser = await launchChrome()
  const ctx = await browser.newContext()
  await ctx.addCookies([
    { name: 'gild_session', value: f.cookie('avatest'), url: f.origin },
  ])
  const page = await ctx.newPage()
  await page.goto(f.origin + '/' + repo + '/settings/access')
  await page
    .getByRole('heading', { name: 'Visibility & collaborators' })
    .waitFor()
  await page.getByRole('button', { name: 'Make public' }).click()
  await page.getByRole('button', { name: 'Confirm publication' }).waitFor()
  await page.screenshot({
    path: join(f.work, 'private-settings.png'),
    fullPage: true,
  })
  await ctx.close()
  await page?.close().catch(() => {})
  // The create checkbox uses the same production private initializer as API/CLI.
  const ownerContext = await browser.newContext()
  await ownerContext.addCookies([
    { name: 'gild_session', value: f.cookie('avatest'), url: f.origin },
  ])
  const createPage = await ownerContext.newPage()
  await createPage.goto(f.origin + '/new')
  await createPage.getByLabel('Private repository · free').check()
  await createPage.getByPlaceholder('repo name').fill('private-created')
  const creationReply = createPage.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/repos' &&
      r.request().method() === 'POST',
  )
  await createPage.getByRole('button', { name: 'create repository' }).click()
  const creationResponse = await creationReply
  assert.equal(creationResponse.status(), 201, await creationResponse.text())
  await createPage.waitForURL('**/avatest/private-created')
  assert.equal(
    (await request('/api/v1/repos/avatest/private-created', 'outsider')).status,
    404,
  )
  assert.equal(
    (await request('/avatest/private-created', 'outsider')).status,
    404,
  )
  assert.equal(
    (await json(await request('/api/v1/repos/avatest/private-created')))
      .private,
    true,
  )
  await ownerContext.close()
  // The invitee's account settings support both decline and accept without
  // displaying the private repository identity before acceptance.
  await json(
    await request(prefix + '/collaborators/outsider', 'avatest', 'PUT', {
      permission: 'read',
    }),
  )
  const inviteContext = await browser.newContext()
  await inviteContext.addCookies([
    { name: 'gild_session', value: f.cookie('outsider'), url: f.origin },
  ])
  const invitePage = await inviteContext.newPage()
  await invitePage.goto(f.origin + '/settings/invitations')
  await invitePage.getByRole('button', { name: 'Decline', exact: true }).click()
  await invitePage.getByText('No pending invitations.').waitFor()
  assert.equal((await request('/' + repo, 'outsider')).status, 404)
  await json(
    await request(prefix + '/collaborators/outsider', 'avatest', 'PUT', {
      permission: 'read',
    }),
  )
  await invitePage.reload()
  await invitePage.getByRole('button', { name: 'Accept', exact: true }).click()
  await invitePage.getByText('No pending invitations.').waitFor()
  assert.equal((await waitPage('/' + repo, 'outsider')).status, 200)
  await inviteContext.close()
  await json(
    await request(prefix + '/collaborators/outsider', 'avatest', 'DELETE', {}),
  )
  await json(
    await request(prefix + '/collaborators/reader', 'avatest', 'DELETE', {}),
  )
  assert.equal((await request('/' + repo, 'reader')).status, 404)
  const evidence = {
    runtime: 'compiled OpenNext Worker + real workerd/D1/DO/Git',
    matrix,
    routes: paths.size,
    representations: paths.size * 2,
    oldPublicHashRevoked: true,
    privateRunnerRegistration: true,
    runnerHandlesScoped: true,
    revokedJoinReceipt: true,
    requestListsFiltered: true,
    settingsUI: true,
    privateCreationUI: true,
    acceptDeclineUI: true,
    revocation: true,
  }
  writeFileSync(
    join(f.work, 'privacy-web-evidence.json'),
    JSON.stringify(evidence, null, 2),
  )
  console.log(
    'PASS full Worker private matrix, warm public hash revocation, settings UI, and outsider crawl',
    JSON.stringify(evidence),
  )
} catch(error) {if(!error?.pushOnly)throw error;console.log('PASS real push: no public errors; timing recorded')} finally {
  await browser?.close()
  f.worker.kill('SIGTERM')
  await new Promise((r) =>
    f.worker.exitCode !== null ? r() : f.worker.once('exit', r),
  )
  await new Promise((r) => f.server.close(r))
}
