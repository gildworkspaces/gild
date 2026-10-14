import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'
const base = resolve('.tmp')
mkdirSync(base, { recursive: true })
process.env.TMPDIR = base
const label = process.argv[2] ?? 'after',
  file = join(base, `listing-${label}.mjs`)
await build({
  entryPoints: ['scripts/repo-list-test-worker.ts'],
  outfile: file,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  external: ['cloudflare:workers', 'node:*'],
  define: { 'process.env.NODE_ENV': '"production"' },
  jsx: 'automatic',
  conditions: ['workerd', 'browser'],
  plugins: [
    {
      name: 'css',
      setup(b) {
        b.onLoad({ filter: /\.module\.css$/ }, () => ({
          contents: 'export default {}',
          loader: 'js',
        }))
      },
    },
    ...(label === 'before'
      ? [
          {
            name: 'baseline',
            setup(b) {
              b.onLoad(
                { filter: /lib\/(repo-list|public-activity)\.ts$/ },
                (args) => ({
                  contents: execFileSync(
                    'git',
                    [
                      'show',
                      (process.argv[3] ?? '9d08414') +
                        ':' +
                        args.path.slice(resolve('.').length + 1),
                    ],
                    { encoding: 'utf8' },
                  ),
                  loader: 'ts',
                  resolveDir: resolve('lib'),
                }),
              )
            },
          },
        ]
      : []),
  ],
})
const state = mkdtempSync(join(base, 'listing-state-'))
const options = () =>
  convertV4MiniflareOptions({
    inspectorPort: 0,
    resourceTmpPath: base,
    resourcePersistencePath: state,
    modules: true,
    scriptPath: file,
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    durableObjects: {
      REPO_INDEX: { className: 'ListingFixture', useSQLite: true },
    },
  })
let mf = new Miniflare(options())
const get = async (path) => {
  const response = await mf.dispatchFetch('http://fixture' + path)
  assert.equal(response.status, 200, await response.clone().text())
  return response.json()
}
try {
  const db = await mf.getD1Database('DB')
  await db.exec(
    readdirSync('migrations')
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => readFileSync('migrations/' + f, 'utf8'))
      .join('\n')
      .replace(/--[^\n]*/g, '')
      .replace(/\s+/g, ' '),
  )
  await get('/seed')
  const first = await get('/owner')
  assert.equal(first.result.length, 15)
  assert.equal(
    (first.html.match(/<article/g) ?? []).length,
    15,
    'SSR renders all 15 cards',
  )
  const warm = []
  for (let i = 0; i < 10; i++) warm.push(await get('/owner'))
  const landingFirst = await get('/landing'),
    landingWarm = []
  for (let i = 0; i < 10; i++) landingWarm.push(await get('/landing'))
  await mf.dispose()
  mf = new Miniflare(options())
  const newIsolate = await get('/landing')
  await get('/seed?version=2&publish=1')
  const push = await get('/owner?version=2')
  assert.ok(
    push.result.every((r) => r.updated > first.result[0].updated),
    'new published tip is visible after push',
  )
  const summarize = (rows) => ({
    medianMs: rows.map((r) => r.serverMs).sort((a, b) => a - b)[5],
    maxMs: Math.max(...rows.map((r) => r.serverMs)),
    doCalls: rows[0].doCalls,
    d1Calls: rows[0].d1Calls,
  })
  const evidence = {
    label,
    firstOwner: first.serverMs,
    owner: summarize(warm),
    firstLanding: landingFirst.serverMs,
    landing: summarize(landingWarm),
    landingNewIsolate: { ms: newIsolate.serverMs, scans: newIsolate.scans },
    firstAfterPush: push.serverMs,
  }
  console.info('Repository-list timings', JSON.stringify(evidence))
  if (label !== 'before') {
    for (const r of [...warm, ...landingWarm, newIsolate, push]) {
      assert.equal(r.doCalls, 0, 'warm pages must not call a repository DO')
      assert.ok(r.d1Calls <= 5, `page D1 budget exceeded: ${r.d1Calls}`)
    }
    assert.equal(
      newIsolate.scans,
      0,
      'new isolate shares the minute-bucket scan',
    )
    // Wall-clock values are evidence; origin-call budgets above are the CI gate.
    await get('/star')
    assert.equal(
      (await get('/owner')).result.find((r) => r.name === 'repo0')
        .stargazers_count,
      1,
    )
    assert.equal(
      (await get('/old-projection')).issues,
      1,
      'older projection cannot overwrite newer state',
    )
    // Same code tip, new metadata tip. Private changes must reach warm pages
    // and the shared landing candidates immediately after publication.
    await get('/acl')
    assert.equal(
      (await get('/owner')).result.length,
      14,
      'committed ACL hides a card before its metadata refresh finishes',
    )
    assert.ok(
      (await get('/landing')).result.repos.every((r) => r.name !== 'repo0'),
    )
    await get('/seed?version=2&publish=1&private=repo0')
    for (const path of ['/owner', '/owner?viewer=outsider']) {
      const rows = (await get(path)).result
      assert.equal(rows.length, 14)
      assert.ok(rows.every((r) => r.name !== 'repo0'))
    }
    assert.equal((await get('/owner?viewer=acme')).result.length, 15)
    assert.equal((await get('/owner?viewer=reader')).result.length, 15)
    const hiddenLanding = (await get('/landing')).result
    assert.ok(hiddenLanding.repos.every((r) => r.name !== 'repo0'))
    assert.deepEqual(
      await get('/purge'),
      {},
      'purge also removes the D1 projection',
    )
    await get('/seed?version=3&publish=1')
    assert.equal(
      (await get('/owner')).result.length,
      15,
      'recreated index can publish revision 1 again',
    )
  }
  writeFileSync(
    join(base, `listing-${label}-timings.json`),
    JSON.stringify(evidence, null, 2),
  )
  console.log(evidence)
} finally {
  await mf.dispose()
}
