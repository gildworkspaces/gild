import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync, execFileSync } from 'node:child_process'
mkdirSync('.tmp/browser-proof-review', { recursive: true })
const files = ['app/api/auth/status/route.ts', 'app/api/claim/status/route.ts', 'lib/drivers/d1.ts', 'lib/drivers/memory.ts']
const original = Object.fromEntries(files.map(f => [f, readFileSync(f, 'utf8')]))
function run(name, expected, effect) {
  const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=actual routes bind browser', 'lib/browser-proof.test.ts'], { encoding: 'utf8' })
  const output = result.stdout + result.stderr
  writeFileSync(`.tmp/browser-proof-review/${name}.log`, output)
  if (expected === 'fail') {
    assert.notEqual(result.status, 0, name + ' must fail')
    assert.match(output, effect, 'failure must be the actual session-issuance effect')
  } else assert.equal(result.status, 0, output)
  console.log('PASS ' + name)
}
try {
  for (const file of files.slice(0, 2)) writeFileSync(file, execFileSync('git', ['show', 'c6afa1741cf0f596040a22dd4f603ff7cc038865:' + file], { encoding: 'utf8' }))
  run('unbound-status-baseline', 'fail', /another browser must not receive a session/)
  for (const file of files) writeFileSync(file, original[file])
  assert.ok(original['lib/drivers/d1.ts'].includes("AND coalesce(json_extract(payload,'$.browserConsumed'),0)=0"))
  assert.ok(original['lib/drivers/memory.ts'].includes(' || proof.consumed'))
  writeFileSync('lib/drivers/d1.ts', original['lib/drivers/d1.ts'].replace("AND coalesce(json_extract(payload,'$.browserConsumed'),0)=0", 'AND 1=1'))
  writeFileSync('lib/drivers/memory.ts', original['lib/drivers/memory.ts'].replace(' || proof.consumed', ''))
  run('replayed-completion', 'fail', /exactly one completion can issue a session/)
} finally {
  for (const file of files) writeFileSync(file, original[file])
}
run('restored', 'pass')
