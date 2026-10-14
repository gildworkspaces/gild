import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const path = 'lib/cqx-wasm.ts', original = readFileSync(path, 'utf8')
mkdirSync('.tmp/cqx-review', { recursive: true })
const call = 'for (const id of selected) sessions.push(await remote(() => binding.open(id, all.filter(f => moduleFor(f.path) === id), label, BUILD)))'
assert.ok(original.includes(call), 'find production service-binding call')
try {
  writeFileSync(path, original.replace(call, '// Revert proof: remove the heavy service-binding call.'))
  const unit = spawnSync('node', ['--test', '--test-name-pattern=C-only', 'lib/cqx-modules.test.ts'], { encoding: 'utf8', timeout: 60000 })
  writeFileSync('.tmp/cqx-review/revert-unit.log', unit.stdout + unit.stderr)
  assert.equal(unit.status, 1, 'routing/finding test must fail with service call removed')
  const worker = spawnSync('node', ['scripts/cqx-local.mjs'], { encoding: 'utf8', timeout: 180000 })
  writeFileSync('.tmp/cqx-review/revert-workerd.log', worker.stdout + worker.stderr)
  assert.equal(worker.status, 1, 'real workerd scan must fail with service call removed')
  assert.match(worker.stderr, /cJSON must score through the service binding/)
  console.log('Removing service-binding call: unit test fails; real workerd C-only scan returns 0 lines and fails. Production source restored.')
} finally { writeFileSync(path, original) }
