import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
mkdirSync('.tmp', { recursive: true })
const cases = [
  [
    'page',
    'lib/privacy-http.ts',
    /await mayRead\(s,\s*owner,\s*repo,\s*viewer\.name,\s*access\)/g,
    'true',
    'viewer x every repository route',
  ],
  [
    'listing',
    'lib/repo-list.ts',
    /await mayRead\(\{store:s\.store,index:async\(\)=>null\}, owner, r\.name, viewer, \{meta:snapshot\.meta,acl:snapshot\.acl,pending:false\}\)/g,
    'true',
    'cached listings normalize',
  ],
  [
    'event',
    'lib/events/repositories.ts',
    /await read\(owner, repo, c\.principal\.name\)/g,
    'true',
    'stream selection filters',
  ],
]
const baseline = spawnSync(
  process.execPath,
  ['--test', 'lib/privacy.test.ts'],
  { encoding: 'utf8', timeout: 60000 },
)
assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr)
for (const [name, path, guard, replacement, pattern] of cases) {
  const original = readFileSync(path, 'utf8')
  try {
    const changed = original.replace(guard, replacement)
    assert.notEqual(changed, original, `${name}: guard exists`)
    writeFileSync(path, changed)
    const result = spawnSync(
      process.execPath,
      ['--test', '--test-name-pattern=' + pattern, 'lib/privacy.test.ts'],
      { encoding: 'utf8', timeout: 60000 },
    )
    const log = result.stdout + result.stderr
    writeFileSync(`.tmp/privacy-revert-${name}.log`, log)
    assert.notEqual(result.status, 0, `${name}: removing mayRead must fail`)
    assert.match(log, /AssertionError|ERR_ASSERTION/)
    assert.doesNotMatch(log, /SyntaxError|ERR_INVALID_TYPESCRIPT_SYNTAX/)
    console.log(
      `PASS revert proof ${name}: removing the shared read guard fails its effect test`,
    )
  } finally {
    writeFileSync(path, original)
  }
}
const restored = spawnSync(
  process.execPath,
  ['--test', 'lib/privacy.test.ts'],
  { encoding: 'utf8', timeout: 60000 },
)
writeFileSync(
  '.tmp/privacy-revert-restored.log',
  restored.stdout + restored.stderr,
)
assert.equal(restored.status, 0, restored.stdout + restored.stderr)
console.log('PASS restored privacy suite')
