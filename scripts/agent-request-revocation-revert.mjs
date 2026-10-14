import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
mkdirSync('.tmp', { recursive: true })
const file = 'lib/agentRequests.ts', original = readFileSync(file, 'utf8')
const cases = [
  ['request', 'if (existing)', 'if (existing && !existing.revokedAt)', 'revoked label request returns409'],
  ['approval', 'if (old)', 'if (old && !old.revokedAt)', 'legacy pending request for revoked label'],
]
const run = (name, pattern) => {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...(pattern ? [`--test-name-pattern=${pattern}`] : []), 'lib/agent-request-revocation.test.ts'], { encoding: 'utf8', timeout: 30000 })
  const output = (result.stdout ?? '') + (result.stderr ?? '')
  writeFileSync(`.tmp/revoked-label-${name}.log`, output)
  return { result, output: output.replace(/\x1b\[[0-9;]*m/g, '') }
}
try {
  for (const [name, before, after, pattern] of cases) {
    assert.equal(original.split(before).length, 2)
    try {
      writeFileSync(file, original.replace(before, after))
      const { result, output } = run(name, pattern)
      assert.equal(result.status, 1)
      assert.match(output, /AssertionError \[ERR_ASSERTION\]/)
      assert.ok(output.split('\n').some(line => line.startsWith('✖ ') && line.includes(pattern)))
      assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|TypeError:/)
    } finally { writeFileSync(file, original) }
  }
} finally {
  writeFileSync(file, original)
  assert.equal(run('restored').result.status, 0)
}
console.log('PASS request and approval removal assertions; restored six effects pass')
