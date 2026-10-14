// Revert proof for #65: rebuild the real Worker with the Actions page and
// RunQueue resolution from the pre-fix baseline, require the round-trip gate
// to fail, then restore and rebuild. Originals are restored on any failure.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
mkdirSync('.tmp', { recursive: true })
const baseline = '8791cb7'
const files = ['app/(portal)/[owner]/[repo]/actions/page.tsx', 'lib/actions/service.ts', 'components/repo/Actions.tsx', 'scripts/actions-browser-entry.tsx']
const originals = new Map(files.map((p) => [p, readFileSync(p, 'utf8')]))
const run = (name, args) => {
  const r = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024 })
  writeFileSync(`.tmp/actions-page-perf-revert-${name}.log`, r.stdout + r.stderr)
  return r
}
const build = (name) => assert.equal(run(name, ['bun', 'run', 'build:cloudflare']).status, 0, name + ': production build must pass')
try {
  for (const p of files) writeFileSync(p, execFileSync('git', ['show', `${baseline}:${p}`], { encoding: 'utf8' }))
  build('build-reverted')
  const r = run('gate', [process.execPath, 'scripts/actions-page-perf.mjs', 'reverted'])
  const log = r.stdout + r.stderr
  assert.notEqual(r.status, 0, 'reverted Actions page must fail the round-trip gate')
  assert.match(log, /RunQueue round trips: [2-9]\d* != 1/)
  console.log('PASS revert: pre-fix Actions page fails the RunQueue round-trip budget: ' + log.match(/RunQueue round trips: \d+ != 1/)[0])
} finally {
  for (const [p, text] of originals) writeFileSync(p, text)
  build('build-restored')
}
