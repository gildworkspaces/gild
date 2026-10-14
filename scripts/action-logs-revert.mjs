import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

mkdirSync('.tmp', { recursive: true })
const cases = [
  [
    'route',
    'lib/actions/handler.ts',
    "if (op === 'jobs' && jobOp === 'logs' && !extra.length)",
    'if (false)',
  ],
  [
    'pagination',
    'lib/actions/logs.ts',
    'after = chunks[chunks.length - 1].seq',
    'break',
  ],
]
for (const [name, path, guard, removed] of cases) {
  const original = readFileSync(path, 'utf8')
  assert.ok(original.includes(guard))
  try {
    writeFileSync(path, original.replace(guard, removed))
    const result = spawnSync(
      'node',
      [
        '--test',
        '--test-name-pattern=failed job log URL',
        'lib/actions.test.ts',
      ],
      { encoding: 'utf8' },
    )
    writeFileSync(
      `.tmp/action-logs-revert-${name}.log`,
      result.stdout + result.stderr,
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stdout + result.stderr, /AssertionError/)
    console.log(
      `PASS revert: ${name} removed independently, failed job log read assertion fails; source restored`,
    )
  } finally {
    writeFileSync(path, original)
  }
}
