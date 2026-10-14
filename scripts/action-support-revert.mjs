import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const file = 'lib/actions/support.ts', original = readFileSync(file, 'utf8')
mkdirSync('.tmp', { recursive: true })
try {
  writeFileSync(file, execFileSync('git', ['show', '3849fc5:' + file], { encoding: 'utf8' }))
  const result = spawnSync(process.execPath, ['--test', 'lib/actions-support.test.ts'], { encoding: 'utf8', timeout: 60000 })
  const output = result.stdout + result.stderr
  writeFileSync('.tmp/actions-support-revert.log', output)
  assert.notEqual(result.status, 0, 'advertising unsupported work as no-ops must fail real contract/import checks')
  assert.match(output, /must fail, not report a successful no-op/)
  assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND|ENOENT/)
  console.log('PASS reverted no-op contract fails generated consumer and import diagnostics')
} finally { writeFileSync(file, original) }
const restored = spawnSync(process.execPath, ['--test', 'lib/actions-support.test.ts'], { encoding: 'utf8', timeout: 60000 })
writeFileSync('.tmp/actions-support-restored.log', restored.stdout + restored.stderr)
assert.equal(restored.status, 0, restored.stdout + restored.stderr)
console.log('PASS restored artifact/cache contract and generated output')
