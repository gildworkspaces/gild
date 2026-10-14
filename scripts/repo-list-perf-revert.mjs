import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
const path = 'lib/repo-list.ts',
  source = readFileSync(path, 'utf8')
try {
  // Revert the entire production listing path to the measured #36 baseline.
  writeFileSync(
    path,
    execFileSync('git', ['show', '9d08414:' + path], { encoding: 'utf8' }),
  )
  const result = spawnSync(
    process.execPath,
    ['scripts/repo-list-local.mjs', 'reverted'],
    { encoding: 'utf8', timeout: 120000 },
  )
  const log = result.stdout + result.stderr
  writeFileSync('.tmp/listing-perf-revert.log', log)
  if (
    result.status === 0 ||
    !log.includes('warm pages must not call a repository DO')
  )
    throw Error('Revert did not fail on the DO budget: ' + log)
  console.log(
    'Reverted owner listing fails the real workerd DO-call budget (105 != 0); production source restored',
  )
} finally {
  writeFileSync(path, source)
}
