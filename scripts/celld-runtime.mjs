// Run a local fixture Worker on celld (https://celld.dev) instead of
// `wrangler dev`, so the same gates exercise the self-hosted Workers runtime.
// Opt in with GILD_TEST_RUNTIME=celld (test tooling only). Needs `celld` on
// PATH (or CELLD_BIN) and a fleet bucket: CELLD_BUCKET plus
// S3_ENDPOINT and AWS_* for an S3-compatible store. Each run deploys under its
// own bucket prefix, so runs never share state. See docs/self-host-celld.md.
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { celldConfig } from './celld-config.mjs'
import { bundleForCelld } from './celld-bundle.mjs'

export const celldRuntime = process.env.GILD_TEST_RUNTIME === 'celld'

const freePort = () =>
  new Promise((resolvePort) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })

/** Deploy `config` (a wrangler.json the harness wrote) to a fresh bucket
 *  prefix, start one celld node on `port`, apply `schema` to `database`, and
 *  return the node process once it serves. */
export async function startCelld({ config, port, schema, database }) {
  const bin = process.env.CELLD_BIN || 'celld',
    fleet = process.env.CELLD_BUCKET
  if (!fleet) throw new Error('GILD_TEST_RUNTIME=celld needs CELLD_BUCKET')
  const bucket = `${fleet.replace(/\/+$/, '')}/gild-test-${randomBytes(6).toString('hex')}`,
    cwd = dirname(config),
    wrangler = JSON.parse(readFileSync(config, 'utf8'))
  // Prebuilt like production (scripts/celld-build.mjs), so the gate runs the
  // same bridged bundle shape that a self-hosted deployment runs.
  await bundleForCelld({ entry: resolve(cwd, wrangler.main), outfile: join(cwd, 'celld', 'worker.mjs') })
  wrangler.main = './celld/worker.mjs'
  wrangler.no_bundle = true
  writeFileSync(config, JSON.stringify(celldConfig(wrangler), null, 2))
  execFileSync(bin, ['deploy', basename(config), '--bucket', bucket], { cwd, stdio: 'pipe' })
  const node = spawn(
    bin,
    ['--bucket', bucket, '--listen', `127.0.0.1:${port}`, '--internal-listen', `127.0.0.1:${await freePort()}`],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let log = ''
  node.stderr.on('data', (b) => (log += b))
  node.stdout.on('data', (b) => (log += b))
  for (let i = 0; ; i++) {
    if (node.exitCode !== null) throw new Error('celld exited before serving\n' + log)
    if (i > 300) throw new Error('celld did not serve within 30 s\n' + log)
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })
      break
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  if (schema)
    execFileSync(bin, ['d1', 'execute', database, basename(config), '--file', schema, '--bucket', bucket], { cwd, stdio: 'pipe' })
  return node
}
