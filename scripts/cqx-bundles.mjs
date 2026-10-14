// Dry run only: inspect exactly the two deployment bundles, never upload.
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import pin from '../cqx/integrity.json' with { type: 'json' }

mkdirSync('.tmp/cqx-review', { recursive: true })
const results = []
for (const [worker, config, expected] of [
  ['main', 'wrangler.jsonc', ['core']],
  ['heavy', 'wrangler.cqx-heavy.jsonc', ['c', 'csharp']],
  ['render', 'wrangler.render.jsonc', []],
]) {
  const out = resolve(`.tmp/cqx-bundle-${worker}`)
  rmSync(out, { recursive: true, force: true })
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'deploy',
      '--dry-run',
      '--config',
      config,
      '--outdir',
      out,
    ],
    { encoding: 'utf8', timeout: 120000 },
  )
  const log = result.stdout + result.stderr
  writeFileSync(`.tmp/cqx-size-${worker}.log`, log)
  assert.equal(result.status, 0, log)
  const sizes = log.match(/Total Upload: ([\d.]+) KiB \/ gzip: ([\d.]+) KiB/)
  assert.ok(sizes, 'Wrangler must report total upload size')
  const gzipBytes = Math.ceil(Number(sizes[2]) * 1024)
  assert.ok(gzipBytes < 10_000_000, `${worker}: gzip bundle exceeds 10 MB`)
  const modules = readdirSync(out).filter((f) => f.endsWith('.wasm'))
  assert.equal(
    modules.length,
    expected.length,
    'only expected WASM modules enter the bundle',
  )
  for (const id of expected) {
    const file = modules.find((f) => f.endsWith(`-${id}.wasm`))
    assert.ok(file, `${worker}: missing ${id}`)
    assert.equal(
      createHash('sha256')
        .update(readFileSync(join(out, file)))
        .digest('hex'),
      pin.sha256[`${id}.wasm`],
    )
  }
  results.push({
    worker,
    rawKiB: Number(sizes[1]),
    gzipKiB: Number(sizes[2]),
    gzipBytes,
    modules: expected,
  })
}
const presentation = JSON.parse(readFileSync('.render/metafile.json', 'utf8'))
assert.ok(
  !Object.keys(presentation.inputs).some((path) =>
    /(?:node_modules\/(?:next|@opennextjs)|cqx\/.*\.wasm)/.test(path),
  ),
  'renderer must contain no Next/OpenNext/scorer WASM',
)
writeFileSync(
  '.tmp/cqx-review/bundles.json',
  JSON.stringify(results, null, 2) + '\n',
)
console.log(results)
