import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const path = 'lib/cqx-wasm.ts', original = readFileSync(path, 'utf8')
mkdirSync('.tmp/cqx-review', { recursive: true })
function run(name, command, args, timeout = 180000) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, env: { ...process.env, TMPDIR: process.cwd() + '/.tmp' } })
  writeFileSync(`.tmp/cqx-review/${name}.log`, (result.stdout ?? '') + (result.stderr ?? ''))
  assert.equal(result.error, undefined, name + ' must actually execute')
  return result
}
try {
  const catchReturn = "return partial('c-family-unavailable')"
  assert.ok(original.includes(catchReturn))
  writeFileSync(path, original.replace(catchReturn, 'throw error // Revert: discard C-family failure status.'))
  const unit = run('failure-revert-unit', 'node', ['--test', '--test-name-pattern=heavy.*outage', 'lib/cqx-modules.test.ts'])
  assert.equal(unit.status, 1, 'new outage regressions must fail with fallback reverted')
  assert.equal(run('failure-revert-build', 'bun', ['run', 'build:cloudflare'], 300000).status, 0, 'build reverted production pages')
  const page = run('failure-revert-pages', 'node', ['scripts/cqx-failures.mjs'])
  assert.equal(page.status, 1, 'production page must fail with fallback reverted')
  assert.match(page.stderr, /must explain C-family failure/)
  console.log('PASS revert proof: removing failure fallback breaks the new unit tests and actual production Score page note assertion.')
  const limit = 'if (!heavyWithinLimits(foreign)) return partial(\'c-family-too-large\')'
  assert.ok(original.includes(limit))
  writeFileSync(path, original.replace(limit, '// Revert: send over-limit sources to RPC.'))
  const oversized = run('limits-revert-unit', 'node', ['--test', '--test-name-pattern=synthetic.*over-limit', 'lib/cqx-modules.test.ts'])
  assert.equal(oversized.status, 1, 'synthetic over-limit regressions must fail with cap removed')
  console.log('PASS revert proof: removing the pre-RPC cap breaks all three synthetic over-limit regressions.')
} finally {
  writeFileSync(path, original)
  assert.equal(run('failure-restored-build', 'bun', ['run', 'build:cloudflare'], 300000).status, 0, 'restore production build')
}
