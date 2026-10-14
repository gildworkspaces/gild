import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
const path = 'packages/presentation/sidebar-bootstrap.ts', original = readFileSync(path, 'utf8')
function build() {
  const r = spawnSync(process.execPath, ['scripts/render-build.mjs'], { encoding: 'utf8', timeout: 120000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const manifest = JSON.parse(readFileSync('.render/assets.json', 'utf8'))
  for (const url of Object.values(manifest.urls)) {
    const destination = '.open-next/assets' + url
    mkdirSync(dirname(destination), { recursive: true }); copyFileSync('public' + url, destination)
  }
}
const run = name => {
  const r = spawnSync(process.execPath, ['scripts/sidebar-first-click-local.mjs'], { encoding: 'utf8', timeout: 180000 })
  writeFileSync('.tmp/fragments-review/sidebar-first-click-' + name + '.log', (r.stdout ?? '') + (r.stderr ?? ''))
  return r
}
let removed
try {
  assert.equal(original.split('(function () {').length, 2)
  writeFileSync(path, original.replace('(function () {', '(function () { return;'))
  build(); removed = run('removed-bootstrap')
  assert.equal(removed.status, 1)
  assert.match(removed.stdout + removed.stderr, /AssertionError \[ERR_ASSERTION\]: real early Menu click opens while island is held/)
  assert.doesNotMatch(removed.stdout + removed.stderr, /__name is not defined|SyntaxError|ERR_MODULE_NOT_FOUND/)
} finally { writeFileSync(path, original); build() }
const restored = run('restored-bootstrap')
assert.equal(restored.status, 0, restored.stdout + restored.stderr)
writeFileSync('.tmp/fragments-review/sidebar-first-click-removal.json', JSON.stringify({ removedExit: removed.status, actualEffectAssertion: true, restoredExit: restored.status, sourceRestored: readFileSync(path, 'utf8') === original }, null, 2) + '\n')
console.log('PASS disabled bootstrap fails actual early-click effect; restored rebuilt source passes')
