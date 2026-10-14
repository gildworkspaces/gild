import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
mkdirSync('.tmp', { recursive: true })
const file = 'lib/public-mutation.ts', original = readFileSync(file, 'utf8')
const before = "if (request.method === 'POST' && /^\\/api\\/auth\\/(challenge|answer|signout)\\/?$/.test(path)) return false"
const run = (name, pattern) => {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...(pattern ? [`--test-name-pattern=${pattern}`] : []), 'lib/public-mutation.test.ts', 'lib/public-edge.test.ts'], { encoding: 'utf8', timeout: 30000 })
  const output = ((result.stdout ?? '') + (result.stderr ?? '')).replace(/\x1b\[[0-9;]*m/g, '')
  writeFileSync(`.tmp/auth-publication-${name}.log`, output)
  return { result, output }
}
try {
  assert.equal(original.split(before).length, 2)
  writeFileSync(file, original.replace(before, ''))
  const { result, output } = run('removed', 'authentication-only')
  assert.equal(result.status, 1)
  assert.match(output, /AssertionError \[ERR_ASSERTION\]/)
  assert.ok(output.split('\n').some(line => line.startsWith('✖ authentication-only')))
  assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|TypeError:/)
} finally {
  writeFileSync(file, original)
  assert.equal(run('restored').result.status, 0)
}
console.log('PASS removed auth exclusion fails assertion; restored classification and real edge-cache effects pass')
