import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseQuery, matches, glob, snippets, type Document } from './search-query.ts'
const d: Document = { repo: 'acme/demo', ownerKind: 'org', ref: 'feature/x', path: 'src/nested/index.ts', language: 'TypeScript', content: 'const name = "Ava";\nexport function SparseIndex() {}\nC:\\code\nTrue\n', symbols: [{ name: 'SparseIndex', kind: 'function', line: 2 }] }
const check = (q: string, expected = true, doc = d) => assert.equal(matches(parseQuery(q).query, doc), expected, q)
for (const q of ['sparse index', 'SPARSE AND INDEX', 'index.ts', '"name = \\"Ava\\""'.replaceAll('\\\\','\\'), '"C:\\\\code"', '/sparse.*index/', '/(?-i)True/', '(NO OR sparse) AND NOT absent', 'repo:acme/demo', 'org:acme', 'language:"TypeScript"', 'path:src', 'path:*.ts', 'path:/src/**/*.ts', 'path:/nested\\/index\\.ts$/', 'content:sparse', 'symbol:Sparse', 'symbol:/^SparseIndex$/', 'branch:feature/x', 'ref:feature/x']) {
  test(`query matches ${q}`, () => check(q))
}
for (const q of ['user:acme', 'repo:acme/other', 'language:rust', 'path:src/*.ts', 'content:index.ts', '/(?-i)true/', 'NOT sparse', 'is:vendored', 'is:generated']) test(`query excludes ${q}`, () => check(q, false))
test('boolean precedence is NOT then AND then OR', () => { check('absent AND sparse OR index'); check('absent AND (sparse OR index)', false); check('NOT (absent OR sparse)', false) })
test('path literal disables glob; leading slash anchors glob', () => { check(String.raw`path:/^[^\/]+$/`, false); check(String.raw`path:/^[^\/]+$/`, true, { ...d, path: 'index.ts' }); check('path:"*.ts"', false); assert.ok(glob('src/*.js').test('app/src/a.js')); assert.ok(!glob('/src/*.js').test('app/src/a.js')); assert.ok(glob('/src/**/*.js').test('src/a.js')); assert.ok(glob('/src/**/*.js').test('src/nested/a.js')); assert.ok(!glob('src/*.js').test('src/nested/a.js')); assert.ok(glob('*.a?c').test('file.abc')) })
test('generated and vendored predicates', () => { check('is:vendored', true, { ...d, path: 'vendor/a.ts' }); check('is:vendored', true, { ...d, path: 'node_modules/a.ts' }); check('is:generated', true, { ...d, path: 'dist/a.js' }); check('is:generated', true, { ...d, content: '// @generated\nhello' }) })
test('invalid syntax falls back to exact string including punctuation', () => {
  for (const q of ['printf("hello world\\n");', 'foo AND', '"unclosed', '/(?=foo)/', '/[bad/', 'unknown:foo', 'foo(bar)', 'content:"foo"bar']) {
    assert.ok(parseQuery(q).fallback, q); check(q, true, { ...d, content: q })
  }
})
test('snippets report the content line and matching range', () => { assert.deepEqual(snippets(parseQuery('sparse').query, d)[0], { line: 2, text: 'export function SparseIndex() {}', ranges: [[16,22]] }); assert.equal(snippets(parseQuery('symbol:Sparse').query, d)[0].line, 2) })

test('regex spaces and quoted language names', () => { check('path:/nested index/',false); check('language:"Protocol Buffers"',true,{...d,language:'Protocol Buffers'}); check('content:/hello world/',true,{...d,content:'hello world'}) })
