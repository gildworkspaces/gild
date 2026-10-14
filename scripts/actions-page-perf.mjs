// Actions tab origin budget (#65) on the compiled OpenNext Worker with real
// D1, RunQueue and RepoIndex DOs. The private repository forces the dynamic
// server render that public pages only run when they are published.
// Origin round trips are the CI gate; wall-clock values are evidence only.
import { forgeFixture } from './forge-fixture.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const label = process.argv[2] ?? 'after'
const f = await forgeFixture({ renderBuild: false, staticReview: true })
const repo = 'settingstest/demo', base = '/' + repo
const cookie = 'gild_session=' + f.cookie('avatest')
const api = async (path, method = 'GET', body) => {
  const r = await fetch(f.origin + path, { method, headers: { authorization: 'Bearer ' + f.tokens.avatest, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) })
  return { ok: r.ok, status: r.status, text: await r.text() }
}
const timed = async (path) => {
  const start = performance.now(), r = await fetch(f.origin + path, { headers: { cookie }, signal: AbortSignal.timeout(120000) })
  const body = await r.text()
  return { path, status: r.status, ms: Math.round(performance.now() - start), calls: JSON.parse(r.headers.get('x-fixture-calls') ?? 'null'), body }
}
try {
  const deadline = Date.now() + 180000
  while (!(await api('/api/v1/repos/' + repo).catch(() => ({ ok: false }))).ok) {
    if (Date.now() > deadline) throw Error('Fixture startup: ' + f.logs.slice(-3000))
    await new Promise((r) => setTimeout(r, 400))
  }
  // The visibility change waits for the first index refresh; retry until it lands.
  for (let i = 0; ; i++) {
    const r = await api('/api/v1/repos/' + repo + '/visibility', 'PATCH', { visibility: 'private', confirm: repo })
    if (r.ok) break
    if (i === 30) throw Error('visibility: ' + r.status + ' ' + r.text)
    await new Promise((r) => setTimeout(r, 2000))
  }
  const pages = []
  pages.push(await timed(base + '/actions'))
  // Warm timing measures a ready immutable workflow artifact. A cold page
  // returns Pending while the real alarm prepares it, rather than parsing it.
  for (;;) {
    const ready = await timed(base + '/actions')
    if (ready.status === 200 && ready.body.includes('ci.yml') && !ready.body.includes('data-artifact-pending')) break
    assert.ok(Date.now() < deadline, 'workflow producer prepares the real artifact')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  for (let i = 0; i < 7; i++) pages.push(await timed(base + '/actions'))
  const polls = []
  for (let i = 0; i < 4; i++) polls.push(await timed('/api/repos/' + repo + '/actions'))
  for (const p of [...pages, ...polls]) assert.equal(p.status, 200, p.path + ': ' + p.body.slice(0, 300))
  // Effect: the page renders the parsed workflow and the live board.
  assert.match(pages.at(-1).body, /ci\.yml/, 'Actions tab lists the repository workflow')
  assert.ok(Array.isArray(JSON.parse(polls.at(-1).body).runs), 'board poll returns the run overview')
  const warm = pages.slice(2), warmPolls = polls.slice(1)
  const median = (rows) => rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)]
  const evidence = {
    label, runtime: 'compiled OpenNext Worker, local workerd, real D1/DOs, private repo (dynamic render)',
    firstPage: { ms: pages[0].ms, calls: pages[0].calls },
    warmPage: { medianMs: median(warm), maxMs: Math.max(...warm.map((r) => r.ms)), calls: warm.map((r) => r.calls) },
    warmPoll: { medianMs: median(warmPolls), calls: warmPolls.map((r) => r.calls) },
  }
  mkdirSync('.tmp', { recursive: true })
  writeFileSync(`.tmp/actions-page-perf-${label}.json`, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
  for (const r of warm)
    assert.equal(r.calls.queue, 1, `warm Actions tab RunQueue round trips: ${r.calls.queue} != 1`)
  for (const r of warmPolls)
    assert.equal(r.calls.queue, 1, `warm board poll RunQueue round trips: ${r.calls.queue} != 1`)
  console.log('PASS Actions tab: one RunQueue round trip per warm page view and per board poll')
} finally {
  f.worker.kill('SIGTERM')
  await new Promise((r) => f.server.close(r))
}
