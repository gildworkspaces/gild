// Complete OpenNext pages over local HTTP/workerd, with local Git/Artifacts.
// Run after build:cloudflare. Nothing in this fixture uses remote credentials.
import { forgeFixture } from './forge-fixture.mjs'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
const label = process.argv[2] ?? 'after'
const f = await forgeFixture({ repoListPerf: true })
let worker = f.worker
const get = async (path) =>
  fetch(f.origin + path, { signal: AbortSignal.timeout(15000) })
async function eventually(read) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    try {
      if (await read()) return
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw Error('Fixture did not become ready: ' + f.work)
}
async function measure(path, cards) {
  const start = performance.now(),
    response = await get(path),
    html = await response.text()
  assert.equal(response.status, 200, html.slice(0, 300))
  assert.equal(
    (html.match(/<article/g) ?? []).length,
    cards,
    'complete SSR cards at ' + path,
  )
  return performance.now() - start
}
const stop = async () => {
  if (worker.exitCode !== null) return
  await new Promise((r) => {
    worker.once('exit', r)
    worker.kill('SIGTERM')
  })
}
try {
  await eventually(async () => (await get('/api/v1/openapi.json')).ok)
  const repos = [
    'glance-test',
    ...Array.from({ length: 14 }, (_, i) => 'perf-' + i),
  ]
  // Pre-existing indexed repositories, as on prod; indexing time is separate
  // from a request and the before/after pages see the same published data.
  for (const name of repos) {
    await get(`/__fixture/refresh?owner=avatest&repo=${name}`)
    await eventually(
      async () => (await get(`/api/v1/repos/avatest/${name}/branches`)).ok,
    )
    await eventually(
      async () =>
        (await (await get('/__fixture/history?key=avatest/' + name)).json())
          .ready,
    )
  }
  const firstOwner = await measure('/avatest', 15)
  const owner = [],
    landing = []
  for (let i = 0; i < 10; i++) owner.push(await measure('/avatest', 15))
  // Other fixture owners are not indexed yet; warm them through their API.
  for (const name of ['demo', 'tools', 'runner-images']) {
    await get(`/__fixture/refresh?owner=settingstest&repo=${name}`)
    await eventually(
      async () => (await get(`/api/v1/repos/settingstest/${name}/branches`)).ok,
    )
    await eventually(
      async () =>
        (
          await (
            await get('/__fixture/history?key=settingstest/' + name)
          ).json()
        ).ready,
    )
  }
  const firstLanding = await measure('/', 6)
  for (let i = 0; i < 10; i++) landing.push(await measure('/', 6))
  await stop()
  worker = spawn(
    resolve('node_modules/.bin/wrangler'),
    [
      'dev',
      '--local',
      '--config',
      f.config,
      '--persist-to',
      f.state,
      '--port',
      new URL(f.origin).port,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let logs = ''
  for (const stream of [worker.stdout, worker.stderr])
    stream.on('data', (b) => {
      logs += b
      writeFileSync(join(f.work, 'restart.log'), logs)
    })
  await eventually(async () => (await get('/api/v1/openapi.json')).ok)
  const newIsolateLanding = await measure('/', 6)
  const dir = join(f.gitRoot, 'u-avatest', 'glance-test.git')
  writeFileSync(join(dir, 'pushed.ts'), 'export const pushed = 2\n')
  f.git(dir, 'add', 'pushed.ts')
  f.git(
    dir,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'Performance fixture push',
  )
  await get('/__fixture/refresh?key=avatest/glance-test')
  const firstAfterPush = await measure('/avatest', 15)
  const pushedAt = new Date(Number(f.git(dir, 'show', '-s', '--format=%ct', 'main')) * 1000).toISOString()
  await eventually(async () => (await (await get('/avatest')).text()).includes(pushedAt))
  // This fails if the alarm's projection publication is removed: refreshing
  // the index alone cannot update a warm D1 listing pointer.
  const publishedPushView = await measure('/avatest', 15)
  const stats = (rows) => ({
    medianMs: rows.toSorted((a, b) => a - b)[5],
    maxMs: Math.max(...rows),
  })
  const evidence = {
    label,
    runtime:
      'complete OpenNext HTML via local wrangler/workerd, D1, 15 real Git repos and local Artifacts transport',
    firstOwner,
    owner: stats(owner),
    firstLanding,
    landing: stats(landing),
    newIsolateLanding,
    firstAfterPush,
    publishedPushView,
    publishedTipVisible: true,
    deferredRefreshMs: 2000,
  }
  writeFileSync(
    resolve('.tmp', `listing-pages-${label}.json`),
    JSON.stringify(evidence, null, 2),
  )
  console.log(evidence)
  if (label === 'after') {
    assert.ok(evidence.owner.maxMs < 400, 'owner warm maximum <400 ms')
    assert.ok(evidence.landing.maxMs < 300, 'landing warm maximum <300 ms')
    assert.ok(
      firstAfterPush < 1500,
      'first push view serves last published summary <1.5 s',
    )
  }
} finally {
  await stop()
  f.server.closeAllConnections()
  await new Promise((r) => f.server.close(r))
}
