import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
// Each orchestrator behaviour is removed in turn; the effect suite must fail.
mkdirSync('.tmp', { recursive: true })
const cases = [
  ['owners', 'lib/orchestrators.ts', "if (!(await repoAdmin(st, owner, name))) throw new ApiError(403, 'Only a repository owner or admin can grant orchestrator')", 'void repoAdmin'],
  ['narrowing', 'lib/orchestrators.ts', 'const wider = scopes.filter((scope) => !covers(c.principal, scope))', 'const wider: Scope[] = []'],
  ['grants', 'lib/orchestrators.ts', "const extra = c.body.grants.filter((g: string) => !own.includes(g as never))", 'const extra: string[] = []'],
  ['limit', 'lib/drivers/d1.ts', 'WHERE sponsored_by=? AND revoked_at IS NULL)<?', 'WHERE sponsored_by=? AND revoked_at IS NULL)<?+100'],
  ['cascade', 'lib/orchestrators.ts', 'if (!child.revokedAt && child.childScope === scope) revoked.push', 'if (false) revoked.push'],
  ['grandchildren', 'lib/orchestrators.ts', 'for (const child of await st.childrenOf(next)) if (!child.revokedAt) queue.push(child.name)', ''],
  ['mentions', 'lib/channel/participants.ts', '|| agent.revokedAt || agent.suspendedAt)) continue', '|| agent.revokedAt)) continue'],
  ['forbidden', 'lib/token-verifier.ts', 'if (!a || a.revokedAt || a.suspendedAt) return null', 'if (!a || a.revokedAt) return null'],
  ['status', 'lib/token-verifier.ts', 'throw new ApiError(403, `@${a.name} is suspended`)', 'return'],
  ['notes', 'lib/orchestrators.ts', 'await channel.note(', 'void (']
  , ['raw', 'lib/events/store.ts', 'mentions.raw.includes(row.repo))', 'false)'],
  ['split', 'lib/orchestrators.ts', 'if (!scopes.size) return []', 'if (!scopes.size) return repos'],
  ['own', 'lib/events/store.ts', '((!!mentions.viewer && row.audience === mentions.viewer) ||', '(false ||'],
  ['prefix', 'lib/channel/participants.ts', "agent && orchestrators.has(name) ? '%'", "false ? '%'"],
]
const run = async (name, args) => {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (b) => { output += b; writeFileSync('.tmp/orchestrator-revert-' + name + '.log', output) })
  const timer = setTimeout(() => child.kill('SIGTERM'), 300000)
  const code = await new Promise((r) => child.on('exit', r))
  clearTimeout(timer)
  return { code, output }
}
for (const [name, path, before, after] of cases) {
  if (process.argv[2] && process.argv[2] !== name) continue
  const original = readFileSync(path, 'utf8')
  try {
    assert.ok(original.includes(before), name + ' mutation must apply')
    writeFileSync(path, original.replace(before, after))
    const { code, output } = await run(name, ['scripts/api-local.mjs', '--orchestrator'])
    assert.notEqual(code, 0, name + ' removal must fail the effect check')
    assert.match(output, /AssertionError|ERR_ASSERTION/, name + ' must fail behavior')
    assert.doesNotMatch(output, /Build failed|SyntaxError|Cannot find module/, name + ' must compile')
    console.log('PASS reverted ' + name + ': effect test fails')
  } finally { writeFileSync(path, original) }
}
const restored = await run('restored', ['scripts/api-local.mjs', '--orchestrator'])
assert.equal(restored.code, 0, restored.output)
console.log('PASS restored orchestrator suite')
