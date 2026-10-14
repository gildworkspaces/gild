import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
mkdirSync('.tmp', { recursive: true })
const cases = [
  ['idempotency', 'lib/api/dispatch.ts', "if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && idempotency)", 'if (false)', 'failed idempotent writes', 'lib/api-security.test.ts'],
  ['anonymous-ip', 'lib/api/routing.ts', "new TextEncoder().encode(ip)", "new TextEncoder().encode('shared')", 'anonymous public reads use independent', 'lib/api-security.test.ts'],
  ['principal-rate', 'lib/api/dispatch.ts', 'if (!principal.anonymous) {', 'if (false) {', 'fresh tokens share', 'lib/api-security.test.ts'],
  ['bad-encoding', 'lib/api/routing.ts', "throw new ApiError(400, 'Malformed percent-encoding')", "throw new Error('Malformed percent-encoding')", 'malformed percent', 'lib/api-security.test.ts'],
  ['missing-ip', 'lib/api/routing.ts', "if (!ip) throw new ApiError(400, 'Cloudflare connecting IP is required for anonymous requests')", '', 'anonymous missing IP', 'lib/api-security.test.ts'],
  ['lease', 'lib/api/control-store.ts', 'now + 60000,', 'now + 86400000,', 'idempotency lease expires', 'lib/api-security.test.ts'],
  ['finish-reservation', 'lib/api/dispatch.ts', '!executed && control', 'control', 'idempotency finish failure', 'lib/api-security.test.ts'],
  ['scope', 'lib/api/dispatch.ts', 'if (route.scope && !hasScope(principal, route.scope))', 'if(false)', 'every scope x route', 'lib/api.test.ts'],
  ['allow-list', 'lib/api/dispatch.ts', '!permitsRepo(principal, params.owner, params.repo)', 'false', 'repo allow-list refuses', 'lib/api-security.test.ts'],
  ['writer-queue', 'lib/api/service.ts', "['mergePull', 'dequeuePull'].includes(id)", 'false', 'pulls:write without repository writer|agent token cannot exceed', 'lib/api-security.test.ts'],
  ['review-grant', 'lib/api/service.ts', "!grants.includes('review')", 'false', 'agent token cannot exceed', 'lib/api-security.test.ts'],
  ['agent-cap', 'lib/api/service.ts', '!grantScopes(grants).includes(c.route.scope)', 'false', 'agent token cannot exceed', 'lib/api-security.test.ts'],
]
for (const [name, path, guard, removed, pattern, test] of cases) {
  const original = readFileSync(path, 'utf8')
  try {
    assert.ok(original.includes(guard), `${name}: guard must exist`)
    writeFileSync(path, original.replaceAll(guard, removed))
    const result = spawnSync('node', ['--test', '--test-name-pattern=' + pattern, test], { encoding: 'utf8' })
    writeFileSync(`.tmp/api-revert-${name}.log`, result.stdout + result.stderr)
    assert.notEqual(result.status, 0, `${name}: removing this guard must fail`)
    assert.match(result.stdout, /not ok|✖/)
    console.log(`Revert proof: ${name} guard removed independently; negative test fails; source restored`)
  } finally { writeFileSync(path, original) }
}
const restored = spawnSync('node', ['--test', 'lib/api.test.ts', 'lib/api-security.test.ts'], { encoding: 'utf8' })
writeFileSync('.tmp/api-revert-restored.log', restored.stdout + restored.stderr)
assert.equal(restored.status, 0, restored.stdout + restored.stderr)
console.log('Restored API suites pass')

// Same real workerd command CI executes; deleting the replay guard must fail it.
const path = 'lib/api/dispatch.ts', original = readFileSync(path, 'utf8')
try {
  const guard = "if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && idempotency)"
  assert.ok(original.includes(guard))
  writeFileSync(path, original.replace(guard, 'if (false)'))
  const result = spawnSync('bun', ['run', 'test:api'], {encoding: 'utf8'})
  writeFileSync('.tmp/api-revert-ci-idempotency.log', result.stdout + result.stderr)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr + result.stdout, /AssertionError|idempotency-replayed/)
  console.log('CI-equivalent revert proof: bun run test:api fails with replay guard removed')
} finally { writeFileSync(path, original) }
