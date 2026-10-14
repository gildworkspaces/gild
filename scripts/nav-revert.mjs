import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
if (!process.argv.includes('--repo-tabs-only')) {
  execFileSync(process.execPath, ['scripts/signed-in-shell-revert.mjs'], { stdio: 'inherit' })
  const path = 'packages/render/router.ts',
    original = readFileSync(path, 'utf8')
  mkdirSync('.tmp/nav-review', { recursive: true })
  try {
    writeFileSync(
      path,
      execFileSync('git', ['show', '5677ab5:' + path], { encoding: 'utf8' }),
    )
    execFileSync(process.execPath, ['scripts/render-build.mjs'], {
      stdio: 'pipe',
    })
    const result = spawnSync(process.execPath, ['scripts/nav-transitions.mjs'], {
      encoding: 'utf8',
      timeout: 300000,
    })
    const output = result.stdout + result.stderr
    writeFileSync('.tmp/nav-review/revert.log', output)
    assert.notEqual(
      result.status,
      0,
      'old router must fail actual navigation assertions',
    )
    assert.match(
      output,
      /selected synchronously|pending synchronously|skeleton before fetch/,
    )
    assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND/)
    console.log(
      'PASS revert proof: baseline router fails same-click selected tab/skeleton assertion',
    )
  } finally {
    writeFileSync(path, original)
    execFileSync(process.execPath, ['scripts/render-build.mjs'], {
      stdio: 'pipe',
    })
  }

}

const tabsPath = 'packages/render/repo-tabs.ts', tabsOriginal = readFileSync(tabsPath, 'utf8')
for (const [name, before, after, effect] of [
  ['source-intent', "if (found && !found.url.searchParams.has('path') && !found.link.closest('[data-kind=tree]'))", 'if (found)', /bundle manifest opens folders locally/],
  ['failed-prefetch-bound', '    if (attempted.has(key(url))) return Promise.resolve()\n', '', /failed tab publications are prefetched once per generation/],
]) {
  try {
    assert.ok(tabsOriginal.includes(before), name + ' mutation applies')
    writeFileSync(tabsPath, tabsOriginal.replace(before, after))
    execFileSync(process.execPath, ['scripts/render-build.mjs'], { stdio: 'pipe' })
    const result = spawnSync(process.execPath, ['scripts/fragments-local.mjs', '--source-navigation'], { encoding: 'utf8', timeout: 300000 })
    const output = result.stdout + result.stderr
    writeFileSync('.tmp/nav-review/revert-' + name + '.log', output)
    assert.notEqual(result.status, 0, name + ' removal must fail its effect assertion')
    assert.match(output, effect)
    assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND|ENOENT/)
    console.log('PASS revert proof: ' + name + ' fails its real source-browser assertion')
  } finally {
    writeFileSync(tabsPath, tabsOriginal)
    execFileSync(process.execPath, ['scripts/render-build.mjs'], { stdio: 'pipe' })
  }
}

// Restored source must satisfy the exact same bounded browser effects.
execFileSync(process.execPath, ['scripts/fragments-local.mjs', '--source-navigation'], { stdio: 'inherit' })
