import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
const file = 'lib/profile.ts'
const original = readFileSync(file, 'utf8')
const upload = "  if (picture) return { url: picture, source: 'Uploaded' }"
const gravatar = original.match(
  /  if \(email\?\.trim\(\)\)\s+return \{ url: await avatarUrl\(email, size\), source: 'Gravatar' \}/,
)?.[0]
assert.ok(gravatar, 'Resolution mutation anchor must exist')
try {
  for (const [name, mutated, expected] of [
    [
      'upload-only behavior',
      original.replace(gravatar, ''),
      'no upload uses normalized',
    ],
    [
      'Gravatar before upload',
      original.replace(upload + '\n' + gravatar, gravatar + '\n' + upload),
      'upload wins over Gravatar',
    ],
  ]) {
    assert.notEqual(mutated, original, 'Mutation must alter the resolver')
    writeFileSync(file, mutated)
    const r = spawnSync(
      process.execPath,
      [
        '--test',
        '--test-reporter=tap',
        '--test-name-pattern=picture resolution:',
        'lib/profile.test.ts',
      ],
      { encoding: 'utf8' },
    )
    process.stdout.write(r.stdout + r.stderr)
    assert.equal(r.status, 1, 'Reverted resolution must fail with an assertion')
    assert.match(r.stdout, new RegExp('not ok.*' + expected))
    console.log(
      'Revert proof passed: ' + name + ' fails the named resolution test',
    )
  }
} finally {
  writeFileSync(file, original)
}
