import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

const path = 'packages/render/Sidebar.tsx', original = readFileSync(path, 'utf8')
function build() {
  const result = spawnSync(process.execPath, ['scripts/render-build.mjs'], { encoding: 'utf8', timeout: 120000 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const manifest = JSON.parse(readFileSync('.render/assets.json', 'utf8'))
  for (const url of Object.values(manifest.urls)) {
    const destination = '.open-next/assets' + url
    mkdirSync(dirname(destination), { recursive: true }); copyFileSync('public' + url, destination)
  }
}
function run(name) {
  const result = spawnSync(process.execPath, ['scripts/sidebar-handoff-local.mjs'], { encoding: 'utf8', timeout: 180000 })
  const log = (result.stdout ?? '') + (result.stderr ?? '')
  writeFileSync('.tmp/fragments-review/sidebar-handoff-' + name + '.log', log)
  copyFileSync('.tmp/fragments-review/sidebar-handoff/evidence.json', '.tmp/fragments-review/sidebar-handoff-' + name + '.json')
  return { result, log }
}
const cases = [
  ['removed-latest-intent', 'const latestIntent = consumeSidebarIntent()', 'const latestIntent = earlyIntent.current', 'latest click survives retained render commit'],
  ['removed-menu-exclusion', "\n        && !(e.target instanceof Element && e.target.closest('.portal-menu'))", '', 'Menu closes once after handoff without pointerdown reopening'],
]
const evidence = []
try {
  for (const [name, from, to, assertion] of cases) {
    assert.equal(original.split(from).length, 2, 'Selected real correction exists once')
    writeFileSync(path, original.replace(from, to))
    build()
    const { result, log } = run(name)
    assert.equal(result.status, 1, name + ' must fail')
    assert.match(log, /AssertionError \[ERR_ASSERTION\]/)
    assert.ok(log.includes(assertion), 'Actual interaction effect assertion must fail: ' + assertion)
    assert.doesNotMatch(log, /SyntaxError|ERR_MODULE_NOT_FOUND|page.waitForFunction: Timeout/)
    evidence.push({ name, exit: result.status, actualEffectAssertion: assertion })
  }
} finally { writeFileSync(path, original); build() }
const restored = run('restored-corrections')
assert.equal(restored.result.status, 0, restored.log)
writeFileSync('.tmp/fragments-review/sidebar-handoff-removal.json', JSON.stringify({ cases: evidence,
  restoredExit: restored.result.status, sourceRestored: readFileSync(path, 'utf8') === original }, null, 2) + '\n')
console.log('PASS both actual sidebar corrections omitted fail genuine interaction assertions; restored rebuilt source passes')
