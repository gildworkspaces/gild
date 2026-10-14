import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  chmodSync,
  rmSync,
} from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { build } from 'esbuild'
import assert from 'node:assert/strict'
const root = resolve('.tmp')
mkdirSync(root, { recursive: true })
const work = mkdtempSync(join(root, 'actions-e2e-')),
  fixture = join(work, 'repo'),
  state = join(work, 'state'),
  configRoot = join(work, 'config'),
  cli = resolve('../gild-cli')
mkdirSync(fixture)
process.env.TMPDIR = root
const git = (...a) =>
  execFileSync('git', a, { cwd: fixture, encoding: 'utf8' }).trim()
const write = (path, value) => {
  mkdirSync(dirname(join(fixture, path)), { recursive: true })
  writeFileSync(join(fixture, path), value)
}
const commit = (message) => {
  git('add', '.')
  git('-c', 'commit.gpgsign=false', 'commit', '-m', message)
  return git('rev-parse', 'HEAD')
}
git('init', '-b', 'main')
git('config', 'receive.denyCurrentBranch', 'ignore')
const yaml = `name: Fixture CI\non: [push, workflow_dispatch, pull_request]\njobs:\n  test:\n    runs-on: [self-hosted, ${process.platform === 'darwin' ? 'macos' : 'linux'}, ${process.arch}]\n    steps:\n      - uses: actions/checkout@v4\n      - name: Check Node\n        uses: actions/setup-node@v4\n        with:\n          node-version: '${process.versions.node.split('.')[0]}'\n      - name: Echo\n        working-directory: \${{ github.workspace }}\n        run: |\n          echo 'hello from gild'\n          test \"$PWD\" = \"\${{ github.workspace }}\"\n      - name: Node\n        env:\n          TEST_SECRET: \${{ secrets.TEST_SECRET }}\n        run: >-\n          node -e "process.stdout.write('answer=42\\\\n'); const s=process.env.TEST_SECRET; process.stdout.write(s.slice(0,8)); setTimeout(()=>console.log(s.slice(8)),300)"\n`
write('.github/workflows/ci.yml', yaml)
write('README.md', '# Actions fixture\n')
const sha = commit('Exercise gild Actions')
git('switch', '--orphan', '_meta')
write(
  '.gild/index.json',
  JSON.stringify({ schema: 1, issues: [], pulls: [], queue: [] }),
)
write('.gild/acl.json', JSON.stringify({ owners: ['@acme'], visibility: 'public' }))
commit('Fixture metadata')
git('switch', 'main')
let gitReads = 0
const gitServer = createServer((req, res) => {
  const path = new URL(req.url, 'http://local'),
    advertise = path.pathname.endsWith('/info/refs'),
    service = advertise
      ? path.searchParams.get('service')
      : path.pathname.endsWith('/git-receive-pack')
        ? 'git-receive-pack'
        : 'git-upload-pack'
  if (
    !path.pathname.startsWith('/repo.git/') ||
    !['git-upload-pack', 'git-receive-pack'].includes(service)
  ) {
    res.writeHead(404).end()
    return
  }
  gitReads++
  res.setHeader(
    'Content-Type',
    `application/x-${service}-${advertise ? 'advertisement' : 'result'}`,
  )
  if (advertise)
    res.write(
      `001f# service=${service}\n0000`.replace(
        /^001f/,
        service === 'git-upload-pack' ? '001e' : '001f',
      ),
    )
  const child = spawn(
    'git',
    [
      '-c',
      'uploadpack.allowAnySHA1InWant=true',
      service.slice(4),
      '--stateless-rpc',
      ...(advertise ? ['--advertise-refs'] : []),
      fixture,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  req.pipe(child.stdin)
  child.stdout.pipe(res)
  child.stderr.resume()
  child.on('error', () => res.destroy())
})
await new Promise((r) => gitServer.listen(0, '127.0.0.1', r))
const remote = `http://127.0.0.1:${gitServer.address().port}/repo.git`
const free = createServer()
await new Promise((r) => free.listen(0, '127.0.0.1', r))
const port = free.address().port
await new Promise((r) => free.close(r))
const origin = `http://127.0.0.1:${port}`
const entry = join(work, 'worker.mjs')
await build({
  entryPoints: ['scripts/actions-test-worker.ts'],
  outfile: entry,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  external: ['cloudflare:workers', 'node:*'],
  conditions: ['workerd', 'browser'],
})
const config = join(work, 'wrangler.json'),
  schema = join(work, 'schema.sql')
writeFileSync(
  config,
  JSON.stringify({
    name: 'gild-actions-local-fixture',
    main: entry,
    compatibility_date: '2026-10-01',
    compatibility_flags: ['nodejs_compat'],
    send_metrics: false,
    vars: { ACTIONS_SECRET_KEY: randomBytes(32).toString('base64') },
    durable_objects: {
      bindings: [{ name: 'RUN_QUEUE', class_name: 'TestRunQueue' },{name:'API_CONTROL',class_name:'ApiControl'}],
    },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['TestRunQueue','ApiControl'] }],
    ...(process.argv.includes('--r2')
      ? {
          r2_buckets: [
            {
              binding: 'ACTION_LOGS',
              bucket_name: 'gild-actions-fixture-logs',
            },
          ],
        }
      : {}),
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'actions-fixture',
        database_id: '00000000-0000-0000-0000-000000000001',
      },
    ],
  }),
)
writeFileSync(
  schema,
  readdirSync('migrations').filter(file => file.endsWith('.sql')).sort().map(file => readFileSync('migrations/' + file, 'utf8')).join('\n'),
)
execFileSync(
  resolve('node_modules/.bin/wrangler'),
  [
    'd1',
    'execute',
    'actions-fixture',
    '--local',
    '--config',
    config,
    '--persist-to',
    state,
    '--file',
    schema,
  ],
  { stdio: 'pipe', env: { ...process.env, TMPDIR: root } },
)
const logPath = join(work, 'wrangler.log'),
  workerLog = []
function launchWorker() {
  const worker = spawn(
    resolve('node_modules/.bin/wrangler'),
    [
      'dev',
      '--local',
      '--config',
      config,
      '--persist-to',
      state,
      '--port',
      String(port),
      '--ip',
      '127.0.0.1',
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TMPDIR: root },
    },
  )
  worker.stdout.on('data', (b) => workerLog.push(b.toString()))
  worker.stderr.on('data', (b) => workerLog.push(b.toString()))
  return worker
}
let worker = launchWorker()
async function stopWorker() {
  if (worker.exitCode !== null) return
  const exit = new Promise((r) => worker.once('exit', r))
  worker.kill('SIGTERM')
  await exit
}
async function ready() {
  const started = Date.now()
  while (true) {
    try {
      await fetch(origin)
      return
    } catch {
      if (worker.exitCode !== null || Date.now() - started > 30000)
        throw new Error('wrangler did not start')
      await new Promise((r) => setTimeout(r, 100))
    }
  }
}
const token = `gf_${randomBytes(16).toString('hex')}`,
  api = `${origin}/api/repos/acme/demo/actions`
async function call(path, body, method = 'POST', auth = token) {
  const r = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const b = await r.json()
  assert.equal(r.ok, true, `HTTP ${r.status}: ${b.error ?? ''}`)
  return b
}
const event = (key = crypto.randomUUID(), extra = {}) => ({
  name: 'push',
  ref: 'refs/heads/main',
  sha,
  before: '0'.repeat(40),
  title: '',
  actor: 'acme',
  repository: 'acme/demo',
  key,
  ...extra,
})
const bin = join(work, 'bin')
mkdirSync(bin, { recursive: true })
mkdirSync(configRoot, { recursive: true, mode: 0o700 })
writeFileSync(
  join(configRoot, 'identity.json'),
  JSON.stringify({schema:1,name:'acme',device:'fixture',publicKey:'fixture',secretKey:'fixture',apiToken:{server:origin,token},createdAt:new Date().toISOString()}),
  { mode: 0o600 },
)
const binary = join(bin, 'gild')
execFileSync(
  'bun',
  ['build', '--compile', 'src/gild.ts', '--outfile', binary],
  {
    cwd: cli,
    stdio: 'pipe',
    env: { ...process.env, TMPDIR: join(cli, '.tmp') },
  },
)
const cliEnv = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  TMPDIR: join(cli, '.tmp'),
}
const gild = (...a) =>
  execFileSync('gild', a, { cwd: cli, encoding: 'utf8', env: cliEnv })
const gildAsync = (...args) =>
  new Promise((done, reject) => {
    const child = spawn('gild', args, {
      cwd: cli,
      env: cliEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (b) => (output += b))
    child.stderr.on('data', (b) => (output += b))
    child.on('error', reject)
    child.once('exit', (code) =>
      code === 0
        ? done(output)
        : reject(new Error(`CLI exit ${code}: ${output}`)),
    )
  })
let observed = []
try {
  await ready()
  await call(`${origin}/fixture`, { url: remote, token, event: event(), access: { meta: git('rev-parse', '_meta'), acl: JSON.parse(git('show', '_meta:.gild/acl.json')) } })
  await call(`${origin}/drain`, undefined, 'GET')
  const listStart = performance.now(),
    view = await call(api, undefined, 'GET'),
    listMs = performance.now() - listStart,
    repeatStart = performance.now()
  await call(api, undefined, 'GET')
  const repeatListMs = performance.now() - repeatStart
  assert.equal(view.runs[0].status, 'queued')
  const run = view.runs[0].id
  const first = await call(`${origin}/workflow?sha=${sha}`, undefined, 'GET'),
    gitCount = gitReads,
    cached = await call(`${origin}/workflow?sha=${sha}`, undefined, 'GET')
  assert.equal(cached.cached, true)
  assert.equal(gitReads, gitCount, 'cached workflows must not read git')
  write('README.md', '# Actions fixture\nImmutable timing change.\n')
  const coldSha = commit('Immutable workflow timing fixture'),
    cold = await call(`${origin}/workflow?sha=${coldSha}`, undefined, 'GET'),
    warm = await call(`${origin}/workflow?sha=${coldSha}`, undefined, 'GET')
  assert.equal(cold.cached, false)
  assert.equal(warm.cached, true)
  gild(
    'runner',
    'add',
    '--repo',
    'acme/demo',
    '--name',
    'alpha',
    '--server',
    origin,
    '--config-dir',
    configRoot,
  )
  gild(
    'runner',
    'add',
    '--repo',
    'acme/demo',
    '--name',
    'beta',
    '--server',
    origin,
    '--config-dir',
    configRoot,
  )
  const alpha = JSON.parse(
      readFileSync(join(configRoot, 'runners/alpha.json'), 'utf8'),
    ),
    beta = JSON.parse(
      readFileSync(join(configRoot, 'runners/beta.json'), 'utf8'),
    )
  // Actual concurrent HTTP claims; second waiter loses atomically in SQLite.
  const [a, b] = await Promise.all([
    call(`${api}/runners/poll`, { wait: 0 }, 'POST', alpha.token),
    call(`${api}/runners/poll`, { wait: 0 }, 'POST', beta.token),
  ])
  assert.equal([a.job, b.job].filter(Boolean).length, 1)
  const winner = a.job ? alpha : beta,
    assigned = a.job ?? b.job
  await call(
    `${api}/runners/finish`,
    {
      job: assigned.job,
      lease: assigned.lease,
      status: 'failure',
      reason: 'race fixture complete',
    },
    'POST',
    winner.token,
  )
  await call(
    `${api}/secrets/TEST_SECRET`,
    { value: 'local-fixture-secret' },
    'PUT',
  )
  const listed = await call(`${api}/secrets`, undefined, 'GET')
  assert.deepEqual(
    listed.secrets.map((s) => s.name),
    ['TEST_SECRET'],
  )
  assert.doesNotMatch(JSON.stringify(listed), /local-fixture-secret/)
  const fresh = await call(`${api}/runs/${run}/rerun`, {}),
    id = fresh.id
  observed = ['queued']
  const child = spawn(
    'gild',
    [
      'runner',
      'start',
      '--name',
      'alpha',
      '--once',
      '--config-dir',
      configRoot,
    ],
    { cwd: cli, env: cliEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stdout = '',
    stderr = ''
  child.stdout.on('data', (b) => (stdout += b))
  child.stderr.on('data', (b) => (stderr += b))
  const completion = new Promise((done) =>
    child.once('exit', (code) => done(code)),
  )
  let watching = Promise.resolve(), watchError
  const watch = setInterval(() => {
    watching = watching.then(async () => {
      const v = await call(`${api}/runs/${id}`, undefined, 'GET')
      if (!observed.includes(v.run.status)) observed.push(v.run.status)
    }).catch(error => { watchError ??= error })
  }, 200)
  const exit = await completion
  clearInterval(watch)
  await watching
  if (watchError) throw watchError
  writeFileSync(join(work, 'runner.log'), stdout + stderr)
  assert.equal(exit, 0, stderr)
  const result = await call(`${api}/runs/${id}`, undefined, 'GET')
  if (result.run.status !== 'success') {
    for (const job of result.jobs) for (const step of job.steps) {
      const logs = await call(`${api}/runs/${id}/logs?job=${job.id}&step=${step.position}`, undefined, 'GET')
      console.error('Failed fixture step', step, logs)
    }
  }
  assert.equal(
    result.run.status,
    'success',
    JSON.stringify(result.jobs.map((j) => j.reason)),
  )
  assert.ok(observed.includes('running'))
  observed.push('success')
  const output = []
  for (const j of result.jobs)
    for (const step of j.steps) {
      const logs = await call(
        `${api}/runs/${id}/logs?job=${j.id}&step=${step.position}`,
        undefined,
        'GET',
      )
      output.push(...logs.chunks.map((c) => c.text))
      assert.equal(step.status, 'success')
      assert.equal(step.exit, 0)
    }
  const text = output.join('')
  assert.match(text, /hello from gild/)
  assert.match(text, /answer=42/)
  assert.doesNotMatch(text, /local-fixture-secret/)
  assert.match(text, /\*\*\*/)
  await call(`${origin}/drain`, undefined, 'GET')
  const archive = JSON.parse(git('show', `_meta:.gild/actions/${id}.json`))
  assert.equal(archive.run.status, 'success')
  assert.doesNotMatch(JSON.stringify(archive), /local-fixture-secret/)
  if (process.argv.includes('--r2')) {
    await call(`${origin}/expire-logs?run=${id}`, undefined, 'GET')
    const echo = result.jobs[0].steps.find((s) => s.name === 'Echo'),
      restored = await call(
        `${api}/runs/${id}/logs?job=${result.jobs[0].id}&step=${echo.position}`,
        undefined,
        'GET',
      )
    assert.match(restored.chunks.map((c) => c.text).join(''), /hello from gild/)
  }
  const listing = gild('runner', 'list', '--config-dir', configRoot)
  assert.match(listing, /alpha.*idle/)
  // Assignment token must be repo-scoped, revoked removal stops HTTP access.
  gild('runner', 'remove', 'beta', '--config-dir', configRoot)
  const revoked = await fetch(`${api}/runners/heartbeat`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${beta.token}`,
      'content-type': 'application/json',
    },
    body: '{}',
  })
  assert.equal(revoked.status, 401)
  // Hold processing at a transport miss, restart the Worker, then resume.
  const retry = event('persisted-event', { sha: coldSha })
  await call(`${origin}/pause?value=1`, undefined, 'GET')
  await call(`${origin}/deliver-fixture`, retry)
  await call(`${origin}/drain`, undefined, 'GET')
  assert.ok(
    (await call(api, undefined, 'GET')).pendingEvents.some(
      (e) => e.key === retry.key,
    ),
  )
  await stopWorker()
  worker = launchWorker()
  await ready()
  await call(`${origin}/pause?value=0`, undefined, 'GET')
  await call(`${origin}/drain`, undefined, 'GET')
  const delivered = await call(api, undefined, 'GET')
  assert.equal(
    delivered.runs.filter((r) => r.event.key === retry.key).length,
    1,
  )
  await call(`${api}/runs/${delivered.runs[0].id}/cancel`, {})
  const scenario = async (steps, name, extra = {}) => {
    write(
      '.github/workflows/ci.yml',
      `name: ${name}\non: [push, pull_request]\njobs:\n  test:\n    runs-on: self-hosted\n    steps:\n${steps}\n`,
    )
    const testSha = commit(name),
      v = await call(
        `${origin}/dispatch-fixture`,
        event(crypto.randomUUID(), { sha: testSha, title: name, ...extra }),
      ),
      testId = v.runs[0].id
    if (extra.name === 'pull_request') await call(`${api}/runs/${testId}/approve`, {})
    await gildAsync(
      'runner',
      'start',
      '--name',
      'alpha',
      '--once',
      '--config-dir',
      configRoot,
    )
    const d = await call(`${api}/runs/${testId}`, undefined, 'GET'),
      out = []
    for (const j of d.jobs)
      for (const s of j.steps) {
        const l = await call(
          `${api}/runs/${testId}/logs?job=${j.id}&step=${s.position}`,
          undefined,
          'GET',
        )
        out.push(...l.chunks.map((c) => c.text))
      }
    return { d, text: out.join(''), sha: testSha }
  }
  const unsupported = await scenario(
    '      - uses: unsupported/action@v1',
    'Unsupported action',
  )
  assert.equal(unsupported.d.run.status, 'failure')
  assert.match(unsupported.text, /gild doesn't run unsupported\/action@v1 yet/)
  const failedJob = unsupported.d.jobs[0],
    jobLogURL = `${api}/runs/${unsupported.d.run.id}/jobs/${failedJob.id}/logs`,
    firstLogStart = performance.now(),
    failedLogs = await call(jobLogURL, undefined, 'GET'),
    firstLogMs = performance.now() - firstLogStart,
    repeatedLogStart = performance.now()
  assert.ok(failedLogs.logs.some(chunk => chunk.text.includes("gild doesn't run unsupported/action@v1 yet") && chunk.step === 0))
  assert.deepEqual(await call(jobLogURL, undefined, 'GET'), failedLogs)
  console.log(`Failed job log read: first ${firstLogMs.toFixed(1)} ms, repeated ${(performance.now()-repeatedLogStart).toFixed(1)} ms; retained chunks, no recomputation`)
  assert.equal((await fetch(jobLogURL.replace(`/jobs/${failedJob.id}/`, '/jobs/999999/'))).status, 404)
  assert.equal((await fetch(jobLogURL + '/unknown')).status, 404)

  const tolerated = await scenario(
    "      - run: 'exit 7'\n        continue-on-error: true\n      - run: echo continued",
    'Continue on error',
  )
  assert.equal(tolerated.d.run.status, 'success')
  assert.equal(tolerated.d.jobs[0].steps[0].exit, 7)
  assert.match(tolerated.text, /continued/)
  const oversized = await scenario(
    `      - env:\n          TEST_SECRET: \${{ secrets.TEST_SECRET }}\n        run: >-\n          node -e \"process.stdout.write('x'.repeat(32760)+process.env.TEST_SECRET);setTimeout(()=>console.log('late tail'),1000)\"`,
    'Oversized output line',
  )
  assert.equal(oversized.d.run.status, 'failure')
  assert.match(oversized.text, /output line exceeds/)
  assert.doesNotMatch(
    oversized.text,
    /local-fixture-secret|fixture-secret|local-fixt/,
  )
  const timeout = await scenario(
    "      - run: 'sleep 20'\n        timeout-minutes: 0.001",
    'Step timeout',
  )
  assert.equal(timeout.d.run.status, 'failure')
  assert.equal(timeout.d.jobs[0].steps[0].exit, 124)
  assert.match(timeout.text, /step timeout/)
  const pr = await scenario(
    '      - env:\n          TEST_SECRET: \${{ secrets.TEST_SECRET }}\n        run: >-\n          node -e "console.log(\'pr secret length=\' + process.env.TEST_SECRET.length)"',
    'Pull request secrets',
    { name: 'pull_request', pull: 1, action: 'opened', baseRef: 'main' },
  )
  assert.equal(pr.d.run.status, 'success')
  assert.match(pr.text, /pr secret length=0/)
  const leased = await call(`${api}/runs/${id}/rerun`, {}),
    picked = await call(`${api}/runners/poll`, { wait: 0 }, 'POST', alpha.token)
  assert.ok(picked.job)
  await call(`${origin}/expired`, undefined, 'GET')
  const lost = await call(`${api}/runs/${leased.id}`, undefined, 'GET')
  assert.equal(lost.run.status, 'failure')
  assert.match(lost.jobs[0].reason, /heartbeat lost/)
  assert.equal(
    (await call(`${origin}/gate?sha=${sha}`, undefined, 'GET')).ok,
    true,
  )
  await call(`${api}/settings`, { required: ['ci.yml'] }, 'PUT')
  assert.equal(
    (await call(`${origin}/gate?sha=${sha}`, undefined, 'GET')).ok,
    false,
    'newest failed rerun must block older success',
  )
  assert.equal(
    (await call(`${origin}/gate?sha=${tolerated.sha}`, undefined, 'GET')).ok,
    true,
  )
  await call(`${api}/settings`, { required: [] }, 'PUT')
  await call(`${origin}/drain`, undefined, 'GET')

  const evidence = {
    observed: [...new Set(observed)],
    logStorage: process.argv.includes('--r2')
      ? 'R2 archive, read back after DO log removal'
      : 'capped DO fallback',
    race: 'two concurrent HTTP polls, exactly one assignment',
    negativeChecks: [
      'unsupported action failure',
      'continue-on-error',
      'step timeout',
      'oversized lines fail without emitting secret tails',
      'PR secrets withheld',
      'runner heartbeat loss',
      'latest-attempt merge gate',
      'runner revocation',
      'durable trigger survives Worker restart',
    ],
    runListFirstMs: listMs,
    runListRepeatMs: repeatListMs,
    workflowColdMs: cold.ms,
    workflowCachedMs: warm.ms,
    gitReadsForCachedWorkflow: 0,
    run: id,
    logs: ['hello from gild', 'answer=42', '***'],
    archive: `_meta:.gild/actions/${id}.json`,
    wrangler: 'local only, no Cloudflare credentials',
    secretKey: 'generated disposable fixture binding; not printed',
  }
  mkdirSync('.tmp/actions-evidence', { recursive: true })
  writeFileSync(
    '.tmp/actions-evidence/local-evidence.json',
    JSON.stringify(evidence, null, 2) + '\n',
  )
  writeFileSync(
    join(root, 'actions-browser-fixture.json'),
    JSON.stringify({
      origin,
      token,
      view: await call(api, undefined, 'GET'),
      detail: result,
      failure: unsupported.d,
      workflows: cached.workflows,
    }),
  )
  console.log(evidence)
  if (process.argv.includes('--browser'))
    execFileSync(process.execPath, ['scripts/actions-browser.mjs'], { stdio: 'inherit' })
  if (process.argv.includes('--serve')) {
    console.log(`Actions fixture ready on ${origin}`)
    await new Promise((r) => {
      process.once('SIGINT', r)
      process.once('SIGTERM', r)
    })
  }
} finally {
  await stopWorker()
  gitServer.closeAllConnections()
  await new Promise((r) => gitServer.close(r))
  writeFileSync(logPath, workerLog.join(''))
  rmSync(binary, { force: true })
}
