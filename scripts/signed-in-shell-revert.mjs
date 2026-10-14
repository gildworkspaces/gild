import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'

const path = 'lib/fragments/viewer-islands.ts', original = readFileSync(path, 'utf8')
const selectShell = 'const personalized = data?.name ?'
assert.ok(original.includes(selectShell), 'signed-in shell mutation applies')
mkdirSync('.tmp/nav-review', { recursive: true })
try {
  writeFileSync(path, original.replace(selectShell, 'const personalized = false ?'))
  const result = spawnSync(process.execPath, ['scripts/signed-in-shell.mjs', '--menu-only'], { encoding: 'utf8', timeout: 300000 })
  const output = result.stdout + result.stderr
  writeFileSync('.tmp/nav-review/revert-signed-in-shell.log', output)
  assert.notEqual(result.status, 0, 'losing the signed-in shell must fail the direct-route check')
  assert.match(output, /public code: exactly one account sidebar/)
  assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND|ENOENT/)
  console.log('PASS revert proof: losing the signed-in shell fails the real Code sidebar assertion')
} finally {
  writeFileSync(path, original)
}

const viewerPath = 'packages/render/tab-client.tsx', viewerOriginal = readFileSync(viewerPath, 'utf8')
const provider = '<ViewerProvider viewer={viewer}>'
assert.ok(viewerOriginal.includes(provider), 'standalone viewer mutation applies')
try {
  writeFileSync(viewerPath, viewerOriginal.replace(provider, '<ViewerProvider viewer={{name:null}}>'))
  execFileSync(process.execPath, ['scripts/render-build.mjs'], { stdio: 'pipe' })
  const result = spawnSync(process.execPath, ['scripts/signed-in-shell.mjs', '--menu-only'], { encoding: 'utf8', timeout: 300000 })
  const output = result.stdout + result.stderr
  writeFileSync('.tmp/nav-review/revert-standalone-viewer.log', output)
  assert.notEqual(result.status, 0, 'losing standalone viewer context must fail creation controls')
  assert.match(output, /public issues: mounted creation controls retain the viewer/)
  assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND|ENOENT/)
  console.log('PASS revert proof: losing standalone viewer context fails the real New issue control assertion')
} finally {
  writeFileSync(viewerPath, viewerOriginal)
  execFileSync(process.execPath, ['scripts/render-build.mjs'], { stdio: 'pipe' })
}

const layoutPath = 'app/(marketing)/layout.tsx', layoutOriginal = readFileSync(layoutPath, 'utf8')
const account = 'if (identity) return <AccountShell'
assert.ok(layoutOriginal.includes(account), 'initial authenticated shell mutation applies')
try {
  writeFileSync(layoutPath, layoutOriginal.replace(account, 'if (identity && !identity.claimed) return <AccountShell'))
  execFileSync('bun', ['run', 'build:cloudflare'], { stdio: 'pipe' })
  const result = spawnSync(process.execPath, ['scripts/signed-in-shell.mjs', '--identity-only'], { encoding: 'utf8', timeout: 300000 })
  const output = result.stdout + result.stderr
  writeFileSync('.tmp/nav-review/revert-server-identity.log', output)
  assert.notEqual(result.status, 0, 'losing the server account must fail before client JavaScript runs')
  assert.match(output, /\/: initial response contains the authenticated account/)
  assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND|ENOENT/)
  console.log('PASS revert proof: losing server identity fails the initial HTML account assertion')
} finally {
  writeFileSync(layoutPath, layoutOriginal)
  execFileSync('bun', ['run', 'build:cloudflare'], { stdio: 'pipe' })
}

const pendingReverts = [
  ['pending-menu', 'packages/render/router.ts',
    "  if (!tabs && !nextPrefetch && document.documentElement.hasAttribute('data-repo-router')) void mount().catch(() => {})",
    '', /sidebar\[data-sidebar-client-ready\]/],
  ['pending-no-wait', 'worker.ts',
    'if (!pageReads.metadataReady) {',
    'if (false) {',
    /Pending metadata must not enter the Next producer/],
]
for (const [name, file, before, after, effect] of pendingReverts) {
  const original = readFileSync(file, 'utf8')
  try {
    assert.ok(original.includes(before), name + ' mutation applies')
    writeFileSync(file, original.replace(before, after))
    execFileSync('bun', ['run', 'build:cloudflare'], { stdio: 'pipe' })
    const result = spawnSync(process.execPath, ['scripts/signed-in-shell.mjs', '--pending-only'], { encoding: 'utf8', timeout: 300000 })
    const output = result.stdout + result.stderr
    writeFileSync('.tmp/nav-review/revert-' + name + '.log', output)
    assert.notEqual(result.status, 0, name + ' removal must fail its Pending browser effect')
    assert.match(output, effect)
    assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND|ENOENT/)
    console.log('PASS revert proof: ' + name + ' fails the blocked-producer browser assertion')
  } finally {
    writeFileSync(file, original)
    execFileSync('bun', ['run', 'build:cloudflare'], { stdio: 'pipe' })
  }
}
execFileSync(process.execPath, ['scripts/signed-in-shell.mjs', '--pending-only'], { stdio: 'inherit' })
