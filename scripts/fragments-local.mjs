import { deflateSync } from 'node:zlib'
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
import { createHmac, createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { cssModules, presentationCSS, publishAssets, buildTabClient } from './render-build.mjs'
const baselineReads = process.argv.includes('--baseline-reads')
const baselinePlugin = {
  name: 'phase-one-read-baseline',
  setup(b) {
    if (!baselineReads) return
    b.onLoad({ filter: /(?:lib\/fragments\/(?:http|production)\.ts|packages\/render\/(?:highlight\.ts|Shell\.tsx)|gild-render\.tsx)$/ }, args => {
      const relative = args.path.slice(resolve('.').length + 1)
      const result = spawnSync('git', ['show', '2ae97cf15df302e7a86b540380353b97014a5ae5:' + relative], { encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr)
      return { contents: result.stdout, loader: args.path.endsWith('tsx') ? 'tsx' : 'ts' }
    })
    b.onResolve({ filter: /^gild:presentation-css$/ }, () => ({ path: 'baseline-css', namespace: 'baseline' }))
    b.onLoad({ filter: /.*/, namespace: 'baseline' }, () => ({ contents: 'export default ' + JSON.stringify(presentationCSS()), loader: 'js' }))
  },
}
const root = resolve('.tmp'),
  dir = mkdtempSync(join(root, 'fragments-'))
process.env.TMPDIR = root
const fixture = join(dir, 'site.mjs'),
  renderer = join(dir, 'render.mjs')
await build({
  entryPoints: ['scripts/fragments-test-worker.ts'],
  outfile: fixture,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  conditions: ['workerd', 'browser'],
  external: ['cloudflare:workers', 'node:*'],
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    baselinePlugin,
    {
      name: 'revert-public-fast-path',
      setup(b) {
        if (process.argv.includes('--reverted-page-browser-header'))
          b.onLoad({filter:/lib\/fragments\/http\.ts$/},args=>({contents:readFileSync(args.path,'utf8').replace("headers: { ...Object.fromEntries(cached.headers), 'cache-control': PUBLIC_CACHE },",'headers: cached.headers,'),loader:'ts'}))
        if (process.argv.includes('--reverted-cache-encoding'))
          b.onLoad({filter:/lib\/fragments\/http\.ts$/},args=>({contents:readFileSync(args.path,'utf8').replace(/      const source = hit.clone\(\)[\s\S]*?      cached.headers.delete\('server-timing'\)/, "      const cached = hit.clone()\n      cached.headers.delete('server-timing')"),loader:'ts'}))
        if (process.argv.includes('--reverted-islands'))
          b.onLoad({filter:/lib\/fragments\/islands\.ts$/},args=>({contents:readFileSync(args.path,'utf8').replace('publicLeases(request, ctx, defaultEdge(), now)', 'publicLeases(request, undefined, defaultEdge(), now)'),loader:'ts'}))
        if (process.argv.includes('--reverted-lease'))
          b.onLoad({filter:/lib\/fragments\/production\.ts$/},args=>({contents:readFileSync(args.path,'utf8').replace('publicLeases(request, ctx, defaultEdge(), now)', 'publicLeases(request, undefined, defaultEdge(), now)'),loader:'ts'}))
        if (process.argv.includes('--reverted-commit-cache'))
          b.onLoad({filter:/lib\/fragments\/production\.ts$/},args=>({contents:readFileSync(args.path,'utf8').replace('const cached = await edge?.match(artifact)','const cached = undefined'),loader:'ts'}))
        if (process.argv.includes('--reverted-ready-refs'))
          b.onLoad({filter:/lib\/repo-index-do\.ts$/},args=>({contents:readFileSync(args.path,'utf8').replace('    await publishHeads(this.env.DB, state.id, heads, Date.now(), resolvedRefs.map(r => r.name))','    if (heads.length === resolvedRefs.length) await publishHeads(this.env.DB, state.id, heads, Date.now(), resolvedRefs.map(r => r.name))'),loader:'ts'}))
        if (process.argv.includes('--reverted-backfill'))
          b.onLoad({filter:/lib\/fragments\/version\.ts$/},args=>({contents:readFileSync(args.path,'utf8').replace(/SELECT a.id FROM repo_access[^"\n]+LIMIT 20/,"SELECT DISTINCT id FROM fragment_heads WHERE json_extract(pointer,'$.version')<>? LIMIT 20"),loader:'ts'}))
        if (process.argv.includes('--reverted-foreground-render'))
          b.onLoad({ filter: /lib\/fragments\/http\.ts$/ }, args => ({
            contents: readFileSync(args.path, 'utf8').replace('  await env.RENDER_QUEUE.send({', "  await env.GILD_RENDER.fetch('https://gild-render/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entity: address.entity, item }) });\n  await env.RENDER_QUEUE.send({"), loader: 'ts',
          }))
        if (process.argv.includes('--reverted-push'))
          b.onLoad({ filter: /lib\/repo-index-do\.ts$/ }, args => ({
            contents: readFileSync(args.path, 'utf8').replace("    if (this.index.setting('repo-list:acl'))", "    const pending = JSON.parse(this.index.setting('fragments:pending-refs') ?? '{}'); if (pending[current] && pending[current] !== this.index.resolve(current)) throw new ApiError(503, 'New tip is indexing'); if (this.index.setting('repo-list:acl'))"), loader: 'ts',
          }))
        if (process.argv.includes('--reverted-fast-path'))
          b.onLoad({ filter: /lib\/fragments\/http\.ts$/ }, (args) => ({
            contents: readFileSync(args.path, 'utf8').replace(
              'if (route.invalid)',
              "if (!route.privateRepo) await reads.access(request,'acme','demo'); if (route.invalid)",
            ),
            loader: 'ts',
          }))
      },
    },
    {
      name: 'wasm',
      setup(b) {
        b.onResolve({ filter: /\.wasm$/ }, () => ({
          path: './core.wasm',
          external: true,
        }))
      },
    },
  ],
})
await build({
  entryPoints: ['gild-render.tsx'],
  outfile: renderer,
  bundle: true,
  format: 'esm',
  jsx: 'automatic',
  platform: 'browser',
  conditions: ['workerd', 'browser'],
  external: ['cloudflare:workers', 'node:*'],
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [baselinePlugin, cssModules()],
})
const options = {
  inspectorPort: 0,
  resourceTmpPath: root,
  resourcePersistencePath: join(dir, 'state'),
  workers: [
    {
      name: 'site',
      modulesRoot: dir,
      modules: [
        {
          type: 'ESModule',
          path: fixture,
          contents: readFileSync(fixture, 'utf8'),
        },
        {
          type: 'CompiledWasm',
          path: join(dir, 'core.wasm'),
          contents: readFileSync('cqx/core.wasm'),
        },
      ],
      compatibilityDate: '2026-10-01',
      compatibilityFlags: ['nodejs_compat'],
      bindings: {
        SESSION_SECRET: 'fragment-fixture-cookie-secret-32-characters',
        LUA_SOURCE: readFileSync('scripts/fixtures/lvm.c', 'utf8'),
      },
      durableObjects: {
        REPO_INDEX: { className: 'FragmentIndex', useSQLite: true },
        API_CONTROL: {className:'ApiControl',useSQLite:true},
      },
      d1Databases: { DB: 'fragments-db' },
      r2Buckets: { FRAGMENTS: 'fragments-bucket' },
      queueProducers: { RENDER_QUEUE: 'gild-render' },
      serviceBindings: {
        GILD_RENDER: 'renderer',
      },
    },
    {
      name: 'renderer',
      modules: true,
      scriptPath: renderer,
      compatibilityDate: '2026-10-01',
      compatibilityFlags: ['nodejs_compat'],
      r2Buckets: { FRAGMENTS: 'fragments-bucket' },
      durableObjects: {
        REPO_INDEX: { className: 'FragmentIndex', scriptName: 'site' },
      },
      queueProducers: { RENDER_QUEUE: 'gild-render' },
      queueConsumers: {
        'gild-render': { maxBatchSize: 1, maxBatchTimeout: 0.1 },
      },
    },
  ],
}
const mf = new Miniflare(convertV4MiniflareOptions(options))
const evidence = []
let server
export const fixtureState = { mf }
try {
  const db = await mf.getD1Database('DB', 'site')
  await db.exec(
    readdirSync('migrations')
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => readFileSync('migrations/' + f, 'utf8'))
      .join('\n')
      .replace(/--[^\n]*/g, '')
      .replace(/\s+/g, ' '),
  )
  const get = async (path) =>
    mf.dispatchFetch('http://localhost' + path, {
      headers: { 'accept-encoding': 'identity', 'cf-connecting-ip':'192.0.2.123' },
    })
  const prepared = async path => {
    const deadline = Date.now() + 30000
    for (;;) {
      const response = await get(path)
      if (response.status !== 202 && response.status !== 503 && response.headers.get('x-gild-state') !== 'pending') return response
      await response.arrayBuffer()
      assert.ok(Date.now() < deadline, 'background preparation completes: ' + path)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  if (!baselineReads && !process.argv.some(arg => ['--reverted-foreground-render','--reverted-push','--reverted-fast-path'].includes(arg))) {
  const coldView = await (await get('/__page-view-probe')).json()
  assert.equal(coldView.pending, true, 'a cold diff read only schedules preparation')
  assert.equal(coldView.cold, null, 'request must not compute the diff')
  const warmView = await (await get('/__page-view-probe?build')).json()
  assert.equal(warmView.warm.to, '1'.repeat(40))
  assert.ok(warmView.warm.files.some(file => file.path === 'src/file0.ts' && file.additions > 0), 'background producer computes the real diff')
  // Review regressions use actual DO publication and the production catalog.
  const failed = await (await get('/__review-refs')).json()
  assert.equal(failed.complete,false)
  assert.ok(typeof failed.alarm === 'number' && failed.alarm > 0,'unfinished refs schedule bounded retries')
  let published = (await db.prepare('SELECT ref,pointer FROM fragment_heads WHERE id=?').bind('acme/demo').all()).results
  assert.equal(JSON.parse(published.find(r=>r.ref==='main').pointer).tip,'2'.repeat(40),'ready main must advance despite one 503 and one absent manifest')
  assert.equal(JSON.parse(published.find(r=>r.ref==='flaky').pointer).tip,'1'.repeat(40),'failed ref retains its last valid tip')
  const wake = await (await get('/__hydration-wake')).json()
  assert.equal(wake.complete, false, 'fixture render is still incomplete')
  assert.ok(wake.alarm !== null && wake.alarm <= wake.soon, 'render backoff must not push back a sooner hydration wake: ' + JSON.stringify(wake))
  await get('/__review-refs?mode=retry')
  for (const end=Date.now()+10_000;Date.now()<end;) {
    published = (await db.prepare('SELECT ref,pointer FROM fragment_heads WHERE id=?').bind('acme/demo').all()).results
    if(JSON.parse(published.find(r=>r.ref==='flaky').pointer).tip==='2'.repeat(40))break
    await new Promise(r=>setTimeout(r,50))
  }
  assert.equal(JSON.parse(published.find(r=>r.ref==='flaky').pointer).tip,'2'.repeat(40),'failed ref advances on retry')
  assert.equal(published.some(r=>r.ref==='missing'),false)
  // Simulate an already-indexed repository across the migration: no heads,
  // no push and unchanged renderer version. Its minute cron populates heads.
  await get('/__pause-render-alarm')
  await get('/__legacy')
  assert.equal(await db.prepare('SELECT 1 FROM fragment_heads WHERE id=?').bind('legacy/repo').first(),null)
  await get('/__sync')
  assert.ok(await db.prepare('SELECT 1 FROM fragment_heads WHERE id=?').bind('legacy/repo').first(),'legacy repository gets heads without a push')
  const backfilled = await prepared('/legacy/repo?path=lvm.c')
  assert.equal(backfilled.status,200)
  assert.equal(JSON.parse(backfilled.headers.get('x-fixture-calls')).do,0,'backfilled page uses D1 fast path')
  const statusShell = await (await get('/__status-shell')).text()
  assert.ok(statusShell.includes('data-portal-template'), 'Pending reads the real renderer metadata endpoint and its stored account shell')
  console.log('PASS review: independent heads, retry alarm, legacy cron backfill to fast path')
  const packet = (values) => {
    const entries = values.map(([type,value,base=Buffer.alloc(0)])=>{
      let size=value.length;const header=[(type<<4)|(size&15)];size=Math.floor(size/16)
      if(size)header[0]|=128
      while(size){const b=size&127;size=Math.floor(size/128);header.push(b|(size?128:0))}
      return Buffer.concat([Buffer.from(header),base,deflateSync(value)])
    })
    const head=Buffer.from('5041434b0000000200000000','hex');head.writeUInt32BE(values.length,8)
    const pack=Buffer.concat([head,...entries])
    return Buffer.concat([Buffer.from('0000'),pack,createHash('sha1').update(pack).digest()])
  }
  const variable = value => {const out=[];do{const n=value&127;value=Math.floor(value/128);out.push(n|(value?128:0))}while(value);return Buffer.from(out)}
  const push = body => mf.dispatchFetch('http://localhost/__pack',{method:'POST',body})
  const normal = Buffer.from('hello'), normalHash=createHash('sha1').update('blob 5\0').update(normal).digest()
  const delta = Buffer.concat([variable(5),variable(6),Buffer.from([0x90,5,1,33])])
  const packed=packet([[3,normal],[3,normal],[7,delta,normalHash]])
  const accepted=await push(packed)
  assert.equal(accepted.status,200,await accepted.clone().text())
  const result=await accepted.json()
  assert.equal(result.bytes,packed.length)
  assert.deepEqual(result.objects.map(o=>o.size),[5,6],'normal duplicates counted once; delta reconstructed canonically')
  const oversize=await push(packet([[3,Buffer.alloc(100*1024*1024+1)]]))
  assert.equal(oversize.status,413,await oversize.clone().text())
  const deltaCap=await push(packet([[7,Buffer.concat([variable(1),variable(100*1024*1024+1),Buffer.from([1,65])]),Buffer.alloc(20)]]))
  assert.equal(deltaCap.status,413,await deltaCap.clone().text())
  const legalLarge=await push(packet([[3,Buffer.alloc(5*1024*1024,65)]]))
  assert.equal(legalLarge.status,200,await legalLarge.clone().text())
  assert.equal((await legalLarge.json()).objects[0].size,5*1024*1024,'old 4 MiB cap is gone')
  assert.equal((await (await mf.getR2Bucket('FRAGMENTS','site')).list({prefix:'push-staging/'})).objects.length,0,'temporary pack and delta objects are removed')
  console.log('PASS review: streamed real packs, duplicates, canonical delta, raised file cap, cleanup')
  if (process.argv.includes('--review-only')) throw Object.assign(new Error('Review complete'), {reviewComplete:true})
  }
  const firstPointer = await (await get('/__seed')).json()
  const luaPointer = await (await get('/__lua')).json()
  for (const state of ['cold', 'warm']) {
    const at = performance.now()
    const response = await prepared('/avatest/lua?ref=main&path=lvm.c')
    const ttfbMs = performance.now() - at, html = await response.text()
    assert.equal(response.status, 200, html)
    assert.match(html, /luaV_execute/)
    evidence.push({ path: '/avatest/lua?ref=main&path=lvm.c', state, ttfbMs,
      htmlBytes: Buffer.byteLength(html), calls: JSON.parse(response.headers.get('x-fixture-calls')) })
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (baselineReads) {
    writeFileSync('.tmp/fast-reads-2/baseline-lua.json', JSON.stringify(evidence, null, 2))
    console.log('Phase-one baseline, same local Lua URL', evidence)
    throw new Error('BASELINE_DONE')
  }
  const waitStored = async (pointer) => {
    const bucket = await mf.getR2Bucket('FRAGMENTS', 'site'),
      key = `f/v4/bundle/${pointer.manifest.hash}`,
      prefix = pointer.scope ? `private/${pointer.scope}/` : '',
      deadline = Date.now() + 30000
    while (!(await bucket.head(prefix + key))) {
      if (Date.now() > deadline)
        throw new Error('Queue did not render the tip bundle')
      await new Promise((r) => setTimeout(r, 100))
    }
    return bucket
  }
  const bucket = await waitStored(firstPointer)
  if (process.argv.includes('--static-only') || process.argv.includes('--reverted-lease') || process.argv.includes('--reverted-islands') || process.argv.includes('--reverted-commit-cache')) {
    const at = (path, time = 0) => mf.dispatchFetch('http://localhost' + path, {
      headers: { 'accept-encoding': 'gzip', 'x-fixture-now': String(time) },
    })
    const budgets = []
    for (const path of ['/acme/demo?lease&path=src/file0.ts', '/acme/demo/score?lease', '/acme/demo/commit/' + firstPointer.tip + '?lease',
      '/api/fragments/acme/demo?lease', '/api/repos/acme/demo/islands?lease', '/f/v4/manifest/' + firstPointer.manifest.hash + '?lease&edge']) {
      const cold = await at(path); assert.equal(cold.status, 200, await cold.clone().text()); await cold.text()
      const warm = await at(path)
      assert.equal(warm.status, 200)
      const calls = JSON.parse(warm.headers.get('x-fixture-calls'))
      assert.deepEqual(calls, { do: 0, d1: 0, r2: 0, render: 0 }, 'warm public read must make zero origin calls: ' + path)
      budgets.push({ path, calls })
      await warm.text()
    }
    const commitPath='/acme/demo/commit/'+firstPointer.tip+'?lease'
    const renewed=await at(commitPath,1000)
    assert.equal(renewed.status,200,await renewed.clone().text())
    assert.deepEqual(JSON.parse(renewed.headers.get('x-fixture-calls')),{do:0,d1:1,r2:0,render:0},'renewing commit authorization must reuse the immutable pointer without a DO call')
    // Remote PoP writes cannot evict this PoP. Inject the lease clock so the
    // security bound is deterministic rather than a sleep/latency CI gate.
    const db = await mf.getD1Database('DB')
    const access = await db.prepare('SELECT * FROM repo_access WHERE id=?').bind('acme/demo').first()
    await db.prepare('UPDATE repo_access SET pending=1 WHERE id=?').bind('acme/demo').run()
    const artifact = '/f/v4/manifest/' + firstPointer.manifest.hash + '?lease&edge'
    assert.equal((await at(artifact, 999)).status, 200, 'grant lasts at most one second')
    assert.equal((await at(artifact, 1000)).status, 404, 'revocation expires exactly at the bound')
    await db.prepare('UPDATE repo_access SET pending=?,acl=? WHERE id=?').bind(access.pending,access.acl,'acme/demo').run()
    await get('/__seed?version=2')
    const pushed = await at('/api/fragments/acme/demo?lease')
    assert.equal((await pushed.json()).tip, '2'.repeat(40), 'local push invalidates the old generation immediately')
    mkdirSync('.tmp/static-review', { recursive: true })
    writeFileSync('.tmp/static-review/budgets.json', JSON.stringify(budgets, null, 2))
    console.log('PASS static budgets: zero DO/D1/R2/render on warm Code, Score, pointers and fragments; 1000ms remote revocation; immediate local push')
    const done = new Error('STATIC_DONE'); done.reviewComplete = true; throw done
  }
  if (process.argv.includes('--performance-only')) {
    const lua = await (await get('/__lua')).json()
    await waitStored(lua)
    server = createServer(async (req, res) => {
      const response = await mf.dispatchFetch(`http://localhost${req.url}`, { method: req.method, headers: req.headers })
      const headers = Object.fromEntries(response.headers); delete headers['content-length']
      res.writeHead(response.status, headers); res.end(Buffer.from(await response.arrayBuffer()))
    })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    const { staticPerformance } = await import('./static-performance.mjs')
    await staticPerformance(`http://127.0.0.1:${server.address().port}`, ['/avatest/lua?ref=main&path=lvm.c&lease', '/acme/demo?lease'], process.argv.includes('--before') ? 'before' : 'after')
    const done = new Error('PERFORMANCE_DONE'); done.reviewComplete = true; throw done
  }
  const testHit = async (path) => {
    const start = performance.now(),
      response = await get(path),
      text = await response.text(),
      calls = JSON.parse(response.headers.get('x-fixture-calls'))
    assert.equal(response.status, 200, text)
    assert.deepEqual(
      calls,
      { do: 0, d1: 1, r2: 1, render: 0 },
      'public fragment must check current D1 access before one R2 read; no DO/render',
    )
    assert.match(response.headers.get('cache-control'), /public.*must-revalidate/)
    assert.match(response.headers.get('server-timing'), /render;dur=0/)
    evidence.push({
      path,
      ms: performance.now() - start,
      serverMs: Number(response.headers.get('x-fixture-ms')),
      calls,
      timing: response.headers.get('server-timing'),
    })
    return text
  }
  const manifest = JSON.parse(
    await testHit('/f/v4/manifest/' + firstPointer.manifest.hash),
  )
  assert.equal(manifest.files.length, 22)
  const file = manifest.files.find((f) => f.path === 'src/file0.ts')
  assert.match(await testHit('/f/v4/blob/' + file.fragment.hash), /value0/)
  const folder = manifest.trees.find((t) => t.path === 'src')
  assert.match(await testHit('/f/v4/tree/' + folder.hash), /file19/)
  assert.match(
    await testHit('/f/v4/home/' + firstPointer.home.hash),
    /Fixture commit 1/,
  )
  assert.match(
    await testHit('/f/v4/commit/' + firstPointer.tip),
    /Fixture commit 1/,
  )
  const scorePointer = await (
    await get('/api/fragments/acme/demo?page=score')
  ).json()
  assert.match(
    await testHit('/f/v4/score/' + scorePointer.selected.hash),
    /Code Score of/,
  )
  assert.match(
    await testHit('/f/v4/glance/root.' + firstPointer.tip),
    /lines changed/,
  )
  const edgeURL = 'http://localhost/f/v4/tree/' + folder.hash + '?edge',
    coldEdge = await mf.dispatchFetch(edgeURL, {
      headers: { 'accept-encoding': 'gzip' },
    })
  assert.equal(coldEdge.status, 200)
  assert.equal(JSON.parse(coldEdge.headers.get('x-fixture-calls')).r2, 1)
  await new Promise((r) => setTimeout(r, 100))
  const warmEdge = await mf.dispatchFetch(edgeURL, {
    headers: { 'accept-encoding': 'gzip' },
  })
  assert.deepEqual(JSON.parse(warmEdge.headers.get('x-fixture-calls')), {
    do: 0,
    d1: 1,
    r2: 0,
    render: 0,
  })
  assert.match(warmEdge.headers.get('server-timing'), /Cloudflare edge hit/)
  assert.match(await warmEdge.text(), /file19/, 'cached fragment must decode to original HTML bytes')
  assert.equal(warmEdge.headers.get('x-fixture-worker-invocations'), '1',
    'Cache API hit still invokes the Worker for the current visibility check')
  evidence.push({
    path: '/f/v4/tree/' + folder.hash + ' (warm edge)',
    serverMs: Number(warmEdge.headers.get('x-fixture-ms')),
    calls: JSON.parse(warmEdge.headers.get('x-fixture-calls')),
    timing: warmEdge.headers.get('server-timing'),
  })
  const conditional = await mf.dispatchFetch(edgeURL, {
    headers: {
      'accept-encoding': 'gzip',
      'if-none-match': warmEdge.headers.get('etag'),
    },
  })
  assert.equal(conditional.status, 304)
  assert.deepEqual(JSON.parse(conditional.headers.get('x-fixture-calls')), {
    do: 0,
    d1: 1,
    r2: 0,
    render: 0,
  })
  const missingKey = `f/v4/blob/${file.fragment.hash}`
  await bucket.delete(missingKey)
  const missed = await get(
    `/f/v4/blob/${file.fragment.hash}?repo=acme/demo&sha=${firstPointer.tip}&path=src/file0.ts`,
  )
  assert.equal(missed.status, 202, 'missing artifact returns preparation immediately')
  assert.equal(JSON.parse(missed.headers.get('x-fixture-calls')).render, 0, 'cold request must never invoke the renderer')
  assert.equal(missed.headers.get('retry-after'), '3')
  const waitArtifact = async key => {
    const currentBucket = await mf.getR2Bucket('FRAGMENTS', 'site')
    const deadline = Date.now() + 10000
    while (!await currentBucket.head(key)) {
      assert.ok(Date.now() < deadline, 'queued preparation stores the requested artifact')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  await waitArtifact(missingKey)
  await testHit('/f/v4/blob/' + file.fragment.hash)
  const page = await get('/acme/demo?path=src%2Ffile0.ts')
  assert.equal(page.status, 200, await page.clone().text())
  assert.match(await page.text(), /value0/)
  assert.equal(
    JSON.parse(page.headers.get('x-fixture-calls')).render,
    0,
    'first page stitches stored fragments',
  )
  // Keep wall-clock evidence below; call counts gate the critical path.
  evidence.push({
    path: '/acme/demo?path=src/file0.ts',
    timing: page.headers.get('server-timing'),
    serverMs: Number(page.headers.get('x-fixture-ms')),
    calls: JSON.parse(page.headers.get('x-fixture-calls')),
  })
  await new Promise(resolve => setTimeout(resolve, 100))
  const warmPage = await get('/acme/demo?path=src%2Ffile0.ts')
  assert.equal(warmPage.status, 200)
  assert.deepEqual(JSON.parse(warmPage.headers.get('x-fixture-calls')), { do: 0, d1: 1, r2: 0, render: 0 },
    'warm full page resolves its branch with one cheap read and serves the stitched edge body')
  assert.match(warmPage.headers.get('server-timing'), /stitched edge hit/)
  assert.match(await warmPage.text(), /rel="stylesheet".*presentation.css/)
  // Signed-in public browsing keeps the same stored shell. Identity and
  // permissions arrive through islands without changing its geometry.
  const viewerPayload = Buffer.from(JSON.stringify({ publicKey:'ed25519:viewer-cache', name:'ava.samifou.ad', at:new Date().toISOString() })).toString('base64url')
  const viewerCookie = viewerPayload+'.'+createHmac('sha256','fragment-fixture-cookie-secret-32-characters').update(viewerPayload).digest('base64url')
  const ownerWarm = await mf.dispatchFetch('http://localhost/acme/demo?path=src%2Ffile0.ts', {headers:{cookie:'gild_session='+viewerCookie,'accept-encoding':'identity'}})
  const ownerHTML = await ownerWarm.text()
  assert.doesNotMatch(ownerHTML, /<html[^>]*data-portal="true"/, 'public signed-in page keeps the shared shell')
  assert.equal(ownerWarm.headers.get('cache-control'),'public, max-age=0, must-revalidate','warm public HTML must revalidate')
  assert.deepEqual(JSON.parse(ownerWarm.headers.get('x-fixture-calls')), {do:0,d1:1,r2:0,render:0})
  const anonymousWarm = await get('/acme/demo?path=src%2Ffile0.ts')
  assert.equal(await anonymousWarm.text(), ownerHTML, 'anonymous and signed-in public HTML are identical')
  assert.equal(anonymousWarm.headers.get('cache-control'),'public, max-age=0, must-revalidate')
  assert.match(anonymousWarm.headers.get('server-timing'), /stitched edge hit/)
  console.log('PASS viewer-neutral edge page: anonymous → owner → anonymous; shared public shell with live identity; same one-read cache hit')
  if (process.argv.includes('--viewer-cache-only')) throw Object.assign(new Error('Review complete'), {reviewComplete:true})
  evidence.push({ path: '/acme/demo?path=src/file0.ts (warm)', serverMs: Number(warmPage.headers.get('x-fixture-ms')),
    timing: warmPage.headers.get('server-timing'), calls: JSON.parse(warmPage.headers.get('x-fixture-calls')) })
  await bucket.delete(missingKey)
  const lateAt = performance.now()
  const late = await mf.dispatchFetch(`http://localhost/f/v4/blob/${file.fragment.hash}?repo=acme/demo&sha=${firstPointer.tip}&path=src/file0.ts`, {
    headers: { 'accept-encoding': 'identity', 'x-fixture-hold-render': '1' },
  })
  assert.equal(late.status, 202, 'a blocked producer cannot block a page request')
  assert.deepEqual(await late.json(), {state:'pending', retryAfter:3}, 'pending is an explicit callback state')
  assert.equal(JSON.parse(late.headers.get('x-fixture-calls')).render, 0, 'blocked producer is never called by the request')
  assert.ok(performance.now() - lateAt < 500, 'cold request returns within 500 ms without waiting for a producer')
  assert.equal(await bucket.head(missingKey), null, 'producer remains blocked after the response')
  const pendingPageAt = performance.now()
  const pendingPage = await mf.dispatchFetch('http://localhost/acme/demo?path=src/file0.ts&pending-probe=1', {
    headers: { 'accept': 'text/html', 'accept-encoding':'identity', 'x-fixture-hold-render':'1' },
  })
  const pendingHTML = await pendingPage.text()
  assert.equal(pendingPage.status, 200, 'pending content still returns a complete page')
  assert.equal(pendingPage.headers.get('x-gild-state'), 'pending')
  assert.equal(pendingPage.headers.get('cache-control'), 'private, no-store')
  assert.match(pendingHTML, /data-repository="acme\/demo"/, 'already prepared repository chrome remains available')
  assert.match(pendingHTML, /data-artifact-pending.*Pending/s)
  assert.doesNotMatch(pendingHTML, /http-equiv="refresh"/, 'pending content does not restart the page')
  assert.ok(performance.now() - pendingPageAt < 500, 'pending document returns promptly with its producer blocked')
  await get('/__release-render')
  await waitArtifact(missingKey)
  assert.match(await testHit('/f/v4/blob/' + file.fragment.hash), /value0/)
  evidence.push({ path: 'queued cold artifact, no foreground build', ms: performance.now() - lateAt })
  const beforeKeys = (await bucket.list()).objects.map((o) => [
    o.key,
    o.uploaded.getTime(),
  ])
  const nextPointer = await (await get('/__seed?version=2')).json()
  await waitStored(nextPointer)
  const afterKeys = (await bucket.list()).objects
  for (const [key, at] of beforeKeys)
    assert.equal(
      afterKeys.find((o) => o.key === key)?.uploaded.getTime(),
      at,
      'unchanged hashes reuse stored fragments',
    )
  const bundle = await get('/f/v4/bundle/' + nextPointer.manifest.hash),
    nextBundle = await bundle.json()
  assert.equal(
    nextBundle.files.find((f) => f.path === 'src/file0.ts').content,
    'export const value0 = 2\n',
  )
  await get('/__pending')
  assert.equal((await get('/__pending-pointer')).status, 200, 'repository DO retains the previous pointer while the push is pending')
  assert.equal(
    (await get('/api/fragments/acme/demo')).status,
    200,
    'accepted push keeps the previous tip available until projection publication',
  )
  assert.equal((await (await get('/api/fragments/acme/demo')).json()).tip, nextPointer.tip)
  assert.equal((await get('/acme/demo?path=src%2Ffile0.ts')).status, 200,
    'accepted push never makes a public page error')
  const pushAt = performance.now()
  // Exhaust the real anonymous DO allowance. Rendered history and cached
  // fragments bypass it; only a missing, never-rendered history object pays.
  await get('/__exhaust-history')
  const historicKey = 'f/v4/blob/'+file.fragment.hash
  const quotaBucket = await mf.getR2Bucket('FRAGMENTS','site')
  await quotaBucket.delete(historicKey)
  const historicalURL = 'http://localhost/'+historicKey+'?repo=acme/demo&sha='+firstPointer.tip+'&path='+encodeURIComponent(file.path)
  const historyGet = () => mf.dispatchFetch(historicalURL,{headers:{'accept-encoding':'identity','cf-connecting-ip':'192.0.2.199'}})
  assert.equal((await historyGet()).status,202,'previously rendered history enqueues without consuming cold quota')
  await waitArtifact(historicKey)
  await db.prepare('DELETE FROM fragment_repos WHERE id=? AND fragment LIKE ?').bind('acme/demo','%/commit/'+firstPointer.tip).run()
  assert.equal((await historyGet()).status,200,'cached history remains readable with exhausted quota')
  await quotaBucket.delete(historicKey)
  const limitedHistory = await historyGet()
  assert.equal(limitedHistory.status,429,'only cold historical render is limited')
  assert.match(await limitedHistory.text(),/href="\/acme\/demo"/)
  assert.ok(Number(limitedHistory.headers.get('retry-after'))>0)
  const restoredHistory = await mf.dispatchFetch(historicalURL,{headers:{'accept-encoding':'identity','cf-connecting-ip':'192.0.2.123'}})
  assert.equal(restoredHistory.status,202,'a different unexhausted viewer can enqueue the history')
  await waitArtifact(historicKey)
  console.log('PASS history quota: rendered and cached free, only cold miss returns explained 429')
  await get('/__seed?version=3')
  const visible = await get('/acme/demo?path=src%2Ffile0.ts')
  assert.equal(visible.status, 200)
  assert.match(await visible.text(), /value0.*3/)
  evidence.push({ path: 'accepted push → indexed new content visible (local fixture)', ms: performance.now() - pushAt })
  await get('/__seed?version=2')
  // A committed ACL takes effect before metadata refresh or queue consumption.
  await get('/__acl')
  assert.equal(
    (await get('/api/fragments/acme/demo')).status,
    404,
    'private pointer must fail closed for anonymous callers',
  )
  assert.equal(
    (await get(`/pf/acme/demo/v4/blob/${file.fragment.hash}`)).status,
    404,
  )
  const privatePointer = await (await get('/__seed?version=1&private')).json()
  await waitStored(privatePointer)
  const payload = Buffer.from(
      JSON.stringify({
        name: 'reader',
        publicKey: 'ed25519:reader',
        at: new Date().toISOString(),
      }),
    ).toString('base64url'),
    cookie =
      payload +
      '.' +
      createHmac('sha256', 'fragment-fixture-cookie-secret-32-characters')
        .update(payload)
        .digest('base64url')
  const privateURL = `/pf/acme/demo/v4/blob/${file.fragment.hash}`,
    allowed = await mf.dispatchFetch('http://localhost' + privateURL, {
      headers: {
        cookie: 'gild_session=' + cookie,
        'accept-encoding': 'identity',
      },
    })
  assert.equal(allowed.status, 200, await allowed.clone().text())
  assert.match(await allowed.text(), /value0/)
  assert.equal(allowed.headers.get('cache-control'), 'private, no-store')
  assert.match(allowed.headers.get('vary'), /Cookie/)
  assert.equal(
    (
      await mf.dispatchFetch('http://localhost' + privateURL, {
        headers: {
          cookie:
            'gild_session=' +
            payload +
            '.' +
            (cookie.split('.')[1][0] === 'a' ? 'b' : 'a') +
            cookie.split('.')[1].slice(1),
        },
      })
    ).status,
    404,
    'forged cookie fails closed',
  )
  const privateObjects = (await bucket.list({ prefix: 'private/' })).objects
  assert.ok(privateObjects.length > 0)
  assert.ok(
    privateObjects.every((o) => o.key.includes(privatePointer.scope)),
    'private objects use an unguessable storage scope',
  )
  writeFileSync(
    join(root, 'fragment-timings.json'),
    JSON.stringify(evidence, null, 2),
  )
  console.log(
    'PASS: real Queue → RepoIndex → pure React/Shiki → gzip R2; cold-edge budgets, reuse, immediate push pointer and private ACL gate',
    evidence,
  )
  if (process.argv.includes('--browser') || process.argv.includes('--source-navigation') || process.argv.includes('--pending-retry-only')) {
    // Restore a fresh public publication, then drive the production router.
    await get('/__seed?version=2')
    const browserManifest = await (await get('/f/v4/manifest/' + nextPointer.manifest.hash)).json()
    const binary = browserManifest.files.find(file => file.path === 'image.bin')
    assert.equal((await prepared('/f/v4/blob/' + binary.fragment.hash + '?repo=acme/demo&sha=' + nextPointer.tip + '&path=image.bin')).status, 200)
    const binaryResponse = await prepared('/f/v4/source/' + binary.blob + '?repo=acme/demo&sha=' + nextPointer.tip + '&path=image.bin')
    assert.equal(binaryResponse.status, 200, 'raw binary artifact is prepared before browser download verification')
    assert.deepEqual([...new Uint8Array(await binaryResponse.arrayBuffer())], [0, 1, 2, 255])
    const transfers = new Map()
    server = createServer(async (req, res) => {
      const name = new URL(req.url, 'http://localhost').pathname.split('/').pop()
      transfers.set(name, (transfers.get(name) ?? 0) + 1)
      const response = await mf.dispatchFetch(`http://localhost${req.url}`, {
        method: req.method,
        headers: req.headers,
      })
      const headers = Object.fromEntries(response.headers)
      delete headers['content-length']
      res.writeHead(response.status, headers)
      res.end(Buffer.from(await response.arrayBuffer()))
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const { browserChecks } = await import('./fragments-browser.mjs')
    await browserChecks(`http://127.0.0.1:${server.address().port}`, get, name => transfers.get(name) ?? 0, process.argv.includes('--source-navigation'), process.argv.includes('--pending-retry-only'))
    if (process.argv.includes('--pending-retry-only')) {
      console.log('PASS bounded actual default manual Pending retry flow')
      throw Object.assign(new Error('Pending retry review complete'), { reviewComplete: true })
    }
  }
  const emptyPointer = await (await get('/__empty')).json()
  assert.equal(emptyPointer.tip, 'empty')
  const emptyPage = await prepared('/acme/demo')
  assert.equal(emptyPage.status, 200, await emptyPage.clone().text())
  assert.match(await emptyPage.text(), /This repository is empty/)
  await get('/__seed?version=2')
  // Swap only the independently deployed renderer, preserving the site
  // bundle and persisted DO/R2 state. No site compilation or deploy occurs.
  const oldAssetURL = JSON.parse(readFileSync('.render/assets.json', 'utf8')).urls['router.js']
  const oldAsset = await get(oldAssetURL)
  assert.equal(oldAsset.status, 200)
  const oldAssetText = await oldAsset.text()
  const nextRenderer = join(dir, 'render-v5.mjs')
  await build({
    entryPoints: [
      'packages/render/router.ts',
      'packages/render/source-worker.ts',
      'packages/render/identity-client.tsx',
      'packages/render/commit-client.tsx',
    ],
    outdir: join(dir, 'assets-v5'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    jsx: 'automatic',
    plugins: [
      cssModules(),
      {
        name: 'next-asset-version',
        setup(b) {
          b.onLoad({ filter: /packages\/render\/address\.ts$/ }, (args) => ({
            contents: readFileSync(args.path, 'utf8').replace(
              "RENDER_VERSION = 'v4'",
              "RENDER_VERSION = 'v5'",
            ),
            loader: 'ts',
          }))
        },
      },
    ],
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  for (const name of ['schibsted-grotesk', 'jetbrains-mono'])
    writeFileSync(
      join(dir, 'assets-v5', name + '.woff2'),
      readFileSync('public'+JSON.parse(readFileSync('.render/assets.json','utf8')).urls[name+'.woff2']),
    )
  writeFileSync(join(dir, 'assets-v5', 'favicon.svg'), readFileSync('public/favicon.svg'))
  await buildTabClient(join(dir, 'assets-v5'))
  const nextAssets = publishAssets('v5', join(dir, 'assets-v5'))
  await build({
    entryPoints: ['gild-render.tsx'],
    outfile: nextRenderer,
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    platform: 'browser',
    conditions: ['workerd', 'browser'],
    external: ['cloudflare:workers', 'node:*'],
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      cssModules({ version: 'v5', manifest: nextAssets }),
      {
        name: 'next-render-version',
        setup(b) {
          b.onLoad({ filter: /packages\/render\/address\.ts$/ }, (args) => ({
            contents: readFileSync(args.path, 'utf8').replace(
              "RENDER_VERSION = 'v4'",
              "RENDER_VERSION = 'v5'",
            ),
            loader: 'ts',
          }))
        },
      },
    ],
  })
  options.workers[1].scriptPath = nextRenderer
  await mf.setOptions(convertV4MiniflareOptions(options))
  await get('/__sync') // Same production minute-cron negotiation, not a per-page fetch.
  const nextVersion = await (await get('/api/fragments/acme/demo')).json()
  assert.equal(
    nextVersion.version,
    'v5',
    'site resolves independently deployed renderer version',
  )
  const newPage = await get('/acme/demo?path=src%2Ffile0.ts')
  assert.equal(newPage.status, 200, await newPage.clone().text())
  assert.ok((await newPage.text()).includes(nextAssets.urls['router.js']))
  const currentPath = `/f/v5/blob/${(await (await get('/f/v5/manifest/' + nextVersion.manifest.hash + '?repo=acme/demo&sha=' + nextVersion.tip)).json()).files.find((f) => f.path === 'src/file0.ts').fragment.hash}?repo=acme/demo&sha=${nextVersion.tip}&path=src/file0.ts`
  const currentObject = await prepared(currentPath)
  assert.equal(currentObject.status, 200)
  const currentHit = await get(currentPath.split('?')[0])
  assert.equal(JSON.parse(currentHit.headers.get('x-fixture-calls')).render, 0)
  assert.equal((await get(nextAssets.urls['router.js'])).status, 200)
  assert.equal(
    await (await get(oldAssetURL)).text(),
    oldAssetText,
    'old shell assets survive renderer-only deployment',
  )
  assert.equal(
    (await get('/f/v4/blob/' + file.fragment.hash)).status,
    200,
    'previous immutable version stays readable',
  )
  console.log(
    'PASS independent deployment: unchanged site resolves v5 pointers/assets and stored v5 fragments; v4 remains immutable',
  )
  const sweepBucket = await mf.getR2Bucket('FRAGMENTS', 'site'), sweepDB = await mf.getD1Database('DB', 'site')
  const revoked = `f/v4/blob/${'7'.repeat(40)}.text.code`, shared = `f/v4/blob/${'8'.repeat(40)}.text.code`
  for (const key of [revoked, shared]) {
    await sweepBucket.put(key, 'previously public content')
    await sweepDB.prepare('INSERT INTO fragment_repos VALUES (?,?)').bind(key, 'acme/revoked').run()
    await sweepDB.prepare('INSERT INTO fragment_retention VALUES (?,?,1,?)').bind(key, 'acme/revoked', Date.now()).run()
  }
  await sweepDB.prepare("INSERT INTO repo_access VALUES ('acme/revoked',NULL,'{}',0)").run()
  await sweepDB.prepare("INSERT INTO repo_access VALUES ('acme/shared',NULL,'{}',0)").run()
  await sweepDB.prepare('INSERT INTO fragment_repos VALUES (?,?)').bind(shared, 'acme/shared').run()
  await sweepDB.prepare('INSERT INTO fragment_retention VALUES (?,?,1,?)').bind(shared, 'acme/shared', Date.now()).run()
  // Both stored objects exist and can warm the real edge cache first.
  for (const key of [revoked, shared]) assert.equal((await mf.dispatchFetch(`http://localhost/${key}?edge`, {
    headers: { 'accept-encoding': 'gzip' },
  })).status, 200)
  await sweepDB.prepare("UPDATE repo_access SET acl='{" + '"visibility":"private"' + "}' WHERE id='acme/revoked'").run()
  assert.equal((await get('/' + revoked)).status, 404, 'flip cuts access even with a warm edge entry')
  await get('/__sweep')
  assert.equal(await sweepBucket.head(revoked), null, 'flip sweeps unreachable R2 bytes')
  assert.ok(await sweepBucket.head(shared), 'shared public repo reference preserves the object')
  assert.equal((await get('/' + shared)).status, 200)
  // A deleted organization also invalidates its repositories, including shared
  // references. The real settings table, not a renderer ACL stub, drives this.
  await sweepDB.prepare("INSERT INTO settings_entities(key,id,deleted_at) VALUES ('acme/shared','acme/shared',?)").bind(Date.now()).run()
  await get('/__sweep')
  assert.equal(await sweepBucket.head(shared), null, 'delete sweeps the final public reference')
  const history = `f/v4/blob/${'6'.repeat(40)}.text.code`
  const tagPointer = await (await get('/__tag')).json()
  const tagKey = `f/v5/blob/${tagPointer.selected.hash}`
  assert.equal((await prepared(`/${tagKey}?repo=acme/demo&sha=${tagPointer.tip}&path=src/file0.ts`)).status, 200)
  assert.equal((await (await get('/api/fragments/acme/demo')).json()).tip, '2'.repeat(40),
    'same-name tag does not replace the branch pointer or break publication')
  await sweepBucket.put(history, 'historical fragment')
  await sweepDB.prepare('INSERT INTO fragment_repos VALUES (?,?)').bind(history, 'acme/demo').run()
  await sweepDB.prepare('INSERT INTO fragment_retention VALUES (?,?,0,?)').bind(history, 'acme/demo', Date.now()).run()
  await get('/__sweep')
  assert.ok(await sweepBucket.head(history), 'unreachable history retains its 30-day grace period')
  await get('/__sweep?now=' + (Date.now() + 30 * 86400000 + 1))
  assert.equal(await sweepBucket.head(history), null, 'history expires after 30 days off current tips')
  assert.ok(await sweepBucket.head(tagKey), 'current tag tip stays reachable after 30 days')
  // Repeat the real selected-file miss after expiration; it must render again.
  const expiredKey = new URL(currentPath, 'http://localhost').pathname.slice(1)
  await sweepBucket.delete(expiredKey)
  await sweepDB.prepare('DELETE FROM fragment_repos WHERE fragment=?').bind(expiredKey).run()
  const expiredRead = await get(currentPath)
  assert.ok([200,202].includes(expiredRead.status), 'an expired object is either already repaired by the queue or pending')
  assert.equal(JSON.parse(expiredRead.headers.get('x-fixture-calls')).render, 0, 'expiration must never trigger foreground rendering')
  await waitArtifact(expiredKey)
  assert.equal((await get(currentPath)).status, 200, 'background preparation restores the immutable object')
  console.log('PASS sweep: public→private, deletion, shared reference, 30-day grace, repeat visit')
} catch (error) {
  if (!error.reviewComplete && !(baselineReads && error.message === 'BASELINE_DONE')) throw error
} finally {
  server?.closeAllConnections()
  if (server) await new Promise((r) => server.close(r))
  await mf.dispose()
}
if (process.argv.includes('--browser')) {
  const { highlightChecks } = await import('./highlight-review.mjs')
  await highlightChecks()
  const reverted = spawnSync(
    process.execPath,
    ['scripts/fragments-local.mjs', '--reverted-fast-path'],
    { encoding: 'utf8', timeout: 60000 },
  )
  assert.notEqual(reverted.status, 0, 'removing public fast path must fail')
  assert.match(
    reverted.stderr,
    /public fragment must check current D1 access before one R2 read; no DO\/render/,
  )
  writeFileSync(
    '.tmp/fragments-review/revert.txt',
    reverted.stdout + reverted.stderr,
  )
  console.log(
    'PASS revert proof: restoring the old repository lookup fails cold fragment call-count budget',
  )
  for (const [flag, expected] of [['--reverted-foreground-render', /missing artifact returns preparation immediately|cold request must never invoke the renderer/],
    ['--reverted-push', /repository DO retains the previous pointer while the push is pending/]]) {
    const reverted = spawnSync(process.execPath, ['scripts/fragments-local.mjs', flag], { encoding: 'utf8', timeout: 60000 })
    assert.notEqual(reverted.status, 0, flag + ' must fail the behavioral suite')
    assert.match(reverted.stderr, expected)
    writeFileSync('.tmp/fast-reads-2/' + flag.slice(2) + '.log', reverted.stdout + reverted.stderr)
    console.log('PASS behavioral revert proof', flag)
  }
}
