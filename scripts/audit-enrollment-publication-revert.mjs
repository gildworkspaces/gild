import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
mkdirSync('.tmp', { recursive: true })
const run = (name, args) => {
  const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 })
  const output = ((result.stdout ?? '') + (result.stderr ?? '')).replace(/\x1b\[[0-9;]*m/g, '')
  writeFileSync(`.tmp/native-${name}.log`, output)
  return { result, output }
}
const cases = [
  ['auth-removed', 'lib/public-mutation.ts', "if (request.method === 'POST' && /^\\/api\\/auth\\/(challenge|answer|signout)\\/?$/.test(path)) return false", '', false, 'auth write makes zero public job/forge-owner enumeration statements'],
  ['signout-removed', 'app/api/auth/signout/route.ts', 'csrfSafe(request,{trustWorkerOrigin:true})', 'csrfSafe(request)', true, '403 !== 200'],
]
const originals = new Map(cases.map(([, path]) => [path, readFileSync(path, 'utf8')]))
const ledger = []
try {
  for (const [name, path, before, after, build, message] of cases) {
    const original = originals.get(path)
    assert.equal(original.split(before).length, 2, name + ' unique mutation target')
    try {
      writeFileSync(path, original.replace(before, after))
      if (build) assert.equal(run(name + '-build', ['bun', 'run', 'build:cloudflare']).result.status, 0)
      const { result, output } = run(name, [process.execPath, 'scripts/audit-enrollment-publication-local.mjs', '--publication-only'])
      assert.equal(result.status, 1)
      assert.match(output, /AssertionError \[ERR_ASSERTION\]/)
      assert.ok(output.includes(message), name + ' actual behavior assertion')
      assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND|TypeError:/)
      ledger.push({ case: name, assertionFailure: true, effect: message })
    } finally { writeFileSync(path, original) }
  }
} finally {
  for (const [path, original] of originals) writeFileSync(path, original)
  assert.equal(run('restored-build', ['bun', 'run', 'build:cloudflare']).result.status, 0)
  assert.equal(run('restored', [process.execPath, 'scripts/audit-enrollment-publication-local.mjs']).result.status, 0)
  writeFileSync('.tmp/native-audit-removal-evidence.json', JSON.stringify(ledger, null, 2) + '\n')
}
console.log('PASS compiled auth/signout removals and restored full Worker/Chrome/native-cache acceptance')
