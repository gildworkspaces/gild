import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const file = 'lib/browser-challenge-poll.ts', original = readFileSync(file, 'utf8')
mkdirSync('.tmp/browser-flow-review', { recursive: true })
const run = (name, fail, effect) => {
  const r = spawnSync(process.execPath, ['--test', 'lib/browser-challenge-poll.test.ts'], { encoding: 'utf8' })
  const output = r.stdout + r.stderr
  writeFileSync(`.tmp/browser-flow-review/${name}.log`, output)
  if (fail) { assert.notEqual(r.status, 0); assert.match(output, effect) } else assert.equal(r.status, 0, output)
  console.log('PASS ' + name)
}
try {
  const terminal = 'if (response.status === 404) { stop(); expired(); return }'
  assert.ok(original.includes(terminal))
  writeFileSync(file, original.replace(terminal, 'if (false) { stop(); expired(); return }'))
  run('ignored-terminal-404', true, /terminal 404 must offer recovery/)
  const serial = 'const response = await fetch'
  assert.ok(original.includes(serial))
  writeFileSync(file, original.replace(serial, 'timer = setTimeout(poll, 1500)\n      const response = await fetch'))
  run('overlapping-status-polls', true, /pending request must not overlap another poll/)
} finally { writeFileSync(file, original) }
run('restored', false)
