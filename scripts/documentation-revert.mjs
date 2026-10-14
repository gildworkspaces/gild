import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

mkdirSync('.tmp', { recursive: true })
const path = 'lib/public-documentation.ts', source = readFileSync(path, 'utf8')
function run(name, args) {
  const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 })
  writeFileSync(`.tmp/documentation-${name}.log`, result.stdout + result.stderr)
  return result
}
const cases = [
  ['prepared-route', '  const url = new URL(request.url)', "  if (request.method === 'GET') return null\n  const url = new URL(request.url)", /missing build artifact stays Pending/],
  ['server-identity', 'return identityForPage(await d1ViewerReads(env.DB, session), session)', 'return identityForPage(null, null)', /Pending retains server account sidebar/],
]
try {
  for (const [name, before, after, effect] of cases) {
    assert.ok(source.includes(before), name + ' mutation applies')
    writeFileSync(path, source.replace(before, after))
    // Worker source is compiled by the fixture, while documentation bodies
    // remain the real immutable build artifacts. No mock page/component.
    const removed = run(name, [process.execPath, 'scripts/documentation-local.mjs'])
    assert.notEqual(removed.status, 0)
    assert.match(removed.stdout + removed.stderr, /AssertionError/)
    assert.match(removed.stdout + removed.stderr, effect)
    console.log('PASS removed ' + name + ': actual compiled document effect assertion fails')
    writeFileSync(path, source)
  }
} finally {
  writeFileSync(path, source)
}
assert.equal(run('restored', [process.execPath, 'scripts/documentation-local.mjs']).status, 0)
console.log('PASS restored immutable docs/account/privacy/legacy-navigation/missing-artifact acceptance')
