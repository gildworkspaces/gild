import { test } from 'node:test'
import assert from 'node:assert/strict'
import { glob } from './search-query.ts'
import { sameTips } from './repo-refs.ts'

test('path globs keep GitHub semantics', () => {
  assert.ok(glob('*.ts').test('lib/repo.ts'))
  assert.ok(!glob('src/*.js').test('src/a/b.js'))
  assert.ok(glob('/src/**/*.js').test('src/a/b.js'))
  assert.ok(!glob('/src/*.js').test('lib/src/a.js'))
})

test('a pathological glob runs in linear time (RE2, not backtracking)', () => {
  const g = glob('a*'.repeat(40) + 'b')
  const started = Date.now()
  assert.equal(g.test('a'.repeat(5000)), false)
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started}ms`)
})

test('an index is current only when every tip matches what git advertises', () => {
  const refs = { branches: [{ name: 'main', oid: 'a' }, { name: 'dev', oid: 'b' }], tags: [{ name: 'v1', oid: 'c' }], defaultBranch: 'main', meta: 'm' }
  assert.ok(sameTips(refs, { ...refs, branches: [...refs.branches].reverse() }))
  assert.ok(!sameTips(refs, { ...refs, branches: [{ name: 'main', oid: 'z' }, { name: 'dev', oid: 'b' }] }))
  assert.ok(!sameTips(refs, { ...refs, meta: 'n' }))
  assert.ok(!sameTips(refs, { ...refs, tags: [] }))
})
