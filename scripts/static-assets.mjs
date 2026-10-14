import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { buildAssets, cssModules } from './render-build.mjs'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
const manifest = await buildAssets()
for (const [name, path] of Object.entries(manifest.urls)) {
  const bytes = readFileSync('public' + path)
  const hash = createHash('sha256').update(bytes).digest('hex')
  assert.equal(path, `/gild-fragments/${hash}/${name}`, 'asset address hashes the actual delivered bytes')
}
const css = readFileSync('public' + manifest.urls['presentation.css'], 'utf8')
for (const font of ['schibsted-grotesk.woff2', 'jetbrains-mono.woff2']) assert.ok(css.includes(manifest.urls[font]))
const revert = { name: 'static-asset-revert-proof', setup(b) {
  b.onLoad({ filter: /(?:packages\/render\/Shell\.tsx|gild-render\.tsx)$/ }, args => {
    let contents = readFileSync(args.path, 'utf8')
    if (process.argv.includes('--reverted-asset-urls')) contents = contents.replace("href={assets.urls['presentation.css']}", "href={`/gild-fragments/${version}/presentation.css`}")
    if (process.argv.includes('--reverted-font-preload')) contents = contents.split('\n').filter(line => !line.includes("['schibsted-grotesk.woff2', 'jetbrains-mono.woff2'].map")).join('\n')
    if (process.argv.includes('--reverted-asset-headers')) contents = contents.replace("? ASSET_CACHE : 'public, max-age=3600'", "? PUBLIC_CACHE : 'public, max-age=3600'")
    if (process.argv.includes('--reverted-shell-address')) contents = contents.replace("digest(shellHTML).then(hash => RENDER_VERSION + '.' + hash)", 'Promise.resolve(RENDER_VERSION)')
    return { contents, loader: 'tsx' }
  })
} }
await build({ entryPoints: ['gild-render.tsx'], outfile: '.tmp/static-render.mjs', bundle: true,
  platform: 'browser', format: 'esm', jsx: 'automatic', conditions: ['workerd', 'browser'],
  external: ['cloudflare:workers', 'node:*'], define: { 'process.env.NODE_ENV': '"production"' }, plugins: [revert, cssModules()] })
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, scriptPath: '.tmp/static-render.mjs', compatibilityDate: '2026-10-01',
  compatibilityFlags: ['nodejs_compat'], r2Buckets: ['FRAGMENTS'], inspectorPort: 0 }))
try {
  for (const [name, path] of Object.entries(manifest.urls)) {
    const response = await mf.dispatchFetch('https://gild.gg' + path.replace('/gild-fragments/', '/assets/'))
    assert.equal(response.status, 200, name)
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync('public' + path))
  }
  const res = await mf.dispatchFetch('https://gild.gg/render', { method: 'POST', body: JSON.stringify({ entity: 'unused' }) })
  assert.equal(res.status, 200)
  const { key } = await res.json()
  const shell = gunzipSync(Buffer.from(await (await (await mf.getR2Bucket('FRAGMENTS')).get(key)).arrayBuffer())).toString()
  assert.ok(key.endsWith('.' + createHash('sha256').update(shell).digest('hex')), 'shell address hashes its actual emitted HTML')
  for (const name of ['router.js', 'presentation.css', 'favicon.svg']) assert.ok(shell.includes((name.endsWith('.js') ? 'src=' : 'href=') + '"' + manifest.urls[name] + '"'), 'shell emits hashed asset URL: ' + name)
  for (const font of ['schibsted-grotesk.woff2', 'jetbrains-mono.woff2'])
    assert.ok(shell.includes('rel="preload" href="' + manifest.urls[font] + '"') || shell.includes('href="' + manifest.urls[font] + '"'), 'shell preloads ' + font)
  assert.equal((shell.match(/as="font"/g) ?? []).length, 2)
  assert.equal((await mf.dispatchFetch('https://gild.gg/assets/' + '0'.repeat(64) + '/router.js')).status, 404)
  const headers = readFileSync('public/_headers', 'utf8')
  assert.match(headers, /\/_next\/static\/\*\n  Cache-Control: public, max-age=31536000, immutable/)
  for (const path of Object.values(manifest.urls)) assert.ok(headers.includes(path.slice(0, path.lastIndexOf('/')) + '/*'))
  assert.ok(!headers.includes('/gild-fragments/*'), 'unhashed legacy paths must not be immutable')
  console.log('PASS asset budgets: delivered hashes, CSS font references, immutable headers, unknown hash fails closed')
} finally { await mf.dispose() }
