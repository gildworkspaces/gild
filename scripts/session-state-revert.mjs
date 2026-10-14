import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const file = 'lib/api/sessions-contract.ts'
const source = readFileSync(file, 'utf8')
try {
  writeFileSync(file, source.replace('    state: sessionState.optional(),\n', ''))
  const result = spawnSync('node', ['--test', '--test-name-pattern=live state persists', 'lib/sessions.test.ts'], { encoding: 'utf8' })
  if (result.status === 0 || !result.stdout.includes('✖')) throw Error('Reverted contract did not fail its assertion')
  console.log('State persistence test fails with optional state field reverted (exit ' + result.status + ')')
} finally { writeFileSync(file, source) }
