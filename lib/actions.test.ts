import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  parseWorkflow,
  expandMatrix,
  matchesTrigger,
  expression,
  interpolate,
  context,
  labelsMatch,
  type Event,
} from './actions/workflow.ts'
import {
  RunStore,
  resolveAssignment,
  maskLog,
  LOG_CAP,
  LEASE_MS,
} from './actions/store.ts'
import { encrypt, decrypt } from './actions/secrets.ts'
const event: Event = {
  name: 'push',
  sha: 'a'.repeat(40),
  ref: 'refs/heads/main',
  actor: 'sami/codex',
  title: 'Test actions',
  repository: 'acme/demo',
  paths: ['src/index.ts'],
  key: 'push:1',
}
const yaml = `name: CI\non:\n  push:\n    branches: [main, 'feature/**', '!feature/wip/**']\n    paths: ['src/**', '!src/docs/**']\n  pull_request:\n    branches: [main]\n  workflow_dispatch:\nenv:\n  GREETING: hello\njobs:\n  test:\n    runs-on: [self-hosted, linux, x64]\n    strategy:\n      matrix:\n        node: [20, 22]\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo '\${{ env.GREETING }} \${{ matrix.node }} \${{ secrets.TEST }}'\n      - run: node -e 'console.log(41+1)'\n`
const fixture = () => {
  const db = new DatabaseSync(':memory:')
  const sql = {
    exec: (q: string, ...a: any[]) => {
      if (!a.length && q.includes(';')) {
        db.exec(q)
        return []
      }
      return db.prepare(q).all(...a) as any
    },
  }
  return { db, store: new RunStore(sql) }
}
function runner(store: RunStore, id = 'one', labels: string[] = []) {
  store.register(
    { id, name: id, owner: 'acme', os: 'linux', arch: 'x64', labels },
    `hash-${id}`,
    1000,
  )
  return store.authenticate(`hash-${id}`)!
}
test('Actions YAML: on remains a YAML 1.2 key, matrix expands and steps preserve semantics', () => {
  const w = parseWorkflow('ci.yml', yaml)
  assert.equal(w.error, undefined)
  assert.equal(w.jobs.length, 2)
  assert.equal(w.jobs[1].matrix.node, 22)
  assert.equal(
    w.jobs[0].steps[1].run,
    "echo '${{ env.GREETING }} ${{ matrix.node }} ${{ secrets.TEST }}'",
  )
  const modified = parseWorkflow(
    'ci.yml',
    yaml.replace(
      '      - run: node',
      '      - name: tolerated\n        continue-on-error: true\n        timeout-minutes: 2\n        shell: sh\n        working-directory: src\n        env: { LOCAL: 1 }\n        run: false\n      - run: node',
    ),
  )
  assert.match(modified.error ?? '', /exactly one/)
  const valid = parseWorkflow(
    'ci.yml',
    yaml.replace(
      '      - run: node',
      "      - name: tolerated\n        continue-on-error: true\n        timeout-minutes: 2\n        shell: sh\n        working-directory: src\n        env: { LOCAL: 1 }\n        run: 'false'\n      - run: node",
    ),
  )
  assert.equal(valid.jobs[0].steps[2].timeout, 120000)
  assert.equal(valid.jobs[0].steps[2].continueOnError, true)
})
test('Actions matrix include/exclude preserves base combinations and expands additions', () => {
  assert.deepEqual(
    expandMatrix({
      os: ['linux', 'macos'],
      node: [20, 22],
      exclude: [{ os: 'macos', node: 20 }],
      include: [
        { os: 'linux', extra: true },
        { os: 'linux', node: 24 },
      ],
    }),
    [
      { os: 'linux', node: 20, extra: true },
      { os: 'linux', node: 22, extra: true },
      { os: 'macos', node: 22 },
      { os: 'linux', node: 24 },
    ],
  )
  assert.deepEqual(expandMatrix({ include: [{ node: 20 }, { node: 22 }] }), [
    { node: 20 },
    { node: 22 },
  ])
  assert.throws(
    () => expandMatrix({ a: Array.from({ length: 257 }, (_, i) => i) }),
    /256/,
  )
})
test('Actions filters: branches, tags, ordered negation and paths combine', () => {
  const w = parseWorkflow('ci.yml', yaml)
  assert.equal(matchesTrigger(w, event), true)
  assert.equal(
    matchesTrigger(w, { ...event, ref: 'refs/heads/feature/wip/foo' }),
    false,
  )
  assert.equal(matchesTrigger(w, { ...event, paths: ['README.md'] }), false)
  assert.equal(
    matchesTrigger(w, { ...event, paths: ['src/docs/readme'] }),
    false,
  )
  assert.equal(matchesTrigger(w, { ...event, ref: 'refs/tags/v1' }), false)
  const tags = parseWorkflow(
    'tags.yml',
    yaml.replace(
      "branches: [main, 'feature/**', '!feature/wip/**']",
      "tags: ['v*']",
    ),
  )
  assert.equal(
    matchesTrigger(tags, { ...event, ref: 'refs/tags/v1', paths: [] }),
    true,
  )
  assert.equal(
    matchesTrigger(w, {
      ...event,
      name: 'pull_request',
      baseRef: 'main',
      ref: 'refs/heads/feature',
    }),
    true,
  )
  assert.equal(matchesTrigger(w, { ...event, name: 'workflow_dispatch' }), true)
  assert.throws(
    () => matchesTrigger(w, { ...event, paths: undefined }),
    /paths/,
  )
})
test('Actions expressions use github/env/matrix/secrets and reject executable or unsupported code', () => {
  const ctx = context(
    event,
    { node: 22 },
    { MESSAGE: 'hello' },
    { TOKEN: 'test-only-secret' },
  )
  assert.equal(
    expression(
      "github.ref == 'refs/heads/main' && github.event_name != 'pull_request'",
      ctx,
    ),
    true,
  )
  assert.equal(
    expression("startsWith(github.ref, 'refs/heads/') || false", ctx),
    true,
  )
  assert.equal(
    interpolate(
      '${{ github.actor }} ${{ env.MESSAGE }} ${{ matrix.node }} ${{ secrets.TOKEN }}',
      ctx,
    ),
    'sami/codex hello 22 test-only-secret',
  )
  assert.equal(expression('failure() && !success()', ctx, 'failure'), true)
  assert.throws(() => expression('process.exit()', ctx), /unsupported/)
  assert.throws(() => expression('github.ref + 1', ctx), /unsupported/)
})
test('Actions unsupported workflow features fail visibly, unknown actions stay as failing runner steps', () => {
  assert.match(
    parseWorkflow(
      'ci.yml',
      yaml.replace(
        'runs-on: [self-hosted, linux, x64]',
        'runs-on: linux\n    container: node',
      ),
    ).error ?? '',
    /container/,
  )
  assert.match(
    parseWorkflow(
      'ci.yml',
      yaml.replace(
        'runs-on: [self-hosted, linux, x64]',
        'runs-on: linux\n    needs: test',
      ),
    ).error ?? '',
    /cyclic/,
  )
  const w = parseWorkflow(
    'ci.yml',
    yaml.replace('actions/checkout@v4', 'some/action@v1'),
  )
  assert.equal(w.error, undefined)
  assert.equal(w.jobs[0].steps[0].uses, 'some/action@v1')
})
test('Actions runner labels match all labels with explicit hosted OS aliases', () => {
  assert.equal(
    labelsMatch(['ubuntu-latest', 'arm64'], ['linux', 'arm64']),
    true,
  )
  assert.equal(labelsMatch(['macos-latest', 'gpu'], ['macos', 'x64']), false)
})
test('Actions one queued job can only be assigned once to two runners', () => {
  const { store } = fixture(),
    w = parseWorkflow('ci.yml', yaml.replace('node: [20, 22]', 'node: [22]'))
  const id = store.enqueue(w, event, 1000),
    a = runner(store),
    b = runner(store, 'two')
  const first = store.claim(a, 1001)
  assert.equal(first?.job.run, id)
  assert.equal(store.claim(b, 1001), null)
  assert.equal(store.run(id)?.status, 'running')
  assert.equal(store.claim(a, 1002), null)
})
test('Actions needs waits for every matrix dependency; if-skipped chains terminate', () => {
  const { store } = fixture(),
    w = parseWorkflow(
      'ci.yml',
      yaml +
        `  deploy:\n    needs: test\n    runs-on: linux\n    steps:\n      - run: echo deploy\n`,
    ),
    id = store.enqueue(w, event, 1000),
    a = runner(store)
  const one = store.claim(a, 1001)!,
    spec = resolveAssignment(one.job, one.run, { TEST: 'abc' })
  assert.match(spec.steps[1].run!, /hello 20 abc/)
  store.finish(a.id, one.job.id, one.job.lease!, 'failure', 'bad', 1002)
  const two = store.claim(a, 1003)!
  assert.equal(two.job.spec.id, 'test')
  store.finish(a.id, two.job.id, two.job.lease!, 'failure', 'bad', 1004)
  assert.equal(store.jobs(id)[2].status, 'skipped')
  assert.equal(store.run(id)?.status, 'failure')
  const skip = parseWorkflow(
    'skip.yml',
    yaml.replace(
      '    runs-on:',
      "    if: github.event_name == 'workflow_dispatch'\n    runs-on:",
    ),
  )
  const skipped = store.enqueue(skip, { ...event, key: 'skip' }, 1005)
  assert.equal(store.run(skipped)?.status, 'success')
})
test('Actions logs mask secrets before persistence, idempotent batches, caps, lease authorization', () => {
  const { store } = fixture(),
    w = parseWorkflow('ci.yml', yaml.replace('node: [20, 22]', 'node: [22]'))
  store.enqueue(w, event, 1000)
  const r = runner(store),
    j = store.claim(r, 1001)!.job
  store.append(
    r.id,
    j.id,
    j.lease!,
    0,
    0,
    ['test-only-secret and again test-only-secret'],
    ['test-only-secret'],
  )
  store.append(r.id, j.id, j.lease!, 0, 0, ['duplicate'], [])
  assert.equal(store.logs(j.id, 0).length, 1)
  assert.doesNotMatch(store.logs(j.id, 0)[0].text, /test-only-secret/)
  assert.match(store.logs(j.id, 0)[0].text, /\*\*\*/)
  assert.throws(
    () => store.append('two', j.id, j.lease!, 0, 1, ['x'], []),
    /lease/,
  )
  for (let i = 1; i < 12; i++)
    store.append(
      r.id,
      j.id,
      j.lease!,
      0,
      i,
      Array(128).fill('x'.repeat(2048)),
      [],
    )
  const text = store
    .logs(j.id, 0)
    .map((c) => c.text)
    .join('')
  assert.ok(Buffer.byteLength(text) <= LOG_CAP)
  assert.match(text, /log cap reached/)
  assert.equal(maskLog('tokenABC token', ['token', 'tokenABC']), '*** ***')
})
test('Actions encryption uses repo/name authenticated data and does not roundtrip under a different key', async () => {
  const env = {
      ACTIONS_SECRET_KEY: Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString('base64'),
    },
    cipher = await encrypt(env, 'acme/demo:TOKEN', 'test-only-secret')
  assert.doesNotMatch(cipher, /test-only-secret/)
  assert.equal(
    await decrypt(env, 'acme/demo:TOKEN', cipher),
    'test-only-secret',
  )
  await assert.rejects(() => decrypt(env, 'acme/other:TOKEN', cipher))
})
test('Actions runner loss fails the run; heartbeat prevents expiry; cancellation is observable', () => {
  const { store } = fixture(),
    w = parseWorkflow('ci.yml', yaml.replace('node: [20, 22]', 'node: [22]')),
    id = store.enqueue(w, event, 1000),
    r = runner(store),
    j = store.claim(r, 1001)!.job
  store.heartbeat(r.id, j.id, j.lease!, 1001 + LEASE_MS - 1)
  store.sweep(1001 + LEASE_MS)
  assert.equal(store.run(id)?.status, 'running')
  store.sweep(1001 + LEASE_MS * 2)
  assert.equal(store.run(id)?.status, 'failure')
  assert.match(store.jobs(id)[0].reason!, /heartbeat lost/)
  const second = store.enqueue(w, { ...event, key: 'second' }, Date.now()),
    next = store.claim(r)!.job
  store.cancel(second)
  assert.equal(store.heartbeat(r.id, next.id, next.lease!).cancel, true)
  assert.equal(store.run(second)?.status, 'cancelled')
  store.releaseCancelled(r.id)
  assert.equal(store.runners()[0].job, null)
})
test('Actions step/job success cannot bypass failed or unfinished steps and event delivery deduplicates', () => {
  const { store } = fixture(),
    w = parseWorkflow('ci.yml', yaml.replace('node: [20, 22]', 'node: [22]')),
    id = store.enqueue(w, event, 1000),
    r = runner(store),
    j = store.claim(r, 1001)!.job
  assert.equal(store.enqueue(w, event, 1002), id)
  assert.throws(
    () => store.finish(r.id, j.id, j.lease!, 'success', null),
    /unfinished/,
  )
  assert.throws(
    () => store.step(r.id, j.id, j.lease!, 1, 'running', null),
    /previous/,
  )
  for (let i = 0; i < j.spec.steps.length; i++) {
    store.step(r.id, j.id, j.lease!, i, 'running', null)
    store.step(r.id, j.id, j.lease!, i, 'success', 0)
  }
  store.finish(r.id, j.id, j.lease!, 'success', null)
  assert.equal(store.run(id)?.status, 'success')
  assert.equal(store.unarchived()[0].id, id)
})

test('Actions filters use GitHub quantifiers and character classes, not shell globs', () => {
  const w = parseWorkflow(
    'ci.yml',
    yaml.replace(
      "branches: [main, 'feature/**', '!feature/wip/**']",
      "tags: ['v[12].[0-9]+.[0-9]+']",
    ),
  )
  assert.equal(matchesTrigger(w, { ...event, ref: 'refs/tags/v1.10.12' }), true)
  assert.equal(matchesTrigger(w, { ...event, ref: 'refs/tags/v3.1.2' }), false)
  const js = parseWorkflow(
    'ci.yml',
    yaml.replace("paths: ['src/**', '!src/docs/**']", "paths: ['*.jsx?']"),
  )
  assert.equal(matchesTrigger(js, { ...event, paths: ['index.js'] }), true)
  assert.equal(matchesTrigger(js, { ...event, paths: ['index.jsx'] }), true)
  assert.equal(matchesTrigger(js, { ...event, paths: ['index.jsq'] }), false)
})
test('Actions changed paths do not truncate at presentation limits and skip equal subtrees', async () => {
  const { changedPaths } = await import('./actions/source.ts'),
    entries = Array.from({ length: 2500 }, (_, i) => ({
      name: `file${String(i).padStart(4, '0')}`,
      type: 'blob' as const,
      mode: '100644',
      child: String(i),
    })),
    read: string[] = []
  const source = {
    commit: async () => ({ tree: 'root' }) as never,
    tree: async (h: string) => {
      read.push(h)
      return entries
    },
    blob: async () => new Uint8Array(),
  }
  const paths = await changedPaths(null, null, source, event.sha)
  assert.equal(paths.length, 2500)
  assert.equal(paths[2499], 'file2499')
  assert.deepEqual(await changedPaths(source, event.sha, source, event.sha), [])
  assert.equal(read.length, 1)
})
test('Actions skipped dependencies cannot be bypassed by early or post-finish result reports', () => {
  const { store } = fixture(),
    w = parseWorkflow('ci.yml', yaml.replace('node: [20, 22]', 'node: [22]'))
  store.enqueue(w, event, 1000)
  const r = runner(store),
    j = store.claim(r, 1001)!.job
  store.step(r.id, j.id, j.lease!, 0, 'running', null)
  store.step(r.id, j.id, j.lease!, 0, 'failure', 1)
  assert.throws(
    () => store.step(r.id, j.id, j.lease!, 0, 'success', 0),
    /already/,
  )
  assert.throws(
    () => store.finish(r.id, j.id, j.lease!, 'success', null),
    /unfinished|failed/,
  )
})

test('Actions PR path filters compare the merge base, not unrelated base-branch changes', async () => {
  const { mergeBase } = await import('./actions/source.ts'),
    parents: Record<string, string[]> = {
      head: ['fork'],
      base: ['other'],
      other: ['fork'],
      fork: ['root'],
      root: [],
    },
    reads: string[] = []
  assert.equal(
    await mergeBase('head', 'base', async (h) => {
      reads.push(h)
      return { parents: parents[h] }
    }),
    'fork',
  )
  assert.ok(reads.includes('head'))
  assert.ok(reads.includes('base'))
  assert.equal(
    await mergeBase('head', 'head', async () => {
      throw new Error('same commit needs no fetch')
    }),
    'head',
  )
})

test('Actions log cap remains exact when only one byte is left', () => {
  const { store } = fixture(),
    w = parseWorkflow('ci.yml', yaml.replace('node: [20, 22]', 'node: [22]'))
  store.enqueue(w, event, 1000)
  const r = runner(store),
    j = store.claim(r, 1001)!.job
  for (let i = 0; i < 63; i++)
    store.append(r.id, j.id, j.lease!, 0, i, ['x'.repeat(32767)], [])
  store.append(r.id, j.id, j.lease!, 0, 63, ['x'.repeat(32766)], [])
  store.append(r.id, j.id, j.lease!, 0, 64, ['ab'], [])
  assert.equal(
    Buffer.byteLength(
      store
        .allLogs(j.id, 0)
        .map((c) => c.text)
        .join(''),
    ),
    LOG_CAP,
  )
})

test('a multi-line secret split across two log batches is masked in both', async () => {
  const { maskLog } = await import('./actions/store.ts')
  const key = '-----BEGIN KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nk1LXd9Qe8pTq0wX2rYc7VbN3mZ4sH6uJ\n-----END KEY-----'
  const [first, second] = [key.split('\n').slice(0, 2).join('\n'), key.split('\n').slice(2).join('\n')]
  assert.ok(!maskLog(first, [key]).includes('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'))
  assert.ok(!maskLog(second, [key]).includes('k1LXd9Qe8pTq0wX2rYc7VbN3mZ4sH6uJ'))
  assert.equal(maskLog('a } b', [key]), 'a } b')
})

test('Actions failed job log URL returns masked text across every retained page', async () => {
  const { actionsAPI } = await import('./actions/handler.ts')
  const { store, db } = fixture(),
    w = parseWorkflow('ci.yml', yaml.replace('node: [20, 22]', 'node: [22]'))
  const run = store.enqueue(w, event, 1000),
    r = runner(store),
    j = store.claim(r, 1001)!.job
  for (let batch = 0; batch < 130; batch++)
    store.append(
      r.id,
      j.id,
      j.lease!,
      0,
      batch,
      [`failure ${batch} secret-fixture`],
      ['secret-fixture'],
    )
  store.step(r.id, j.id, j.lease!, 0, 'failure', 1, 1002)
  store.finish(r.id, j.id, j.lease!, 'failure', 'step failed', 1003)
  const deps = {
    runQueue: async () => ({
      detail: async (id: number) => store.detail(id),
      logs: async (job: number, step: number, after: number) =>
        store.logs(job, step, after),
    }),
  } as unknown as import('./actions/api-types.ts').ActionDependencies
  const call = (path: string, query = '') =>
    actionsAPI(
      new Request('https://forge.test/' + path + query),
      { owner: 'acme', repo: 'demo', path: path.split('/') },
      deps,
    )
  try {
    const response = await call(`runs/${run}/jobs/${j.id}/logs`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.ok(
      Array.isArray(body.logs),
      'job log route must return log text, not run metadata',
    )
    assert.equal(body.logs.length, 130)
    assert.deepEqual(body.logs.at(-1), {
      job: j.id,
      step: 0,
      seq: 129,
      text: 'failure 129 ***\n',
    })
    assert.doesNotMatch(JSON.stringify(body), /secret-fixture/)
    const step = await call(`runs/${run}/logs`, `?job=${j.id}&step=0&after=128`)
    assert.deepEqual((await step.json()).chunks, [
      { seq: 129, text: 'failure 129 ***\n' },
    ])
    assert.equal((await call(`runs/${run}/jobs/99999/logs`)).status, 404)
    assert.equal(
      (await call(`runs/${run}/jobs/${j.id}/logs/extra`)).status,
      404,
    )
    assert.equal((await call(`runs/${run}/unknown`)).status, 404)
    assert.equal(
      (await call(`runs/${run}/logs`, `?job=${j.id}&step=999`)).status,
      404,
    )
  } finally {
    db.close()
  }
})
