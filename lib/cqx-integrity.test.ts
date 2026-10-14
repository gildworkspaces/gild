import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { verifyArtifacts } from '../scripts/cqx-artifacts.mjs'

test('build verification rejects a corrupted module and a changed checksum inventory', async () => {
  await mkdir('.tmp', { recursive: true })
  const dir = await mkdtemp(resolve('.tmp/cqx-integrity-'))
  try {
    await cp('cqx', dir, { recursive: true })
    const url = pathToFileURL(dir + '/')
    const bytes = await readFile(dir + '/csharp.wasm')
    bytes[100] ^= 1
    await writeFile(dir + '/csharp.wasm', bytes)
    await assert.rejects(verifyArtifacts(url), /csharp.wasm: committed SHA-256 pin/)
    await cp('cqx/csharp.wasm', dir + '/csharp.wasm')
    await writeFile(dir + '/SHA256SUMS', 'untrusted inventory\n')
    await assert.rejects(verifyArtifacts(url), /SHA256SUMS: committed SHA-256 pin/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
