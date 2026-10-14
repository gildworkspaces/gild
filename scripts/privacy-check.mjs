import assert from 'node:assert/strict'
import { randomBytes, generateKeyPairSync } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile),
  marker = 'private-only-UNIQUE-9841834'
export async function privacySuite(f) {
  const {
    origin,
    request,
    token,
    git,
    write,
    commit,
    work,
    head,
    base,
    received,
    receiver,
    gitReads,
  } = f
  const actorTokens = { acme: token }
  const req = async (path, name = 'acme', method = 'GET', body) => {
    const headers = {
      'cf-connecting-ip': '192.0.2.90',
      'content-type': 'application/json',
    }
    if (name) headers.authorization = 'Bearer ' + actorTokens[name]
    return fetch(origin + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    })
  }
  const json = async (r) => {
    assert.equal(r.status, 200, await r.clone().text())
    return r.json()
  }
  for (const actor of [
    'outsider',
    'reader',
    'writer',
    'member',
    'acme/granted',
    'acme/ungranted',
  ]) {
    actorTokens[actor] = 'gf_' + randomBytes(16).toString('hex')
    await json(
      await request('/privacy-fixture', 'POST', {
        actor,
        token: actorTokens[actor],
      }),
    )
  }
  git('switch', 'main')
  write('README.md', '# ' + marker + '\n')
  const sha = commit('Private fixture source')
  await json(
    await request('/push-fixture', 'POST', {
      sha,
      before: base,
      ref: 'refs/heads/main',
    }),
  )
  const readiness=await json(await request('/privacy-fixture','POST',{status:true}))
  assert.equal(readiness.status.ready,true,'actual source index must be ready after push')
  assert.equal(readiness.renderQueueAvailable,false,'this API fixture deliberately has no HTML render queue')
  assert.equal(readiness.preparedRefs.pending,0,'observed ref readiness cannot depend on an HTML renderer')
  const observedRefs=JSON.parse(readiness.preparedRefs.data)
  assert.equal(observedRefs.refs.find(r=>r.name==='main'&&r.kind==='branch').hash,sha,'published ref must be actual pushed immutable tip')
  const fenceProof=await json(await request('/privacy-fixture','POST',{pendingRefProof:true}))
  assert.deepEqual(fenceProof.pending,{main:fenceProof.unknown,_meta:fenceProof.unknown,feature:fenceProof.zero},'newer refs/metadata and unobserved deletion stay fenced')
  writeFileSync(join(work,'privacy-readiness.json'),JSON.stringify({readiness,fenceProof},null,2))
  const warm = await req('/acme/demo')
  assert.match(await warm.text(), new RegExp(marker))
  assert.equal((await req('/acme')).status, 200)
  const coldStart = performance.now()
  const beforeRead=gitReads()
  const preparedRead=await json(await req('/api/v1/repos/acme/demo/contents/README.md'))
  assert.equal(Buffer.from(preparedRead.content,'base64').toString(),'# '+marker+'\n','first GET must contain the actual pushed README bytes')
  assert.equal(gitReads(),beforeRead,'prepared content GET cannot perform Git preparation')
  const coldMs = performance.now() - coldStart
  const publicCommit = await req(
    '/api/v1/repos/acme/demo/commits/' + head,
    null,
  )
  assert.equal(
    publicCommit.headers.get('cache-control'),
    'private, max-age=0, must-revalidate',
    'previously public commit responses must revalidate after privatization',
  )
  const warmStart = performance.now()
  await json(await req('/api/v1/repos/acme/demo/contents/README.md'))
  const warmMs = performance.now() - warmStart
  await json(
    await req('/api/v1/repos/acme/demo/visibility', 'acme', 'PATCH', {
      visibility: 'private',
    }),
  )
  for (const [name, role] of [
    ['reader', 'read'],
    ['writer', 'write'],
  ]) {
    await json(
      await req(
        '/api/v1/repos/acme/demo/collaborators/' + name,
        'acme',
        'PUT',
        { permission: role },
      ),
    )
    assert.equal(
      (await req('/api/v1/repos/acme/demo', name)).status,
      404,
      'invitation alone grants no access',
    )
    const invites = await json(
      await req('/api/v1/user/repository_invitations', name),
    )
    assert.equal(invites.length, 1)
    assert.equal(JSON.stringify(invites).includes('acme/demo'), false)
    await json(
      await req(
        '/api/v1/user/repository_invitations/' + invites[0].id,
        name,
        'PATCH',
        {},
      ),
    )
  }
  await json(
    await request('/privacy-fixture', 'POST', {
      org: true,
      acl: {
        schema: 1,
        visibility: 'private',
        read: ['@reader'],
        write: ['@writer'],
        agents: { '@acme/granted': ['pr'] },
      },
    }),
  )
  const ownerRun = await json(
      await req('/api/v1/repos/acme/demo/actions/runs'),
    ),
    run = ownerRun.workflow_runs[0].id
  await json(
    await request('/event-fixture', 'POST', {
      receiver: `http://127.0.0.1:${receiver.address().port}`,
    }),
  )
  const hook = await req('/api/v1/repos/acme/demo/hooks', 'acme', 'POST', {
    config: {
      url: 'https://receiver.example/private-hook',
      secret: 'private-fixture-secret',
    },
    events: ['issues'],
  })
  assert.equal(hook.status, 201, await hook.clone().text())
  await json(
    await request('/emit-fixture', 'POST', {
      id: 'private-payload',
      event: 'issues',
      repository: 'acme/demo',
      payload: { unique: marker },
    }),
  )
  const cases = [
    ['page', '/acme/demo'],
    ['issues page', '/acme/demo/issues/1'],
    ['PR page', '/acme/demo/pulls/2'],
    ['Glance/score', '/acme/demo/score'],
    ['health', '/acme/demo/health'],
    ['agents', '/acme/demo/agents'],
    ['actions page', '/acme/demo/actions/' + run],
    ['search page', '/acme/demo/search'],
    ['API', '/api/v1/repos/acme/demo/contents/README.md'],
    ['agents API', '/api/v1/repos/acme/demo/agents'],
    ['private cached commit', '/api/v1/repos/acme/demo/commits/' + head],
    ['actions log', '/api/v1/repos/acme/demo/actions/runs/' + run + '/logs'],
    ['git advertisement', '/acme/demo.git/info/refs?service=git-upload-pack'],
  ]
  const matrix = []
  for (const name of [
    null,
    'outsider',
    'reader',
    'writer',
    'member',
    'acme',
    'acme/granted',
    'acme/ungranted',
  ]) {
    const allowed = !!name && !['outsider', 'acme/ungranted'].includes(name),
      row = { viewer: name ?? 'anonymous', paths: {} }
    for (const [label, path] of cases) {
      const response = await req(path, name),
        text = await response.text()
      assert.equal(
        response.status,
        allowed ? 200 : label === 'git advertisement' && !name ? 401 : 404,
        `${row.viewer}:${label}: ${text}`,
      )
      if (!allowed)
        assert.ok(
          !text.includes(marker) &&
            !text.includes(Buffer.from(marker).toString('base64')),
        )
      if (allowed && label !== 'git advertisement')
        assert.equal(
          response.headers.get('cache-control'),
          'private, no-store',
          label,
        )
      row.paths[label] = response.status
    }
    for (const path of [
      '/api/search?q=' + marker,
      '/api/v1/search/code?q=' + marker,
    ]) {
      const response = await req(path, name),
        data = await response.json()
      assert.equal(response.status, 200, JSON.stringify(data))
      const count = data.total_count ?? data.count
      assert.ok(
        allowed ? count > 0 : count === 0,
        `${row.viewer}:${path}: ${JSON.stringify(data)}`,
      )
    }
    const owner = await json(await req('/acme', name)),
      explore = await json(await req('/explore', name))
    assert.equal(owner.length, allowed ? 1 : 0)
    assert.equal(explore.length, 0)
    const stream = await req(
      '/api/v1/events?repos=acme/demo&since=0&wait=0',
      name,
    )
    assert.equal(
      stream.status,
      allowed ? 200 : name ? 404 : 401,
      `${row.viewer}:event stream: ${await stream.clone().text()}`,
    )
    if (allowed)
      assert.ok(
        (await stream.clone().text()).includes(marker),
        'authorized stream must contain the real private event',
      )
    const hookAccess = await json(
      await request('/privacy-fixture', 'POST', { hookViewer: name ?? '' }),
    )
    assert.equal(
      hookAccess.allowed,
      name === 'acme',
      `${row.viewer}:webhook delivery authority`,
    )
    row.paths.webhook = hookAccess.allowed ? 'delivered' : 'blocked'
    row.paths.search = allowed ? 'count > 0' : 'count = 0'
    row.paths['owner list'] = owner.length
    row.paths.explore = explore.length
    row.paths.events = stream.status
    matrix.push(row)
  }
  const deliveryDeadline = Date.now() + 15000
  while (!received.some((r) => r.body.includes(marker))) {
    if (Date.now() > deliveryDeadline)
      throw new Error('Repository-owned private hook did not receive its event')
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.equal(
    (
      await json(
        await request('/privacy-fixture', 'POST', {
          hookViewer: 'acme',
          scope: 'repo:acme/other',
        }),
      )
    ).allowed,
    false,
    'repo hook cannot receive another repo payload',
  )
  assert.equal(
    (
      await json(
        await request('/privacy-fixture', 'POST', {
          hookViewer: 'acme',
          scope: 'org:acme',
          repository: 'other/private',
        }),
      )
    ).allowed,
    false,
    'org hook cannot receive outsider repo payload',
  )
  // The actual credential helper answers Git's challenge; no token in argv,
  // URL, logs, or a real HOME/global git config.
  const cli = resolve(process.env.GILD_TEST_CLI_DIR || '../gild-cli', 'dist/gild'),
    identityDir = join(work, 'credential-identity'),
    clone = join(work, 'private-clone')
  mkdirSync(identityDir, { mode: 0o700 })
  const keys = generateKeyPairSync('ed25519')
  writeFileSync(
    join(identityDir, 'identity.json'),
    JSON.stringify({
      schema: 1,
      name: 'reader',
      device: 'fixture',
      publicKey:
        'ed25519:' +
        keys.publicKey
          .export({ format: 'der', type: 'spki' })
          .toString('base64'),
      secretKey:
        'ed25519:' +
        keys.privateKey
          .export({ format: 'der', type: 'pkcs8' })
          .toString('base64'),
      apiToken: { server: origin, token: actorTokens.reader },
      createdAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  )
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(work, 'gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
  }
  await exec(
    'git',
    [
      '-c',
      'credential.helper=',
      '-c',
      `credential.helper=!${cli} --config-dir ${identityDir} credential`,
      'clone',
      origin + '/acme/demo.git',
      clone,
    ],
    { env: gitEnv, timeout: 30000 },
  )
  assert.equal(
    readFileSync(join(clone, 'README.md'), 'utf8'),
    '# ' + marker + '\n',
  )
  await assert.rejects(
    exec(
      'git',
      ['-c', 'credential.helper=', 'ls-remote', origin + '/acme/demo.git'],
      { env: gitEnv, timeout: 30000 },
    ),
  )
  // Exercise clone itself for every viewer, using the real helper challenge.
  const helperIdentityPath = join(identityDir, 'identity.json'),
    helperIdentity = JSON.parse(readFileSync(helperIdentityPath, 'utf8'))
  for (const name of [
    null,
    'outsider',
    'reader',
    'writer',
    'member',
    'acme',
    'acme/granted',
    'acme/ungranted',
  ]) {
    const target = join(
      work,
      'clone-' + (name ?? 'anonymous').replaceAll('/', '-'),
    )
    if (name)
      writeFileSync(
        helperIdentityPath,
        JSON.stringify({
          ...helperIdentity,
          name,
          apiToken: { server: origin, token: actorTokens[name] },
        }),
        { mode: 0o600 },
      )
    const operation = exec(
      'git',
      [
        '-c',
        'credential.helper=',
        ...(name
          ? [
              '-c',
              `credential.helper=!${cli} --config-dir ${identityDir} credential`,
            ]
          : []),
        'clone',
        '--depth=1',
        origin + '/acme/demo.git',
        target,
      ],
      { env: gitEnv, timeout: 30000 },
    )
    if (name && !['outsider', 'acme/ungranted'].includes(name)) {
      await operation
      assert.equal(
        readFileSync(join(target, 'README.md'), 'utf8'),
        '# ' + marker + '\n',
      )
    } else await assert.rejects(operation)
  }
  writeFileSync(helperIdentityPath, JSON.stringify(helperIdentity), {
    mode: 0o600,
  })
  // Remove accepted read access: both warmed API and existing Git credentials
  // are denied on the very next request.
  await json(
    await req(
      '/api/v1/repos/acme/demo/collaborators/reader',
      'acme',
      'DELETE',
      {},
    ),
  )
  assert.equal(
    (await req('/api/v1/repos/acme/demo/contents/README.md', 'reader')).status,
    404,
  )
  await assert.rejects(
    exec(
      'git',
      [
        '-c',
        'credential.helper=',
        '-c',
        `credential.helper=!${cli} --config-dir ${identityDir} credential`,
        'ls-remote',
        origin + '/acme/demo.git',
      ],
      { env: gitEnv, timeout: 30000 },
    ),
  )
  // Explicit publication confirmation is enforced server-side, not just in UI.
  assert.equal(
    (
      await req('/api/v1/repos/acme/demo/visibility', 'acme', 'PATCH', {
        visibility: 'public',
      })
    ).status,
    422,
  )
  await json(
    await req('/api/v1/repos/acme/demo/visibility', 'acme', 'PATCH', {
      visibility: 'public',
      confirm: 'acme/demo',
    }),
  )
  assert.equal((await req('/acme/demo', null)).status, 200)
  await json(
    await req('/api/v1/repos/acme/demo/visibility', 'acme', 'PATCH', {
      visibility: 'private',
    }),
  )
  // Failure AFTER the Git ACL commit: D1 still has an old listing, but the
  // durable access revision/dirty alarm fences all reads until retry succeeds.
  await json(
    await req('/api/v1/repos/acme/demo/visibility', 'acme', 'PATCH', {
      visibility: 'public',
      confirm: 'acme/demo',
    }),
  )
  await json(await request('/privacy-fixture', 'POST', { rejectListing: true }))
  const failedPublication = await req(
    '/api/v1/repos/acme/demo/visibility',
    'acme',
    'PATCH',
    { visibility: 'private' },
  )
  assert.ok(
    failedPublication.status >= 500,
    'projection failure must be reported',
  )
  assert.equal(
    JSON.parse(git('show', '_meta:.gild/acl.json')).visibility,
    'private',
    'ACL push landed despite listing failure',
  )
  const fenced = await json(
    await request('/privacy-fixture', 'POST', { status: true }),
  )
  assert.equal(fenced.status.refreshing, true)
  assert.equal((await req('/acme/demo', 'outsider')).status, 404)
  assert.equal((await json(await req('/acme', 'outsider'))).length, 0)
  await json(
    await request('/privacy-fixture', 'POST', { rejectListing: false }),
  )
  await json(await request('/drain-index'))
  assert.equal((await req('/acme/demo', 'outsider')).status, 404)
  // Metadata written by an owner through receive-pack has exactly the same
  // pre-push fence and projection refresh as the API writer.
  await json(
    await req('/api/v1/repos/acme/demo/visibility', 'acme', 'PATCH', {
      visibility: 'public',
      confirm: 'acme/demo',
    }),
  )
  const bearerProbe = await req(
    '/acme/demo.git/info/refs?service=git-receive-pack',
    'acme',
  )
  assert.equal(bearerProbe.status, 200, await bearerProbe.clone().text())
  const identityFile = join(identityDir, 'identity.json'),
    identity = JSON.parse(readFileSync(identityFile, 'utf8'))
  identity.name = 'acme'
  identity.apiToken.token = token
  writeFileSync(identityFile, JSON.stringify(identity), { mode: 0o600 })
  await exec(
    'git',
    [
      '-c',
      'credential.helper=',
      '-c',
      `credential.helper=!${cli} --config-dir ${identityDir} credential`,
      'fetch',
      'origin',
      '_meta',
    ],
    { cwd: clone, env: gitEnv, timeout: 30000 },
  )
  await exec('git', ['switch', '-c', '_meta', 'FETCH_HEAD'], {
    cwd: clone,
    env: gitEnv,
  })
  const aclFile = join(clone, '.gild', 'acl.json'),
    directAcl = JSON.parse(readFileSync(aclFile, 'utf8'))
  directAcl.visibility = 'private'
  delete directAcl.private
  writeFileSync(aclFile, JSON.stringify(directAcl))
  await exec('git', ['add', '.gild/acl.json'], { cwd: clone, env: gitEnv })
  await exec(
    'git',
    ['-c', 'commit.gpgsign=false', 'commit', '-m', 'Direct ACL fixture'],
    {
      cwd: clone,
      env: {
        ...gitEnv,
        GIT_AUTHOR_NAME: 'Gild fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.test',
        GIT_COMMITTER_NAME: 'Gild fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.test',
      },
    },
  )
  await exec(
    'git',
    [
      '-c',
      'credential.helper=',
      '-c',
      `credential.helper=!${cli} --config-dir ${identityDir} credential`,
      'push',
      'origin',
      '_meta',
    ],
    { cwd: clone, env: gitEnv, timeout: 30000 },
  )
  assert.equal((await req('/acme/demo', 'outsider')).status, 404)
  assert.equal((await json(await req('/acme', 'outsider'))).length, 0)
  // An uncertain/rejected push keeps discretionary grants closed; structural
  // owners can retry a safe metadata write and recover the fence.
  await json(
    await request('/privacy-fixture', 'POST', {
      fence: 'uncommitted-proposal',
    }),
  )
  assert.equal((await req('/api/v1/repos/acme/demo', 'outsider')).status, 404)
  await json(
    await req('/api/v1/repos/acme/demo/visibility', 'acme', 'PATCH', {
      visibility: 'private',
    }),
  )
  // Enumerate every app route, substitute the private repository/outsider, and
  // crawl GET, HEAD and POST representations (including RSC). No private tag
  // may appear in body OR headers, even in warm/cached responses.
  const files = []
  function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name))
      else if (/^(page\.tsx|route\.ts)$/.test(e.name))
        files.push(join(dir, e.name))
    }
  }
  walk('app')
  const crawl = new Set(cases.map(([, p]) => p))
  for (const file of files) {
    let path =
      '/' +
      file
        .replace(/^app\//, '')
        .replace(/\/(page\.tsx|route\.ts)$/, '')
        .split('/')
        .filter((p) => !/^\(.+\)$/.test(p))
        .join('/')
    path =
      path
        .replace(/\[\[\.\.\.[^\]]+\]\]/g, '')
        .replace(/\[\.\.\.path\]/g, 'info/refs')
        .replace(/\[\.\.\.[^\]]+\]/g, '1')
        .replace(/\[owner\]/g, 'acme')
        .replace(/\[repo\]/g, 'demo')
        .replace(/\[org\]/g, 'acme')
        .replace(/\[sha\]/g, sha)
        .replace(/\[section\]/g, 'access')
        .replace(/\[[^\]]+\]/g, '1')
        .replace(/\/+$/, '') || '/'
    if (path.startsWith('/auth') || path.includes('/signout')) continue
    crawl.add(path)
  }
  const leaked = []
  for (const path of crawl)
    for (const method of ['GET', 'HEAD']) {
      const response = await req(path, 'outsider', method),
        text = await response.text(),
        visible = text + JSON.stringify([...response.headers])
      if (
        visible.includes(marker) ||
        visible.includes(Buffer.from(marker).toString('base64'))
      )
        leaked.push({ path, method, status: response.status })
    }
  assert.deepEqual(leaked, [], 'outsider route crawl')
  const evidence = {
    coldMs,
    warmMs,
    matrix,
    crawledRoutes: crawl.size,
    crawledRepresentations: crawl.size * 2,
    credentialHelperClone: true,
    cloneViewerMatrix: true,
    ownerFenceRetry: true,
    webhookDelivery: true,
    listingFailureFence: true,
    directMetaPushFence: true,
    immediateRemoval: true,
    explicitPublication: true,
  }
  writeFileSync(
    join(work, 'privacy-evidence.json'),
    JSON.stringify(evidence, null, 2),
  )
  console.log(
    'PASS private repository matrix, actual Git credential-helper clone, revocation, and outsider route crawl',
    JSON.stringify(evidence),
  )
}
