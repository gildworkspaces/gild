import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
mkdirSync('.tmp', { recursive: true })
const file = 'lib/settings.ts',
  original = readFileSync(file, 'utf8')
function withoutGuard(marker) {
  const at = original.indexOf('// ' + marker)
  if (at < 0) throw Error('Mutation marker missing: ' + marker)
  const tail = original.slice(at),
    match = /if\s*\(/.exec(tail)
  if (!match) throw Error('Guard missing: ' + marker)
  const start = at + match.index + match[0].length
  let depth = 1,
    end = start
  for (; end < original.length; end++) {
    if (original[end] === '(') depth++
    if (original[end] === ')' && --depth === 0) break
  }
  if (depth !== 0) throw Error('Unbalanced guard')
  return original.slice(0, start) + 'false' + original.slice(end)
}
const mutations = [
  ['admin guard', () => withoutGuard('SETTINGS_ADMIN_GUARD')],
  ['last-owner guard', () => withoutGuard('SETTINGS_LAST_OWNER_GUARD')],
  [
    'owner guard',
    () => {
      const pattern =
        /(orgAccess|repoAccess)\(st,\s*(org|owner),\s*name,\s*danger\)/g
      if ([...original.matchAll(pattern)].length !== 2)
        throw Error('Owner guard anchors missing')
      return original.replace(pattern, '$1(st, $2, name, false)')
    },
  ],
]
try {
  for (const [name, mutate] of mutations) {
    writeFileSync(file, mutate())
    const r = spawnSync(
      process.execPath,
      ['--test', `--test-name-pattern=${name}`, 'lib/settings.test.ts'],
      { encoding: 'utf8' },
    )
    writeFileSync(
      '.tmp/settings-revert-' + name.replaceAll(' ', '-') + '.log',
      r.stdout + r.stderr,
    )
    if (r.status === 0) throw Error(name + ' mutation survived')
    if (!r.stdout.includes('AssertionError') && !r.stdout.includes('✖'))
      throw Error('Unexpected failure: ' + r.stdout + r.stderr)
    console.log(
      name +
        ': named regression test FAILS with guard removed (exit ' +
        r.status +
        ')',
    )
  }
} finally {
  writeFileSync(file, original)
}

const regressions = [
  [
    'cron wiring',
    'wrangler.jsonc',
    (source) => {
      const config = JSON.parse(source)
      delete config.triggers
      return JSON.stringify(config)
    },
    'scheduled cron wiring',
  ],
  [
    'upload-pack',
    'lib/settings-http.ts',
    (source) =>
      source.replace(
        /  const mutable = git[\s\S]*?\n  const runnerRead/,
        "  const mutable = !['GET', 'HEAD', 'OPTIONS'].includes(request.method) || url.searchParams.get('service') === 'git-receive-pack'\n  const runnerRead",
      ),
    'archived and moving repositories',
  ],
  [
    'cookie CSRF',
    'lib/settings-http.ts',
    (source) =>
      source.replace(
        "url.pathname.startsWith('/api/') &&",
        "false && url.pathname.startsWith('/api/') &&",
      ),
    'CSRF gate refuses',
  ],
]
for (const [name, path, mutate, pattern] of regressions) {
  const source = readFileSync(path, 'utf8')
  try {
    const changed = mutate(source)
    if (changed === source) throw Error(name + ': mutation anchor missing')
    writeFileSync(path, changed)
    const r = spawnSync(
      process.execPath,
      ['--test', '--test-name-pattern=' + pattern, 'lib/settings.test.ts'],
      { encoding: 'utf8' },
    )
    writeFileSync(
      '.tmp/settings-revert-' + name.replaceAll(' ', '-') + '.log',
      r.stdout + r.stderr,
    )
    if (r.status === 0 || !r.stdout.includes('AssertionError'))
      throw Error(name + ': no effect-test failure: ' + r.stdout + r.stderr)
    console.log(
      name +
        ': named effect test FAILS with fix removed (exit ' +
        r.status +
        ')',
    )
  } finally {
    writeFileSync(path, source)
  }
}
const fixed = spawnSync(process.execPath, ['--test', 'lib/settings.test.ts'], {
  encoding: 'utf8',
})
writeFileSync('.tmp/settings-fixed.log', fixed.stdout + fixed.stderr)
if (fixed.status !== 0) throw Error(fixed.stdout + fixed.stderr)
console.log('Restored implementation: all settings tests PASS')
