import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
mkdirSync('.tmp', { recursive: true })
const cases = [
  {
    file: 'lib/actions/workflow.ts',
    before: "version: '1.2'",
    after: "version: '1.1'",
    test: 'Actions YAML',
  },
  {
    file: 'lib/actions/workflow.ts',
    before: "match = !p.startsWith('!')",
    after: 'match = true',
    test: 'Actions filters: branches',
  },
  {
    file: 'lib/actions/store.ts',
    before:
      "const jobs = this.jobs(r.id)\n      for (const j of jobs.filter((j) => j.status === 'queued'))",
    after: 'const jobs = this.jobs(r.id)\n      for (const j of jobs)',
    test: 'Actions one queued job',
  },
  {
    file: 'lib/actions/store.ts',
    before: "const text = maskLog(lines.join('\\n') + '\\n', masks)",
    after: "const text = lines.join('\\n') + '\\n'",
    test: 'Actions logs mask secrets',
  },
]
const evidence = []
for (const [i, c] of cases.entries()) {
  const original = readFileSync(c.file, 'utf8')
  if (!original.includes(c.before))
    throw new Error(`mutation missing: ${c.file}`)
  try {
    writeFileSync(c.file, original.replace(c.before, c.after))
    const result = spawnSync(
      'node',
      ['--test', `--test-name-pattern=${c.test}`, 'lib/actions.test.ts'],
      { encoding: 'utf8' },
    )
    writeFileSync(
      `.tmp/actions-revert-${i + 1}.log`,
      result.stdout + result.stderr,
    )
    if (result.status === 0)
      throw new Error(`test survived removed behavior: ${c.test}`)
    if (!result.stdout.includes('AssertionError'))
      throw new Error(
        `revert must fail an assertion, not load/parse: ${c.test}`,
      )
    evidence.push({
      behavior: c.test,
      exit: result.status,
      assertionFailure: true,
    })
    console.log(`${c.test}: expected assertion failure (exit ${result.status})`)
  } finally {
    writeFileSync(c.file, original)
  }
}
mkdirSync('.tmp/actions-evidence', { recursive: true })
writeFileSync(
  '.tmp/actions-evidence/revert-evidence.json',
  JSON.stringify(evidence, null, 2) + '\n',
)
