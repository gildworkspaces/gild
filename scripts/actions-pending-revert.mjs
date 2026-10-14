import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

mkdirSync('.tmp', { recursive: true })
const path = 'app/(portal)/[owner]/[repo]/actions/page.tsx'
const source = readFileSync(path, 'utf8')
const before = 'if (!stillPreparing(error)) throw error'
assert.ok(source.includes(before))
function run(name, args) {
  const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 })
  writeFileSync(`.tmp/actions-pending-${name}.log`, result.stdout + result.stderr)
  return result
}
try {
  writeFileSync(path, source.replace(before, 'throw error'))
  assert.equal(run('removed-build', ['bun', 'run', 'build:cloudflare']).status, 0)
  const removed = run('removed', [process.execPath, 'scripts/actions-pending-local.mjs'])
  assert.notEqual(removed.status, 0)
  assert.match(removed.stdout + removed.stderr, /AssertionError/)
  assert.match(removed.stdout + removed.stderr, /workflow cache miss returns Pending inside the repository/)
  console.log('PASS removed Actions Pending handling fails actual compiled SSR assertion')
} finally {
  writeFileSync(path, source)
  assert.equal(run('restored-build', ['bun', 'run', 'build:cloudflare']).status, 0)
}
assert.equal(run('restored', [process.execPath, 'scripts/actions-pending-local.mjs']).status, 0)
console.log('PASS restored compiled Pending chrome and background preparation')
