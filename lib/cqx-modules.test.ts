import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { scoreFiles, scoreNote, CATEGORIES } from './cqx-wasm.ts'
import { BUILD, checked, loadModule, snapshot, type HeavyBinding } from './cqx-module.ts'
import { HEAVY_MAX_BYTES, HEAVY_MAX_FILES, heavyWithinLimits } from './cqx-heavy-limits.ts'
import { createLoader } from '../cqx/cqx-loader.mjs'
import manifest from '../cqx/manifest.json' with { type: 'json' }
import pin from '../cqx/integrity.json' with { type: 'json' }

const c = [{ path: 'CMakeLists.txt', text: 'add_library(demo src/lib.c)' },
  { path: 'src/lib.c', text: '#include <stdio.h>\nvoid format(char *out, const char *s) { sprintf(out, "%s", s); }\n' }]
const ts = [{ path: 'package.json', text: '{"name":"demo"}' },
  { path: 'src/index.ts', text: 'export function unsafe() { eval("hello") }\n' }]
const cs = [{ path: 'src/Demo.csproj', text: '<Project Sdk="Microsoft.NET.Sdk" />' },
  { path: 'src/Demo.cs', text: 'public class Demo { public static void Quit() { System.Environment.Exit(1); } }\n' }]

/** Real release WASM; only the RPC transport is in-process for unit tests. */
function transport() {
  const calls: string[] = [], disposed: string[] = []
  const binding: HeavyBinding = {
    async open(id, files, label, build) {
      assert.equal(build, BUILD)
      calls.push(id)
      assert.ok(files.every(f => id === 'c' ? /\.(c|h|cpp|hpp|C|H)$/.test(f.path) : /\.cs$/.test(f.path)))
      const host = loadModule(await WebAssembly.compile(await readFile(`cqx/${id}.wasm`)), id)
      snapshot(host, label, files)
      return {
        async gather(metadata) { return checked(host.call('cqx_gather', metadata), 'gather') },
        async emit(shared) { return checked(host.call('cqx_emit', shared), 'emit') },
        async quote(report) { return checked(host.call('cqx_quote', report), 'quote') },
        [Symbol.dispose]() { disposed.push(id) },
      }
    },
  }
  return { binding, calls, disposed }
}

test('C-only repository routes to heavy WASM and reports the unsafe call with source', async () => {
  const t = transport()
  const report = await scoreFiles(c, null, 'demo', t.binding)
  assert.deepEqual(t.calls, ['c'])
  assert.deepEqual(t.disposed, ['c'])
  assert.ok(report.lines > 0)
  const hit = report.rules.find(r => r.language === 'c' && r.rule === 'unsafe-buffer-calls')!
  assert.ok(hit.deducted > 0)
  assert.ok(hit.findings.some(f => f.text?.includes('sprintf(')))
})

test('TS-only repository never invokes the binding', async () => {
  const report = await scoreFiles(ts, null, 'demo', { open() { assert.fail('TS must not invoke heavy binding') } })
  assert.equal(report.lines, 1)
  assert.ok(report.rules.some(r => r.language === 'typescript' && r.rule === 'dynamic-code' && r.deducted > 0))
})

test('uppercase C++ source uses the C module and reports C++ findings', async () => {
  const t = transport()
  const files = [
    { path: 'CMakeLists.txt', text: 'add_library(demo src/lib.C)' },
    { path: 'src/lib.C', text: '#include <cstdio>\nvoid format(char *out, const char *s) { sprintf(out, "%s", s); }\n' },
  ]
  const report = await scoreFiles(files, null, 'demo', t.binding)
  assert.deepEqual(t.calls, ['c'])
  assert.ok(report.rules.some(r => r.language === 'cpp' && r.rule === 'unsafe-buffer-calls' && r.findings.some(f => f.text?.includes('sprintf('))))
})

test('C# selects only csharp; both heavy instances are released in a mixed scan', async () => {
  const t = transport()
  const report = await scoreFiles([...c, ...cs, ...ts], null, 'demo', t.binding)
  assert.deepEqual(t.calls, ['c', 'csharp'])
  assert.deepEqual(t.disposed, ['c', 'csharp'])
  assert.ok(report.rules.some(r => r.language === 'csharp' && r.total_findings > 0))
})

test('distributed phases match the official release loader, including config and quotes', async () => {
  const files = [...c, ...cs, ...ts]
  const config = '{"rules":{"c/unsafe-buffer-calls":{"weight":7}}}'
  const loader = createLoader({ manifest, manifestSha256: pin.sha256['manifest.json'], fetchBytes: file => readFile(`cqx/${file}`) })
  const expected = JSON.parse((await loader.scan(files.map(f => [f.path, f.text]), { repo: 'demo', config })).reportJson)
  const actual = await scoreFiles(files, config, 'demo', transport().binding)
  assert.deepEqual(actual.scores, expected.scores)
  assert.deepEqual(actual.rules, expected.rules)
  assert.deepEqual(actual.languages, expected.languages)
  assert.equal(actual.calibrated, true)
})

test('heavy failure preserves only core scores and disposes already-opened sessions', async () => {
  const t = transport()
  const report = await scoreFiles([...c, ...cs, ...ts], null, 'demo', {
    async open(id, ...args) {
      if (id === 'csharp') throw new Error('heavy unavailable')
      return t.binding.open(id, ...args)
    },
  })
  assert.equal(report.incomplete, 'c-family-unavailable')
  assert.equal(report.lines, 1)
  assert.deepEqual(report.scores, (await scoreFiles(ts, null, 'demo')).scores)
  assert.ok(report.rules.every(r => !['c', 'cpp', 'csharp'].includes(r.language)))
  assert.match(scoreNote(report)!, /C\/C\+\+\/C# couldn’t be scored right now.*Partial score/)
  assert.deepEqual(t.disposed, ['c'])
})

test('mixed headline uses release per-language product lines', async () => {
  const report = await scoreFiles([...c, ...ts], null, 'demo', transport().binding)
  assert.ok(report.languages, 'release report must expose languages (cqx #74)')
  assert.deepEqual(Object.keys(report.languages).sort(), ['c', 'typescript'])
  const parts = Object.values(report.languages)
  const lines = parts.reduce((n, p) => n + p.lines, 0)
  for (const category of CATEGORIES)
    assert.equal(report.scores[category], Math.round(parts.reduce((n, p) => n + p.lines * p.scores[category], 0) / lines))
})

for (const phase of ['open', 'gather', 'emit', 'quote'] as const) test(`heavy ${phase} outage leaves other-language findings and a partial note`, async () => {
  const t = transport()
  const report = await scoreFiles([...c, ...ts], null, 'demo', {
    async open(...args) {
      if (phase === 'open') throw new Error('BUILD mismatch')
      const session = await t.binding.open(...args)
      return { ...session, [phase]: async () => { throw new Error('heavy limit/outage') } }
    },
  })
  assert.equal(report.incomplete, 'c-family-unavailable')
  assert.equal(report.lines, 1)
  assert.ok(report.rules.some(r => r.rule === 'dynamic-code' && r.deducted > 0))
  assert.ok(report.rules.every(r => !['c', 'cpp', 'csharp'].includes(r.language)))
  assert.match(scoreNote(report)!, /Partial score: other languages only/)
  assert.deepEqual(t.disposed, phase === 'open' ? [] : ['c'])
})

test('C-only heavy outage has no scored lines or C-family scores', async () => {
  const report = await scoreFiles(c, null, 'demo', { async open() { throw new Error('outage') } })
  assert.equal(report.lines, 0)
  assert.equal(report.incomplete, 'c-family-unavailable')
  assert.equal(report.rules.length, 0)
  assert.equal(report.languages, undefined)
})

for (const dimension of ['files', 'bytes', 'combined'] as const) test(`synthetic ${dimension} over-limit repo never invokes heavy RPC`, async () => {
  const files = dimension === 'files'
    ? Array.from({ length: HEAVY_MAX_FILES + 1 }, (_, i) => ({ path: `src/f${i}.c`, text: 'int n;\n' }))
    : dimension === 'bytes'
      ? [{ path: 'src/huge.c', text: 'é'.repeat(HEAVY_MAX_BYTES / 2 + 1) }]
      : [{ path: 'src/huge.c', text: ' '.repeat(HEAVY_MAX_BYTES / 2 + 1) }, { path: 'src/huge.cs', text: ' '.repeat(HEAVY_MAX_BYTES / 2) }]
  const report = await scoreFiles([...files, ...ts], null, 'demo', { open() { assert.fail('over-limit source must never reach RPC') } })
  assert.equal(report.incomplete, 'c-family-too-large')
  assert.equal(report.lines, 1)
  assert.match(scoreNote(report)!, /too large to score C-family here/)
  assert.ok(report.rules.some(r => r.language === 'typescript' && r.rule === 'dynamic-code'))
})

test('heavy limits admit the exact file and UTF-8 byte boundaries', () => {
  assert.ok(heavyWithinLimits(Array.from({ length: HEAVY_MAX_FILES }, () => ({ path: 'a.c', text: '' }))))
  assert.ok(heavyWithinLimits([{ path: 'a.cs', text: 'é'.repeat(HEAVY_MAX_BYTES / 2) }]))
})

test('over-limit C-family stays explicit even when the core has no Cargo manifest', async () => {
  const report = await scoreFiles([{ path: 'large.c', text: ' '.repeat(HEAVY_MAX_BYTES + 1) }, { path: 'src/lib.rs', text: 'pub fn demo() {}' }], null, 'demo', { open() { assert.fail('must reject before RPC') } })
  assert.equal(report.incomplete, 'c-family-too-large')
})
