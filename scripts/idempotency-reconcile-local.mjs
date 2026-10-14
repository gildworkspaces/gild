// Compiled OpenNext routes, actual DO SQLite, and actual Git writes. The only
// fault is loss of response persistence AFTER the production handler returns.
import { forgeFixture } from './forge-fixture.mjs'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
const f = await forgeFixture({ renderBuild: false, idempotencyFault: true })
const evidence = []
const repo = join(f.gitRoot, 'o-settingstest/demo.git')
const request = (path, body, key, token = f.tokens.avatest) => fetch(f.origin + path, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) })
const tip = () => f.git(repo, 'rev-parse', '_meta')
try {
  const until = Date.now() + 60000
  while (true) {
    try { if ((await fetch(f.origin + '/__fixture/calls?trace=recovery-ready', { signal: AbortSignal.timeout(1000) })).ok) break } catch {}
    assert.ok(Date.now() < until, 'fixture startup deadline')
    await new Promise(r => setTimeout(r, 250))
  }
  await fetch(f.origin + '/__fixture/refresh?owner=settingstest&repo=demo')
  const readyDeadline = Date.now() + 60000
  while (!(await (await fetch(f.origin + '/__fixture/state?key=settingstest/demo')).json()).index.ready) {
    assert.ok(Date.now() < readyDeadline, 'prepared metadata fixture deadline')
    await new Promise(r => setTimeout(r, 250))
  }
  const base = '/api/v1/repos/settingstest/demo'
  for (const [kind, path, body] of [
    ['issue', base + '/issues', { title: 'recover issue', body: 'one record' }],
    ['pull', base + '/pulls', { title: 'recover pull', body: 'one record', head: 'feature', base: 'main' }],
    ['issue comment', base + '/issues/1/comments', { body: 'recover comment' }],
    ['pull inline comment', base + '/pulls/2/comments', { body: 'recover inline', path: 'README.md', line: 1, side: 'RIGHT', commit_id: f.orgSha }],
  ]) {
    const armed = await request('/__fixture/idempotency-fault', { token: f.tokens.avatest })
    assert.equal(armed.status, 200, await armed.text())
    const before = tip(), key = 'reconcile-' + kind
    const first = await request(path, body, key)
    assert.equal(first.status, 500, 'post-commit response loss must be visible: ' + await first.text())
    const committed = tip()
    assert.notEqual(committed, before, 'the business write actually committed')
    const receipts = f.git(repo, 'ls-tree', '-r', '--name-only', '_meta').split('\n').filter(p => p.startsWith('.gild/operations/'))
    assert.equal(receipts.length, evidence.length + 1, 'each real write commits its own receipt')
    let recovered
    const deadline = Date.now() + 30000
    do {
      recovered = await request(path, body, key)
      if (recovered.status !== 409) break
      await new Promise(r => setTimeout(r, 250))
    } while (Date.now() < deadline)
    assert.equal(recovered.status, 201, await recovered.clone().text())
    assert.equal(recovered.headers.get('idempotency-reconciled'), 'true')
    const data = await recovered.json()
    assert.equal(tip(), committed, 'reconciliation must not commit another business record')
    const replay = await request(path, body, key)
    assert.equal(replay.status, 201, await replay.clone().text())
    assert.equal(replay.headers.get('idempotency-replayed'), 'true')
    assert.deepEqual(await replay.json(), data)
    assert.equal(tip(), committed, 'replay must not commit another business record')
    const conflict = await request(path, { ...body, body: 'different input' }, key)
    assert.equal(conflict.status, 409)
    assert.equal(tip(), committed)
    evidence.push({ kind, first: 500, recovered: 201, replay: 201, conflict: 409, commits: 1 })
  }
  const reconcile = async (path, body, key, token) => {
    const deadline = Date.now() + 30000
    while (true) {
      const r = await request(path, body, key, token)
      if (![409, 503].includes(r.status) || Date.now() >= deadline) return r
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  // This fault is INSIDE execute/writeMeta, after Git accepts the record but
  // before ACL publication returns; it exercises the original exception path.
  const insideBody = { title: 'inside-handler fault', body: 'one committed issue' }, insideKey = 'inside-handler'
  const armedInside = await request('/__fixture/postpush-fault', { owner: 'settingstest', repo: 'demo' })
  assert.equal(armedInside.status, 200, await armedInside.text())
  const beforeInside = tip(), inside = await request(base + '/issues', insideBody, insideKey)
  assert.equal(inside.status, 500, await inside.text())
  const insideTip = tip(); assert.notEqual(insideTip, beforeInside)
  const recoveredInside = await reconcile(base + '/issues', insideBody, insideKey)
  assert.equal(recoveredInside.status, 201, await recoveredInside.clone().text())
  assert.equal(recoveredInside.headers.get('idempotency-reconciled'), 'true')
  assert.equal(tip(), insideTip, 'inside-handler failure must not repeat the committed write')
  evidence.push({ kind: 'inside-handler post-push ACL failure', first: 500, recovered: 201, commits: 1 })

  // The same key/input belongs to two distinct authenticating principals.
  // Concurrent retries for each principal recover only that principal's record.
  const isolatedBody = { title: 'principal isolated creation', body: 'same input and key' }, isolatedKey = 'same-principal-key'
  const principals = ['avatest', 'adminuser']
  for (const name of principals) assert.equal((await request('/__fixture/idempotency-fault', { token: f.tokens[name] })).status, 200)
  const beforeIsolated = tip()
  const initial = await Promise.all(principals.map(name => request(base + '/issues', isolatedBody, isolatedKey, f.tokens[name])))
  for (const r of initial) assert.equal(r.status, 500, await r.text())
  const isolatedTip = tip()
  assert.equal(Number(f.git(repo, 'rev-list', '--count', beforeIsolated + '..' + isolatedTip)), 2, 'each principal creates exactly one record')
  const numbers = []
  for (const name of principals) {
    const responses = await Promise.all(Array.from({ length: 8 }, () => reconcile(base + '/issues', isolatedBody, isolatedKey, f.tokens[name])))
    const data = []
    for (const r of responses) { assert.equal(r.status, 201, await r.clone().text()); data.push(await r.json()) }
    for (const d of data) { assert.equal(d.user.login, name, 'receipt must belong to the authenticating principal'); assert.deepEqual(d, data[0]) }
    numbers.push(data[0].number)
    assert.equal(tip(), isolatedTip, 'concurrent recovery must not write again')
  }
  assert.notEqual(numbers[0], numbers[1], 'principals must never share operation receipts')
  evidence.push({ kind: 'concurrent/principal isolation', principals: 2, retriesPerPrincipal: 8, commits: 2, distinctRecords: true })
  writeFileSync(join(f.work, 'idempotency-recovery-evidence.json'), JSON.stringify(evidence, null, 2))
  console.log('PASS compiled Worker/DO/Git idempotency recovery', JSON.stringify(evidence))
} finally {
  f.worker.kill('SIGTERM')
  await new Promise(r => f.worker.exitCode !== null ? r() : f.worker.once('exit', r))
  await new Promise(r => f.server.close(r))
}
