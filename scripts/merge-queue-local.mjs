import { forgeFixture } from './forge-fixture.mjs'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const f = await forgeFixture({ renderBuild: false, mergeQueue: true })
let worker = f.worker
const api = '/api/v1/repos/settingstest/demo'
const ready = async () => {
  const until = Date.now() + 60000
  while (true) {
    try { if ((await fetch(f.origin + '/__fixture/calls?trace=merge-ready', { signal: AbortSignal.timeout(1000) })).ok) return } catch {}
    assert.ok(Date.now() < until, 'fixture startup deadline')
    await new Promise(r => setTimeout(r, 250))
  }
}
const request = async (path, method = 'GET', body, actor = 'avatest') => {
  const response = await fetch(f.origin + path, {
    method, headers: { authorization: 'Bearer ' + (f.tokens[actor] ?? actor), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  })
  assert.ok(response.ok, `${method} ${path} ${response.status}: ${await response.clone().text()}`)
  return response
}
const directory = join(f.gitRoot, 'o-settingstest', 'demo.git'), git = (...args) => f.git(directory, ...args)
try {
  git('switch', 'feature')
  writeFileSync(join(directory, 'queued-feature.txt'), 'durable merge fixture\n')
  git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Queued feature')
  const head = git('rev-parse', 'HEAD'); git('switch', 'main'); const before = git('rev-parse', 'HEAD')
  await ready()
  await request('/__fixture/refresh?owner=settingstest&repo=demo')
  const preparedUntil = Date.now() + 60000
  while (!(await (await request('/__fixture/state?key=settingstest/demo')).json()).index.ready) {
    assert.ok(Date.now() < preparedUntil, 'metadata preparation deadline')
    await new Promise(r => setTimeout(r, 250))
  }
  await request('/__fixture/merge-queue', 'POST', { required: ['ci.yml'] })
  await request(api + '/pulls/2/reviews', 'POST', { event: 'APPROVE', body: 'Reviewed exact head' }, 'adminuser')
  const queued = await request(api + '/pulls/2/merge', 'PUT', {})
  assert.equal(queued.status, 202)
  await queued.body.cancel() // lost acknowledgement; no second merge request
  assert.equal(git('rev-parse', 'main'), before, 'pending required CI must not merge')
  const pending = await (await request('/__fixture/merge-queue')).json()
  assert.equal(pending.intents.length, 1, 'pre-write intent must persist with the Git queue receipt')
  assert.deepEqual(JSON.parse(git('show', '_meta:.gild/queue.json')), [2])
  worker.kill('SIGTERM'); await new Promise(r => worker.exitCode !== null ? r() : worker.once('exit', r))
  worker = spawn(f.worker.spawnfile, f.worker.spawnargs.slice(1), { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''; worker.stdout.on('data', d => logs += d); worker.stderr.on('data', d => logs += d)
  await ready()
  assert.equal((await (await request('/__fixture/merge-queue')).json()).intents.length, 1, 'Worker restart must preserve merge intent')
  const registration = await (await request(api + '/actions/runners', 'POST', {
    name: 'merge-fixture-runner', os: process.platform === 'darwin' ? 'macos' : 'linux', arch: process.arch, labels: [],
  })).json()
  await request(api + '/actions/workflows/ci.yml/dispatches', 'POST', { ref: 'feature' })
  let assignment = null; const until = Date.now() + 45000
  while (!assignment) {
    assignment = (await (await request(api + '/actions/runners/poll', 'POST', { wait: 1000 }, registration.token)).json()).job
    assert.ok(Date.now() < until, 'required CI job must reach fixture runner')
  }
  assert.equal(assignment.sha, head, 'required run must be for current head')
  for (let step = 0; step < assignment.steps.length; step++) await request(api + '/actions/runners/step', 'POST', {
    job: assignment.job, lease: assignment.lease, step, status: 'success', exit: 0,
  }, registration.token)
  await request(api + '/actions/runners/finish', 'POST', {
    job: assignment.job, lease: assignment.lease, status: 'success', reason: null,
  }, registration.token)
  // Poll Git truth only. Actual finish + native alarm must resume the merge;
  // no fixture drain, alarm call or re-enqueue is allowed after CI finishes.
  const finishUntil = Date.now() + 45000
  while (JSON.parse(git('show', '_meta:.gild/2/pr/pr.json')).state !== 'merged') {
    assert.ok(Date.now() < finishUntil, 'native finish alarm failed to resume queued merge; ' + logs.slice(-1500))
    await new Promise(r => setTimeout(r, 250))
  }
  const pull = JSON.parse(git('show', '_meta:.gild/2/pr/pr.json')), merged = git('rev-parse', 'main')
  assert.notEqual(merged, before); assert.equal(pull.merged.commit, merged)
  const untilRetired = Date.now() + 5000
  while ((await (await request('/__fixture/merge-queue')).json()).needed) {
    assert.ok(Date.now() < untilRetired, 'observed completed intent must retire')
    await new Promise(r => setTimeout(r, 250))
  }
  const evidence = {
    runtime: 'compiled OpenNext + actual workerd/D1/RunQueue/RepoIndex/Git', head, merge: merged,
    pendingCiNoPush: true, acknowledgementLost: true, restartPreservesIntent: true,
    actualRunnerLeaseFinish: true, nativeAlarmResumes: true, noSecondMergeRequest: true, intentRetired: true,
    limits: 'fixture runner reports success through actual step/finish protocol; no provider/model/workflow execution certification',
  }
  writeFileSync(join(f.work, 'merge-queue-evidence.json'), JSON.stringify(evidence, null, 2))
  console.log('PASS durable merge queue actual Worker', JSON.stringify(evidence))
} finally {
  worker.kill('SIGTERM'); await new Promise(r => worker.exitCode !== null ? r() : worker.once('exit', r))
  await new Promise(r => f.server.close(r))
}
