import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const path = 'packages/render/router.ts', original = readFileSync(path, 'utf8')
const cases = [
  ['capture', 'const found = safeLink(event.target, true, pendingRetry)', 'const found = safeLink(event.target, true)', 'manual Pending retry retains the current document immediately after click'],
  ['history', "const mode = pendingRetry && found.url.href === location.href ? 'preserve' : 'push'", "const mode = 'push'", 'still-Pending retry preserves history length'],
  ['canonical', "  else if (mode === 'preserve' && url.href !== current.href)\n    History.prototype.replaceState.call(history, history.state, '', url)\n", '', 'Pending retry replaces the abbreviated URL with the canonical commit'],
]
for (const [, guard] of cases) assert.equal(original.split(guard).length, 2)
mkdirSync('.tmp/fragments-review', { recursive: true })
const run = (name, args) => {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000 })
  const output = (result.stdout ?? '') + (result.stderr ?? '')
  writeFileSync('.tmp/fragments-review/pending-retry-' + name + '.log', output)
  return { result, output }
}
try {
  for (const [name, guard, replacement, effect] of cases) {
    try {
      writeFileSync(path, original.replace(guard, replacement))
      assert.equal(run('removed-' + name + '-build', ['scripts/render-build.mjs']).result.status, 0)
      const negative = run('removed-' + name, ['scripts/fragments-local.mjs', '--pending-retry-only'])
      assert.equal(negative.result.status, 1)
      assert.ok(negative.output.includes('AssertionError [ERR_ASSERTION]: ' + effect), negative.output)
      assert.doesNotMatch(negative.output, /TimeoutError|SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND/)
    } finally { writeFileSync(path, original) }
  }
} finally {
  writeFileSync(path, original)
  assert.equal(run('restored-build', ['scripts/render-build.mjs']).result.status, 0, 'restored source must be rebuilt before a browser reads it')
}
const restored = run('restored', ['scripts/fragments-local.mjs', '--pending-retry-only'])
assert.equal(restored.result.status, 0, restored.output)
assert.match(restored.output, /PASS source\/commit Pending: available chrome, no error or document reload, real artifact on manual retry/)
assert.equal(readFileSync(path, 'utf8'), original)
writeFileSync('.tmp/fragments-review/pending-retry-removal-evidence.json', JSON.stringify({
  guards: cases.map(([name]) => name), assertionFailures: 3,
  restoredSource: true, rebuiltAssets: true, restoredActualFlow: true,
  unchangedDefaultWaitMs: 30000, productionAuthority: false,
}, null, 2) + '\n')
console.log('PASS three actual Pending retry capture/history/canonical guard assertions and rebuilt restored flow')
