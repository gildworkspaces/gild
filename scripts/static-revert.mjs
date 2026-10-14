import { buildAssets } from './render-build.mjs'
import { spawnSync, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import assert from 'node:assert/strict'
mkdirSync('.tmp/static-review',{recursive:true})
const run = (script, args, expected) => {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 120_000 })
  const output = result.stdout + result.stderr
  writeFileSync('.tmp/static-review/revert-' + args[0].replace(/^--/, '').replace(/[^a-z0-9_-]/gi, '-') + '.log', output)
  assert.notEqual(result.status, 0, args[0] + ' must fail')
  assert.match(output, expected)
  assert.doesNotMatch(output, /SyntaxError|ERR_INVALID_TYPESCRIPT_SYNTAX/)
  console.log('PASS revert proof:', args[0])
}
for (const [flag, expected] of [
  ['--reverted-asset-urls', /shell emits hashed asset URL/],
  ['--reverted-asset-headers', /max-age=31536000/],
  ['--reverted-font-preload', /shell preloads|0 !== 2/],
  ['--reverted-shell-address', /shell address hashes/],
]) run('scripts/static-assets.mjs', [flag], expected)
run('scripts/fragments-local.mjs', ['--reverted-page-browser-header'], /warm public HTML must revalidate/)
run('scripts/fragments-local.mjs', ['--reverted-cache-encoding'], /cached fragment must decode to original HTML bytes/)
run('scripts/fragments-local.mjs', ['--reverted-lease'], /warm public read must make zero origin calls/)
run('scripts/fragments-local.mjs', ['--reverted-commit-cache'], /renewing commit authorization must reuse the immutable pointer/)
run('scripts/public-pages-local.mjs', ['--reverted-search-cache'], /warm immutable search results must make zero origin calls/)
run('scripts/public-pages-local.mjs', ['--reverted-search-scope'], /cached search must restrict its immutable catalog/)
run('scripts/public-pages-local.mjs', ['--reverted-form-shells'], /acme\/demo\/issues\/new/)
run('scripts/public-pages-local.mjs', ['--reverted-pages'], /warm public page must make zero origin calls/)
run('scripts/fragments-local.mjs', ['--reverted-islands'], /warm public read must make zero origin calls/)
const path = 'lib/fragments/edge.ts', original = readFileSync(path, 'utf8')
try {
  writeFileSync(path, original.replace('now() < lease.until', 'true'))
  run('--test', ['lib/public-edge.test.ts'], /revocation|second|AssertionError/)
} finally { writeFileSync(path, original) }
console.log('PASS restored edge expiry guard')

const routerPath='packages/render/router.ts',routerOriginal=readFileSync(routerPath,'utf8')
try {
  writeFileSync(routerPath,routerOriginal.replace("      if (document.readyState === 'complete') preload()\n      else window.addEventListener('load', preload, { once: true, signal })","      preload()"))
  await buildAssets()
  run('scripts/fragments-local.mjs',['--browser'],/source bundle Worker must wait for the page load event/)
}finally{writeFileSync(routerPath,routerOriginal);await buildAssets()}
console.log('PASS restored bundle load-event deferral')

const activityPath='lib/public-activity.ts',activityOriginal=readFileSync(activityPath,'utf8')
try {
 assert.ok(activityOriginal.includes('if (publication) {'), 'publication mutation applies')
 writeFileSync(activityPath,activityOriginal.replace('if (publication) {', 'if (false) {'))
 run('--test',['lib/public-activity.test.ts'],/publication bypasses stale minute candidate commits/)
}finally{writeFileSync(activityPath,activityOriginal)}
console.log('PASS restored immutable publication candidate input')

for (const [name, before, after] of [
 ['cold-page-scan', 'else if (!latest && s.prepare)', 'else if (!latest && false)'],
 ['expired-page-scan', 'else if (latest && s.prepare)', 'else if (latest && false)'],
]) {
 try {
  assert.ok(activityOriginal.includes(before), name + ' mutation applies')
  writeFileSync(activityPath,activityOriginal.replace(before,after))
  run('--test',['lib/public-activity.test.ts'],/production landing misses enqueue preparation/)
 } finally { writeFileSync(activityPath,activityOriginal) }
 console.log('PASS restored producer-only landing preparation:',name)
}

const pushPath='lib/push-presentation.ts',pushOriginal=readFileSync(pushPath,'utf8')
try {
 writeFileSync(pushPath,pushOriginal.replace('  await publish()', '  void publish()'))
 run('--test',['lib/push-presentation.test.ts'],/Git acknowledgement must wait for stored presentation/)
}finally{writeFileSync(pushPath,pushOriginal)}
console.log('PASS restored push publication acknowledgement barrier')

const mutationPath='lib/public-mutation.ts',mutationOriginal=readFileSync(mutationPath,'utf8')
try {
 writeFileSync(mutationPath,mutationOriginal.replace('!transportOperations.has(operation.route.id)', 'true'))
 run('--test',['lib/public-mutation.test.ts'],/runner transport and import progress/)
}finally{writeFileSync(mutationPath,mutationOriginal)}
console.log('PASS restored transport mutation publication filter')

try {
 writeFileSync(pushPath,pushOriginal.replace('    if (response.status === 204) return', '    return'))
 run('--test',['lib/push-presentation.test.ts'],/push publication follows every batch/)
}finally{writeFileSync(pushPath,pushOriginal)}
console.log('PASS restored push renderer continuation barrier')

const staticHTMLPath='lib/public-static-html.ts',staticHTMLOriginal=readFileSync(staticHTMLPath,'utf8')
try {
 writeFileSync(staticHTMLPath,staticHTMLOriginal.replace('let response = await edge.match(key)','let response = undefined'))
 run('--test',['lib/public-static-html.test.ts'],/warm built document must not invoke the server adapter/)
}finally{writeFileSync(staticHTMLPath,staticHTMLOriginal)}
console.log('PASS restored immutable build document HTML cache')

try {
 const begin=original.indexOf('    generation ??=')
 const end=original.indexOf('    const epoch = await generation',begin)
 writeFileSync(path,original.slice(0,begin)+"    generation ??= edge.match(generationKey(origin)).then(r => r ? r.text() : 'initial')\n"+original.slice(end))
 run('--test',['lib/public-edge.test.ts'],/generation eviction never resurrects/)
}finally{writeFileSync(path,original)}
console.log('PASS restored generation eviction fence')

const httpPath='lib/fragments/http.ts',httpOriginal=readFileSync(httpPath,'utf8')
try {
 const previous=execFileSync('git',['show','aeb669f:lib/fragments/http.ts'],{encoding:'utf8'})
 const helper=previous.slice(previous.indexOf('declare const HTMLRewriter:'),previous.indexOf('export interface FragmentEnv'))
 let reverted="import { verifySessionCookie } from '../session-cookie'\n"+helper+httpOriginal
 reverted=reverted.replace('timed(new Response(request.method === \'HEAD\' ? null : cached.body','timed(await viewerPage(new Response(request.method === \'HEAD\' ? null : cached.body')
 reverted=reverted.replace('}), start, `index;dur=${pointerMs.toFixed(2)}, page;', '}), request, env), start, `index;dur=${pointerMs.toFixed(2)}, page;')
 reverted=reverted.replace("      request.method === 'HEAD' ? new Response(null, { headers: response.headers }) : response,", "      await viewerPage(request.method === 'HEAD' ? new Response(null, { headers: response.headers }) : response, request, env),")
 writeFileSync(httpPath,reverted)
 run('scripts/fragments-local.mjs',['--reverted-public-viewer-shell'],/public signed-in page keeps the shared shell/)
}finally{writeFileSync(httpPath,httpOriginal)}
console.log('PASS restored neutral public viewer shell')

const scrollPath='packages/render/scroll.ts',scrollOriginal=readFileSync(scrollPath,'utf8')
try {
 writeFileSync(scrollPath,scrollOriginal.replace('const { gildScrollPending: _, ...state } = history.state ?? {}','const { gildScrollPending: _, ...state } = history.state'))
 run('--test',['lib/fragment-scroll.test.ts'],/reload with no history state/)
}finally{writeFileSync(scrollPath,scrollOriginal)}
console.log('PASS restored empty reload history state guard')
