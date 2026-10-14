import { verifyRepoRefresh } from './repo-refresh-browser.mjs'
import { forgeFixture } from './forge-fixture.mjs'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
import { launchChrome } from './chrome.mjs'
const f = await forgeFixture({ runnerScaling: true, renderBuild: false }),
  { origin, tokens, worker, work, server, gitRoot, git, sha, cookie } = f
const base = '/api/v1/orgs/settingstest/actions',
  cli = resolve(process.env.GILD_TEST_CLI_DIR || '../gild-cli'),
  configDir = join(work, 'runner-config'),
  bin = join(work, 'bin')
// The corner crawl includes this repository; strict privacy no longer renders
// an application shell for a missing repository. Seed a real public fixture.
f.seedRepo('o-settingstest', 'ky')
mkdirSync(configDir, { mode: 0o700 })
mkdirSync(bin)
const binary = join(bin, 'gild')
execFileSync(
  'bun',
  ['build', '--compile', 'src/gild.ts', '--outfile', binary],
  { cwd: cli, stdio: 'pipe' },
)
const cliEnv = {
  ...process.env,
  PATH: bin + ':' + process.env.PATH,
  TMPDIR: work,
}
const redact = text => text.replace(/(grt|gro|gc|gr|gf)_[A-Za-z0-9]+/g, '$1_<redacted>')
const gild = async (...args) => {
  try { return await promisify(execFile)('gild', args, { cwd: cli, env: cliEnv }) }
  catch (e) { throw Error(redact(e.message)) }
}
async function call(
  path,
  body,
  method = body === undefined ? 'GET' : 'POST',
  token = tokens.avatest,
  status = 200,
  idempotency = method === 'POST' && path.endsWith('/pulls') ? crypto.randomUUID() : undefined,
) {
  const deadline = Date.now() + 45000
  while (true) {
    const r = await fetch(origin + path, {
      method,
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        ...(idempotency ? { 'idempotency-key': idempotency } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await r.text()
    // Real pushes/runner receipts index asynchronously. Retry only the
    // documented busy response, for reads or an idempotent PR write. The same
    // key is retained; final status/effect assertions remain mandatory.
    if (r.status === 503 && status >= 200 && status < 300 &&
        (method === 'GET' || idempotency) &&
        text.includes('Repository is indexing; retry shortly') && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200))
      continue
    }
    assert.equal(r.status, status, `${method} ${path}: ${redact(text)}`)
    return text ? JSON.parse(text) : null
  }
}

async function eventually(fn, message) {
  const started = Date.now()
  while (Date.now() - started < 45000) {
    const value = await fn()
    if (value) return value
    await new Promise((r) => setTimeout(r, 200))
  }
  throw Error(message)
}
const data = {
  name: 'bugsy',
  os: process.platform,
  arch: process.arch,
  labels: [],
  group: 'builds',
}
let browser
try {
  await eventually(async () => {
    try {
      return (await fetch(origin + '/api/v1/openapi.json',{signal:AbortSignal.timeout(1000)})).ok
    } catch {
      return false
    }
  }, 'Worker start')
  console.log('OpenNext build on local wrangler/workerd ready')
  // The privacy boundary hides an unknown legacy ACL until its cold index is
  // published. Establish these fixture public policies before testing token
  // errors; an unknown repository correctly returns 404, not token diagnostics.
  // The unrestricted event stream also enumerates the twenty public scaling
  // repositories. Establish their ACL projections once instead of discovering
  // another cold repository on each stream retry.
  for(const repository of ['settingstest/demo','settingstest/tools','settingstest/runner-images','settingstest/ky','avatest/glance-test',...Array.from({length:20},(_,i)=>'second/scale'+i)])
    await eventually(async()=> (await fetch(origin+'/api/v1/repos/'+repository,{headers:{authorization:'Bearer '+tokens.avatest}})).status===200,'Public fixture policy: '+repository)

  const group = await call(
    base + '/runner-groups',
    { name: 'builds' },
    'POST',
    tokens.avatest,
    201,
  )
  await call(
    base + '/runner-groups/' + group.id + '/repositories/demo',
    {},
    'PUT',
  )
  data.group = group.id
  for (const body of [{ visibility: 'bad' }, { repositories: 'settingstest/demo' },
    { repositories: [4] }, { repositories: ['other/demo'] }, { repositories: ['settingstest/missing'] }]) {
    await call(base + '/runner-groups/' + group.id, body, 'PATCH', tokens.avatest, 422)
    await call(base + '/runner-groups', { name: 'invalid', ...body }, 'POST', tokens.avatest, 422)
  }
  await call(base + '/runner-groups/' + group.id + '/repositories', { repositories: ['settingstest/missing'] }, 'PUT', tokens.avatest, 422)
  for (const body of [{ name: 'bad\nrunner' }, { name: '../runner' }, { labels: Array(33).fill('label') }])
    await call(base + '/runners', { ...data, ...body }, 'POST', tokens.avatest, 422)
  await call(base + '/runner-groups/' + group.id, { visibility: 'all' }, 'PATCH', tokens.member, 403)
  await call(base + '/runners', data, 'POST', tokens.member, 403)
  await call(
    base + '/runner-groups',
    { name: 'forbidden' },
    'POST',
    tokens.member,
    403,
  )
  const reg = await call(
    base + '/runners/registration-token',
    { group: group.id },
    'POST',
    tokens.avatest,
    201,
  )
  await call(
    base + '/runners',
    { ...data, group: 'default' },
    'POST',
    reg.token,
    401,
  )
  const expired = await call(
    base + '/runners/registration-token',
    { group: group.id },
    'POST',
    tokens.avatest,
    201,
  )
  await fetch(origin + '/__fixture/expire-registration', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ owner: 'settingstest', token: expired.token }),
  })
  await call(base + '/runners', data, 'POST', expired.token, 401)
  await gild(
    'runner',
    'add',
    '--org',
    'settingstest',
    '--group',
    group.id,
    '--name',
    'bugsy',
    '--token',
    reg.token,
    '--server',
    origin,
    '--config-dir',
    configDir,
  )
  assert.equal(
    existsSync(join(configDir, 'identity.json')),
    false,
    'registration must not require copying identity',
  )
  await call(base + '/runners', data, 'POST', reg.token, 401)
  const registered = JSON.parse(
    readFileSync(join(configDir, 'runners/bugsy.json'), 'utf8'),
  )
  const cross = await fetch(
    origin + '/api/v1/users/second/actions/runners/poll',
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + registered.token,
        'content-type': 'application/json',
      },
      body: '{"wait":0}',
    },
  )
  assert.equal(cross.status, 401)
  await call(
    '/api/v1/repos/avatest/glance-test/actions/runners/poll',
    { wait: 0 },
    'POST',
    registered.token,
    401,
  )
  assert.equal(
    (
      await fetch(
        origin + '/settingstest/demo.git/info/refs?service=git-upload-pack',
        { headers: { authorization: 'Bearer ' + registered.token } },
      )
    ).status,
    403,
  )
  // Real user git pushes through the production git proxy trigger both queues.
  for (const repo of ['demo', 'tools']) {
    const clone = join(work, repo)
    await promisify(execFile)(
      'git',
      ['clone', origin + '/settingstest/' + repo + '.git', clone],
      { env: cliEnv },
    )
    writeFileSync(
      join(clone, '.github/workflows/ci.yml'),
      `name: Owner fixture\non: [push, workflow_dispatch, pull_request]\njobs:\n  test:\n    runs-on: self-hosted\n    steps:\n      - run: echo owner-job-${repo}\n`,
    )
    git(clone, 'add', '.')
    git(
      clone,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'Trigger owner runner ' + repo,
    )
    await promisify(execFile)(
      'git',
      [
        '-c',
        'http.extraHeader=Authorization: Bearer ' + tokens.avatest,
        'push',
        'origin',
        'main',
      ],
      { cwd: clone, env: cliEnv },
    )
  }
  const repoBase = (repo) => '/api/v1/repos/settingstest/' + repo + '/actions'
  await eventually(async () => {
    const [a, b] = await Promise.all(
      ['demo', 'tools'].map((r) => call(repoBase(r) + '/runs')),
    )
    return a.total_count && b.total_count
  }, 'Push events must reach both RunQueues')
  assert.equal(
    (await call(base + '/runners/poll', { wait: 0 }, 'POST', registered.token))
      .job,
    null,
    'public repo blocked by default',
  )
  await call(
    base + '/runner-groups/' + group.id,
    { allow_public_repositories: true },
    'PATCH',
  )
  const githubRunner = (await call(base + '/runners')).runners.find(
    (r) => r.gild_id === registered.id,
  )
  await call(
    base + '/runners/' + githubRunner.id,
    { labels: ['fast'] },
    'PATCH',
  )
  const first = performance.now()
  await call(base + '/runners')
  const firstMs = performance.now() - first,
    repeat = performance.now()
  await call(base + '/runners')
  const repeatMs = performance.now() - repeat
  const ownerJob = (
    await call(base + '/runners/poll', { wait: 0 }, 'POST', registered.token)
  ).job
  assert.equal(ownerJob.repository, 'settingstest/demo')
  assert.equal(
    (
      await fetch(
        origin + '/settingstest/tools.git/info/refs?service=git-upload-pack',
        {
          headers: {
            authorization:
              'Basic ' +
              Buffer.from('gild:' + ownerJob.checkoutToken).toString('base64'),
          },
        },
      )
    ).status,
    401,
  )
  assert.equal(
    (
      await fetch(
        origin + '/settingstest/tools.git/info/refs?service=git-upload-pack',
        { headers: { authorization: 'Bearer ' + ownerJob.checkoutToken } },
      )
    ).status,
    401,
  )
  assert.equal(
    (
      await fetch(
        origin + '/settingstest/demo.git/info/refs?service=git-upload-pack',
        { headers: { authorization: 'Bearer ' + ownerJob.checkoutToken } },
      )
    ).status,
    200,
  )
  await call(
    base + '/runner-groups/' + group.id + '/repositories/demo',
    undefined,
    'DELETE',
  )
  await call(
    repoBase('demo') + '/runners/heartbeat',
    { job: ownerJob.job, lease: ownerJob.lease },
    'POST',
    ownerJob.checkoutToken,
  )
  await call(
    repoBase('demo') + '/runners/step',
    {
      job: ownerJob.job,
      lease: ownerJob.lease,
      step: 0,
      status: 'running',
      exit: null,
    },
    'POST',
    ownerJob.checkoutToken,
  )
  await call(
    repoBase('demo') + '/runners/step',
    {
      job: ownerJob.job,
      lease: ownerJob.lease,
      step: 0,
      status: 'success',
      exit: 0,
    },
    'POST',
    ownerJob.checkoutToken,
  )
  await call(
    repoBase('demo') + '/runners/finish',
    {
      job: ownerJob.job,
      lease: ownerJob.lease,
      status: 'success',
      reason: null,
    },
    'POST',
    ownerJob.checkoutToken,
  )
  assert.equal(
    (
      await fetch(
        origin + '/settingstest/demo.git/info/refs?service=git-upload-pack',
        { headers: { authorization: 'Bearer ' + ownerJob.checkoutToken } },
      )
    ).status,
    401,
  )
  await call(
    repoBase('demo') + '/runs/' + ownerJob.run + '/rerun',
    {},
    'POST',
    tokens.avatest,
    201,
  )
  assert.equal(
    (await call(base + '/runners/poll', { wait: 0 }, 'POST', registered.token))
      .job,
    null,
    'access removed: next job stays queued',
  )
  await call(
    base + '/runner-groups/' + group.id + '/repositories/demo',
    {},
    'PUT',
  )
  // Actual CLI checkout, logs and completion using only the leased credential.
  const output = await gild(
    'runner',
    'start',
    '--name',
    'bugsy',
    '--once',
    '--config-dir',
    configDir,
  )
  assert.match(output.stdout, /success/)
  const demoRuns = await call(repoBase('demo') + '/runs'),
    toolsRuns = await call(repoBase('tools') + '/runs')
  assert.equal(demoRuns.workflow_runs[0].conclusion, 'success')
  assert.equal(toolsRuns.workflow_runs[0].status, 'queued')
  const logs = await call(
    repoBase('demo') + '/runs/' + demoRuns.workflow_runs[0].id + '/logs',
  )
  assert.match(JSON.stringify(logs), /owner-job-demo/)
  assert.doesNotMatch(JSON.stringify(logs), /gc_[a-f0-9]{32}/)
  // Repo and owner machines race on the same job over HTTP.
  await call(
    repoBase('demo') + '/runs/' + ownerJob.run + '/rerun',
    {},
    'POST',
    tokens.avatest,
    201,
  )
  const local = await call(
    repoBase('demo') + '/runners',
    { ...data, name: 'repo-machine' },
    'POST',
    tokens.avatest,
    201,
  )
  const race = await Promise.all([
    call(base + '/runners/poll', { wait: 0 }, 'POST', registered.token),
    call(repoBase('demo') + '/runners/poll', { wait: 0 }, 'POST', local.token),
  ])
  assert.equal(race.filter((r) => r.job).length, 1)
  const winning = race.find((r) => r.job).job,
    winningToken = race[0].job ? winning.checkoutToken : local.token
  await call(
    repoBase('demo') + '/runners/finish',
    {
      job: winning.job,
      lease: winning.lease,
      status: 'failure',
      reason: 'race proof complete',
    },
    'POST',
    winningToken,
  )
  // Personal-account tokens use the same one-time trust model.
  const personal = '/api/v1/users/avatest/actions',
    personalReg = await call(
      personal + '/runners/registration-token',
      {},
      'POST',
      tokens.avatest,
      201,
    )
  await call(
    '/api/v1/users/second/actions/runners',
    { ...data, name: 'bad', group: 'default' },
    'POST',
    personalReg.token,
    401,
  )
  const personalRunner = await call(
    personal + '/runners',
    { ...data, name: 'personal', group: 'default' },
    'POST',
    personalReg.token,
    201,
  )
  assert.ok(personalRunner.token.startsWith('gro_'))

  // Public fork code waits for maintainer approval on both runner scopes.
  const clone = join(work, 'demo')
  git(clone, 'checkout', '-b', 'fork-code')
  writeFileSync(
    join(clone, '.github/workflows/ci.yml'),
    `name: Fork fixture\non:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  test:\n    runs-on: self-hosted\n    steps:\n      - run: echo fork-approved\n`,
  )
  git(clone, 'add', '.')
  git(
    clone,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'Untrusted public PR fixture',
  )
  await promisify(execFile)(
    'git',
    [
      '-c',
      'http.extraHeader=Authorization: Bearer ' + tokens.avatest,
      'push',
      'origin',
      'fork-code',
    ],
    { cwd: clone, env: cliEnv },
  )
  await call(repoBase('demo') + '/runs')
  const forkSha = git(clone, 'rev-parse', 'HEAD')
  // A successful push precedes asynchronous indexing. Read the immutable head
  // before testing PR creation; do not retry the mutating POST itself.
  await eventually(async () => {
    const response = await fetch(origin + '/api/v1/repos/settingstest/demo/branches?per_page=100', {
      headers: { authorization: 'Bearer ' + tokens.member },
    })
    if ([404, 503].includes(response.status)) return false
    assert.equal(response.status, 200, await response.clone().text())
    return (await response.json()).find(branch => branch.name === 'fork-code')?.commit.sha === forkSha
  }, 'Pushed fork fixture branch must be indexed before creating its pull')
  await eventually(async () => {
    const response = await fetch(origin + '/api/v1/repos/settingstest/demo/pulls', {
      headers: { authorization: 'Bearer ' + tokens.member },
    })
    if ([404, 503].includes(response.status)) return false
    assert.equal(response.status, 200, await response.clone().text())
    return true
  }, 'Completed run metadata must be indexed before creating a pull')
  const pull = await call(
    '/api/v1/repos/settingstest/demo/pulls',
    { title: 'Untrusted fork fixture', head: 'fork-code', base: 'main' },
    'POST',
    tokens.member,
    201,
  )
  const fork = await eventually(async () => {
    const runs = await call(repoBase('demo') + '/runs')
    return runs.workflow_runs.find((r) => r.event === 'pull_request')
  }, 'PR trigger should enqueue a run')
  assert.equal(
    (await call(base + '/runners/poll', { wait: 0 }, 'POST', registered.token))
      .job,
    null,
    'owner must wait for fork approval',
  )
  assert.equal(
    (
      await call(
        repoBase('demo') + '/runners/poll',
        { wait: 0 },
        'POST',
        local.token,
      )
    ).job,
    null,
    'repo runner must wait for fork approval',
  )
  await call(
    repoBase('demo') + '/runs/' + fork.id + '/approve',
    {},
    'POST',
    tokens.member,
    403,
  )
  await call(
    repoBase('demo') + '/runs/' + fork.id + '/approve',
    {},
    'POST',
    tokens.avatest,
  )
  const approved = await gild(
    'runner',
    'start',
    '--name',
    'bugsy',
    '--once',
    '--config-dir',
    configDir,
  )
  assert.match(approved.stdout, /success/)
  // Private metadata is read through production mayRead, then checked out by
  // the actual CLI using the leased token with public repos switched off.
  await call('/api/v1/repos/settingstest/runner-images/visibility',
    {visibility:'private'},'PATCH')
  await call(
    base + '/runner-groups/' + group.id,
    {
      repositories: ['settingstest/demo', 'settingstest/runner-images'],
      allow_public_repositories: false,
    },
    'PATCH',
  )
  const privateClone = join(work, 'private-repo')
  await promisify(execFile)(
    'git',
    [
      '-c',
      'http.extraHeader=Authorization: Bearer ' + tokens.avatest,
      'clone',
      origin + '/settingstest/runner-images.git',
      privateClone,
    ],
    { env: cliEnv },
  )
  writeFileSync(
    join(privateClone, '.github/workflows/ci.yml'),
    `name: Private fixture\non: push\njobs:\n  test:\n    runs-on: self-hosted\n    steps:\n      - run: echo private-checkout-worked\n`,
  )
  git(privateClone, 'add', '.')
  git(
    privateClone,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'Private owner job',
  )
  await promisify(execFile)(
    'git',
    [
      '-c',
      'http.extraHeader=Authorization: Bearer ' + tokens.avatest,
      'push',
      'origin',
      'main',
    ],
    { cwd: privateClone, env: cliEnv },
  )
  await eventually(async () => {
    const v = await call(repoBase('runner-images') + '/runs')
    return v.total_count
  }, 'Private push triggers its RunQueue')
  const privateOutput = await gild(
    'runner',
    'start',
    '--name',
    'bugsy',
    '--once',
    '--config-dir',
    configDir,
  )
  assert.match(privateOutput.stdout, /success/)
  const privateRuns = await call(repoBase('runner-images') + '/runs')
  assert.equal(privateRuns.workflow_runs[0].conclusion, 'success')
  // Exercise the native macOS manager with this disposable registration. Remove
  // repository access first so the service only polls, and always uninstall it.
  if (process.platform === 'darwin') {
    const serviceName = 'runnerproof-' + process.pid,
      registration = await call(base + '/runners/registration-token', {
        group: group.id,
      }, 'POST', tokens.avatest, 201)
    await gild(
      'runner',
      'add',
      '--org',
      'settingstest',
      '--group',
      group.id,
      '--name',
      serviceName,
      '--token',
      registration.token,
      '--server',
      origin,
      '--config-dir',
      configDir,
    )
    const serviceRunner = JSON.parse(
      readFileSync(join(configDir, 'runners', serviceName + '.json'), 'utf8'),
    )
    await call(
      base + '/runner-groups/' + group.id,
      { repositories: [] },
      'PATCH',
    )
    try {
      await gild(
        'runner',
        'service',
        'install',
        '--name',
        serviceName,
        '--config-dir',
        configDir,
      )
      const status = await gild(
        'runner',
        'service',
        'status',
        '--name',
        serviceName,
        '--config-dir',
        configDir,
      )
      assert.ok(status.stdout.includes('gild.runner.' + serviceName))
    } finally {
      await gild(
        'runner',
        'service',
        'uninstall',
        '--name',
        serviceName,
        '--config-dir',
        configDir,
      )
      await call(base + '/runners/' + serviceRunner.id, undefined, 'DELETE')
      await call(
        base + '/runner-groups/' + group.id,
        { repositories: ['settingstest/demo', 'settingstest/runner-images'] },
        'PATCH',
      )
    }
  }
  await fetch(origin + '/__fixture/offline', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ owner: 'settingstest', id: registered.id }),
  })
  // Scope this org-event permission check to the exercised repository. The
  // separate scaling fixture's 20 cold repositories are tested below.
  let eventCursor = '0'
  await eventually(async () => {
    const e = await call('/api/v1/events?wait=0&repos=settingstest/demo&since=' + eventCursor)
    eventCursor = e.cursor
    return e.events.some(
      (x) =>
        x.event === 'runner' &&
        !x.repository &&
        x.payload.action === 'offline' &&
        x.payload.owner === 'settingstest',
    )
  }, 'Runner offline event reaches the org admin stream')
  const outsiderEvents = await call(
    '/api/v1/events?wait=0&repos=settingstest/demo&since=0',
    undefined,
    'GET',
    tokens.outsider,
  )
  assert.equal(
    outsiderEvents.events.some(
      (x) => x.event === 'runner' && !x.repository && x.payload.owner === 'settingstest',
    ),
    false,
  )
  const scaling = await (await fetch(origin + '/__fixture/runner-scaling', { signal: AbortSignal.timeout(180000) })).json()
  console.log('Workerd 20 repos × 5 runners:', scaling)
  assert.equal(scaling.coldReadyCalls, 20)
  assert.equal(scaling.repeatedReadyCalls, 0)
  assert.equal(scaling.pollLeaseCalls, 0)
  // Browser controls at desktop and phone widths; instant search, setup,
  // group picker and inherited rows use real API responses.
  browser = await launchChrome()
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    colorScheme: 'dark',
  })
  await context.addInitScript(() => localStorage.setItem('gild.theme', 'system'))
  await context.addCookies([
    {
      name: 'gild_session',
      value: cookie('avatest'),
      domain: new URL(origin).hostname,
      path: '/',
    },
  ])
  const page = await context.newPage()
  page.on('response', async (response) => {
    if (
      response.status() >= 400 &&
      response.url().includes('/api/runner-settings/')
    )
      console.log(
        'Browser API failure:',
        response.status(),
        await response.text(),
      )
  })
  await page.goto(origin + '/orgs/settingstest/settings/runners')
  await page.getByText('bugsy', { exact: true }).waitFor()
  await page.getByLabel('Search runners').fill('no-match')
  assert.equal(await page.getByText('bugsy', { exact: true }).count(), 0)
  await page.getByLabel('Search runners').fill('')
  await page.getByLabel('Actions for bugsy').click()
  await page.getByRole('menuitem', { name: 'Edit labels' }).click()
  await page.getByLabel('Labels', { exact: true }).fill('fast, browser-proof')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('heading', { name: 'Edit labels · bugsy' }).waitFor({ state: 'hidden' })
  await page.getByText('browser-proof', { exact: true }).waitFor()
  assert.ok((await call(base + '/runners')).runners.find(r => r.name === 'bugsy').labels.some(l => l.name === 'browser-proof'))
  const nav = await page.getByRole('navigation', { name: 'Settings', exact: true }).innerText()
  const labels = ['General', 'Access', 'Members', 'Code and automation', 'Actions', 'Runners', 'Runner groups', 'Webhooks']
  for (let i = 1; i < labels.length; i++) assert.ok(nav.toLowerCase().indexOf(labels[i - 1].toLowerCase()) < nav.toLowerCase().indexOf(labels[i].toLowerCase()), 'approved org nav order: ' + JSON.stringify(nav))
  const lastSeen = page.locator('time').first()
  assert.match(await lastSeen.innerText(), /Last seen (just now|.* ago|yesterday)/)
  assert.ok(await lastSeen.getAttribute('title'))
  await page.goto(origin + '/orgs/settingstest/settings/runners/new/linux')
  await page.getByText('Works once', { exact: false }).waitFor()
  assert.equal(await page.getByLabel('Runner group', { exact: true }).inputValue(), 'default')
  assert.equal(await page.getByLabel('Runner group', { exact: true }).locator('option:checked').innerText(), 'Default')
  const groupSetup = origin + '/orgs/settingstest/settings/runners/new/linux?group=' + group.id
  await page.goto(groupSetup)
  await page.getByText('Works once', { exact: false }).waitFor()
  assert.equal(await page.getByLabel('Runner group', { exact: true }).inputValue(), group.id)
  const command = await page.locator('code').filter({ hasText: 'gild runner add' }).innerText()
  assert.match(command, /--token grt_[a-f0-9]{32}/)
  // Prove the visible command carries a usable, group-bound one-time token.
  const visibleToken = /--token (grt_[a-f0-9]{32})/.exec(command)[1]
  const visibleRunner = await call(base + '/runners', { ...data, name: 'visible-command' }, 'POST', visibleToken, 201)
  await call(base + '/runners', { ...data, name: 'visible-command-again' }, 'POST', visibleToken, 401)
  await call(base + '/runners/' + visibleRunner.id, undefined, 'DELETE')
  mkdirSync('docs/actions/screenshots', { recursive: true })
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1400, 400]) {
      await page.setViewportSize({ width, height: 1000 })
      for (const [name, path, ready] of [
        ['runners', '/orgs/settingstest/settings/runners', () => page.getByText('bugsy', { exact: true }).waitFor()],
        ['new-runner', '/orgs/settingstest/settings/runners/new/linux?group=' + group.id, () => page.getByText('Works once', { exact: false }).waitFor()],
        ['group', '/orgs/settingstest/settings/runner-groups/' + group.id, () => page.getByRole('button', { name: 'Save group' }).waitFor()],
        ['repo-actions', '/settingstest/demo/settings/actions', () => page.getByText('from', { exact: false }).first().waitFor()],
      ]) {
        if (name === 'repo-actions') {
          await verifyRepoRefresh({ origin, page, call, tokens, gitRoot, git, label: `${theme} ${width}` })
        } else {
          const response = await page.goto(origin + path)
          assert.equal(response.status(), 200, path)
        }
        try { await ready() } catch (e) {
          writeFileSync(join(work, 'browser-failure.html'), await page.content())
          await page.screenshot({path:join(work,'browser-failure.png'),fullPage:true})
          console.log('Browser failed on '+path+'; title: '+await page.title())
          throw e
        }
        assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, name + ' at ' + width)
        if (name === 'new-runner') {
          assert.equal(await page.getByLabel('Runner group', { exact: true }).inputValue(), group.id)
          assert.match(await page.locator('code').filter({ hasText: 'gild runner add' }).innerText(), /--token grt_[a-f0-9]{32}/)
          // Redact only the screenshot DOM after proving the real command above.
          await page.locator('code').evaluateAll(nodes => nodes.forEach(n => { n.textContent = n.textContent.replace(/grt_[a-f0-9]{32}/g, 'grt_<one-time>') }))
        }
        await page.screenshot({ path: `docs/actions/screenshots/${name}-${width}-${theme}.png`, fullPage: true })
      }
    }
  }
  await context.close()
  await call('/api/v1/repos/avatest/glance-test')
  // Give the existing corner pages their expected action run, too.
  for (let i = 0; i < 2; i++)
    await call(
      '/api/v1/repos/avatest/glance-test/actions/workflows/ci.yml/dispatches',
      { ref: 'main' },
      'POST',
      tokens.avatest,
      201,
    )
  const corner = join(work, 'corner.json')
  writeFileSync(corner, JSON.stringify({ secret: f.sessionSecret, sha: f.sha }))
  const cornerResult = await promisify(execFile)(
    'npm',
    ['run', 'test:corner', '--', origin, corner],
    { maxBuffer: 10 * 1024 * 1024 },
  )
  const evidence = {
    runtime:
      'Full OpenNext app, wrangler dev, local workerd; disposable Artifacts/Git transport',
    registration: 'gild runner add --org with one-time token, no identity.json',
    pushes: {
      'settingstest/demo':
        'owner runner bugsy: success; actual CLI checkout and logs',
      'settingstest/tools': 'queued; excluded from group',
    },
    checks: [
      'public default exclusion',
      'private selected repo checkout and job success',
      'public fork approval gates both runner kinds',
      'one-hour expiry and group-bound registration',
      'Basic and Bearer checkout second-repo rejection',
      'org admin runner events and outsider isolation',
      'native launchd install/status/uninstall on macOS',
      'cross-owner poll/read rejected',
      'checkout second repo rejected',
      'checkout token revoked after finish',
      'live group removal preserves running lease and blocks next job',
      'repo/owner concurrent HTTP polls: exactly one lease',
      'non-admin registration/group edits rejected',
      'single-use and owner-bound registration',
      'personal registration',
      'instant filter and edit labels',
      'responsive runner/group/setup/repo pages: light/dark at 1400/400',
      'real page command token consumed once; screenshots redact only after assertion',
      'group defaults to Default or originating group',
      'invalid runner and group API bodies return 422',
      'approved org navigation and relative last seen with absolute hover',
      'test:corner passed',
    ],
    scaling,
    liveFirstMs: firstMs,
    liveRepeatMs: repeatMs,
    corner: cornerResult.stdout.trim(),
  }
  writeFileSync(
    'docs/actions/owner-runner-local-evidence.json',
    JSON.stringify(evidence, null, 2) + '\n',
  )
  console.log(evidence)
  console.log('Fixture: ' + work)
} catch (e) {
  writeFileSync(join(work, 'failure.log'), String(e.stack))
  console.error('Fixture: ' + work)
  throw e
} finally {
  await browser?.close()
  worker.kill('SIGTERM')
  await new Promise((r) =>
    worker.exitCode !== null || worker.signalCode !== null ? r() : worker.once('exit', r),
  )
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
}
