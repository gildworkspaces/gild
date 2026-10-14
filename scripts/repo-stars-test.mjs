import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['scripts/repo-stars-test.ts'],
  outfile: '.tmp/repo-stars-test.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
})
const result = spawnSync(
  process.execPath,
  ['--test', '.tmp/repo-stars-test.mjs'],
  { stdio: 'inherit' },
)
process.exit(result.status ?? 1)
