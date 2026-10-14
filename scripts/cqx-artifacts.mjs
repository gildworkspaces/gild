// Release bytes are vendored so builds work without a CDN or credentials.
// The committed pin, release SHA256SUMS and manifest must all agree.
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export async function verifyArtifacts(directory = new URL('../cqx/', import.meta.url)) {
  const pin = JSON.parse(await readFile(new URL('integrity.json', directory), 'utf8'))
  const bytes = new Map()
  for (const [file, expected] of Object.entries(pin.sha256)) {
    const data = await readFile(new URL(file, directory))
    assert.equal(createHash('sha256').update(data).digest('hex'), expected, `${file}: committed SHA-256 pin`)
    bytes.set(file, data)
  }
  const sums = new Map(bytes.get('SHA256SUMS').toString().trim().split('\n').map(line => [line.slice(66), line.slice(0, 64)]))
  for (const [file, hash] of Object.entries(pin.sha256)) {
    if (file !== 'SHA256SUMS') assert.equal(sums.get(file), hash, `${file}: release SHA256SUMS`)
  }
  const manifest = JSON.parse(bytes.get('manifest.json'))
  assert.equal(manifest.version, pin.version, 'release version')
  assert.equal(manifest.abi_version, 1, 'release ABI')
  for (const id of ['core', 'c', 'csharp']) {
    const entry = manifest.modules[id]
    assert.equal(entry.file, `${id}.wasm`)
    assert.equal(entry.version, pin.version)
    assert.equal(entry.abi_version, manifest.abi_version)
    assert.equal(entry.sha256, pin.sha256[entry.file], `${id}: release manifest`)
    const module = await WebAssembly.compile(bytes.get(entry.file))
    const instance = await WebAssembly.instantiate(module, { cqx: { parsing_total() {}, parsed_one() {} } })
    const { connect } = await import('../cqx/cqx-loader.mjs')
    const info = JSON.parse(connect(instance).call('cqx_module_info'))
    assert.deepEqual(info, { module: id, version: pin.version, abi_version: manifest.abi_version }, `${id}: binary identity`)
  }
  return pin.version
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`cqx ${await verifyArtifacts()}: all release checksums, manifest and binary identities verified`)
}
