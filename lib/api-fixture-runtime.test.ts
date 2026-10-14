import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

// A fresh Worker isolate has no previous configure(url) call. Metadata writes
// must still get their disposable Git remote after Wrangler reloads the fixture.
test('API fixture resolves Git remotes in a fresh Worker isolate', async () => {
  mkdirSync('.tmp', { recursive: true })
  const outfile = resolve('.tmp/api-fixture-runtime-test.mjs')
  await build({ entryPoints: ['scripts/api-fixture/runtime.ts'], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  const runtime = await import(outfile + '?fresh=' + Date.now())
  runtime.configure({ FIXTURE_REMOTE: 'http://127.0.0.1:1234/repo.git' })
  assert.equal(await runtime.repoRemote('acme', 'demo'), 'http://127.0.0.1:1234/repo.git')
  assert.equal(await runtime.repoRemote('acme', 'other'), 'http://127.0.0.1:1234/acme-other.git')
})
