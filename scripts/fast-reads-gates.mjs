// Same gates as .github/workflows/{api,theme}.yml, with logs kept in this lane.
import { spawnSync } from 'node:child_process'
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const dir = resolve('.tmp/fast-reads-2')
mkdirSync(dir, { recursive: true })
const gates = [
  ['install', ['install', '--frozen-lockfile']],
  ['test', ['run', 'test']], ['types', ['x', 'tsc', '--noEmit']],
  ...['privacy', 'privacy:revert', 'repo-list:perf', 'api', 'events', 'sessions']
    .map(name => [name, ['run', 'test:' + name]]),
  ['build', ['run', 'build:cloudflare']],
  ...['import:revert', 'import', 'privacy:web', 'fragments', 'cqx:bundles', 'cqx:local', 'runners:local', 'theme']
    .map(name => [name, ['run', 'test:' + name]]),
]
const resume = process.argv.indexOf('--from')
const start = resume < 0 ? 0 : gates.findIndex(([name]) => name === process.argv[resume+1])
if(start < 0) throw Error('Unknown gate')
const results = start ? JSON.parse(readFileSync(`${dir}/gates.json`,'utf8')).slice(0,start) : []
for (const [name, args] of gates.slice(start)) {
  console.log('Running CI gate:', name)
  const fd = openSync(`${dir}/gate-${name.replaceAll(':', '-')}.log`, 'w')
  const at = Date.now()
  const result = spawnSync('bun', args, { stdio: ['ignore', fd, fd], env: { ...process.env,
    GIT_AUTHOR_NAME: 'Gild API fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Gild API fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
    TMPDIR: resolve('.tmp'), GILD_TEST_CLI_DIR: resolve(dir, 'cli-ci') } })
  closeSync(fd)
  results.push({ name, seconds: (Date.now() - at) / 1000, status: result.status, error: result.error?.message })
  writeFileSync(`${dir}/gates.json`, JSON.stringify(results, null, 2))
  console.log(name, result.status === 0 ? 'PASS' : 'FAIL', results.at(-1).seconds + 's')
  if (result.status !== 0) process.exit(result.status ?? 1)
}
