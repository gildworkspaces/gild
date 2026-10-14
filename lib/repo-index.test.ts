import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { IndexStore, type SQL } from './repo-index-store.ts'
import { gitSource, indexStep, startIndex } from './repo-indexer.ts'
const base = path.resolve('.tmp'); fs.mkdirSync(base, { recursive: true })
function setup() {
  const dir = fs.mkdtempSync(path.join(base, 'index-fixture-'))
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  run('init','-b','main')
  const write = (name: string, value: string | Uint8Array) => { fs.mkdirSync(path.dirname(path.join(dir,name)), { recursive: true }); fs.writeFileSync(path.join(dir,name),value) }
  write('src/index.ts', 'export function SparseIndex() {}\nconst phrase = "hello world";\nconst truth = true;\n')
  write('src/other.rs','pub fn dispatch() {}\n// farewell\n')
  write('vendor/cache.ts','// hello world\n')
  write('image.bin',new Uint8Array([1,0,2])); write('large.txt','a'.repeat(512*1024+1))
  run('add','.'); run('-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-m','initial')
  const first = run('rev-parse','HEAD'); run('-c','tag.gpgsign=false','tag','v1')
  const db = new DatabaseSync(':memory:')
  const sql: SQL = { exec(q, ...args) { if (!args.length && q.includes(';')) { db.exec(q); return [] } return db.prepare(q).all(...args) as never } }
  const store = new IndexStore(sql), cache = {}, original = gitSource(fs, dir, cache), reads = { commits: 0, blobs: 0, trees: 0 }
  const source = { async commit(h: string) { reads.commits++; return original.commit(h) }, async tree(h: string) { reads.trees++; return original.tree(h) }, async blob(h: string) { reads.blobs++; return original.blob(h) } }
  const target = (hash: string) => ({ refs: [{ name: 'main',kind: 'branch' as const,hash },{ name:'v1',kind:'tag' as const,hash:first }], defaultBranch:'main',meta:null })
  const complete = async () => { let rounds = 0; while (!(await indexStep(store, async () => source, 2)).done) { assert.ok(++rounds < 100) } }
  return { dir, run, write, first, db, store, reads, target, complete }
}
test('real git fixture: resumable index, tree/file/log/languages and incremental objects', async () => {
  const f = setup(); startIndex(f.store,f.target(f.first)); await f.complete()
  const root = f.store.commit(f.first)!.tree
  assert.equal(f.store.tree(root)?.find((e) => e.name === 'src')?.type, 'tree')
  assert.equal(f.store.file('src/index.ts','main')?.content?.kind,'text')
  assert.equal(f.store.file('image.bin')?.content?.kind,'binary'); assert.equal(f.store.file('large.txt')?.content?.kind,'large')
  assert.equal(f.store.log(f.first)[0].message.trim(),'initial')
  assert.equal(f.store.languages(root)?.find((l) => l.name === 'TypeScript')?.share,0.5)
  const before = f.store.counts(), reads = { ...f.reads }
  startIndex(f.store,f.target(f.first)); await f.complete(); assert.deepEqual(f.store.counts(),before); assert.deepEqual(f.reads,reads)
  f.write('src/new.go','package demo\nfunc Added() {}\n'); f.run('add','.'); f.run('-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-m','new file')
  const second = f.run('rev-parse','HEAD'); startIndex(f.store,f.target(second)); await f.complete()
  assert.equal(f.store.counts().commits,before.commits+1); assert.equal(f.store.counts().blobs,before.blobs+1)
  assert.equal(f.reads.blobs,reads.blobs+1); assert.equal(f.reads.commits,reads.commits+1)
  assert.equal(f.store.log(second).length,2); assert.ok(f.store.findFiles('nwgo').some((f) => f.path === 'src/new.go'))
  f.db.close()
})
test('search fixture: paths, lines, phrases, regex, boolean, language, symbols and FTS ref scope', async () => {
  const f = setup(); startIndex(f.store,f.target(f.first)); await f.complete()
  const context = { repo:'acme/demo',ownerKind:'org' as const }
  const search = (q: string) => f.store.search(q,context)
  assert.equal(search('sparse').hits[0].path,'src/index.ts'); assert.equal(search('sparse').hits[0].lines[0].line,1)
  assert.equal(search('"hello world" NOT is:vendored').hits[0].lines[0].line,2)
  assert.equal(search('/const.*truth/').hits[0].lines[0].line,3)
  assert.equal(search('language:rust symbol:disp').hits[0].path,'src/other.rs')
  assert.equal(search('path:*.ts NOT path:vendor').count,1)
  assert.equal(search('sparse OR farewell').count,2)
  assert.equal(search('content:index.ts').count,0)
  assert.equal(search('repo:another/repo').count,0)
  assert.equal(search('symbol:/dispatch/').hits[0].lines[0].line,1)
  assert.equal(f.store.findSymbols('disp')[0].path, 'src/other.rs')
  f.write('src/new.go','package demo\nfunc Added() {}\n'); f.run('add','.'); f.run('-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-m','add symbol')
  startIndex(f.store,f.target(f.run('rev-parse','HEAD'))); await f.complete()
  assert.equal(search('Added ref:v1').count,0); assert.equal(search('Added ref:main').hits[0].lines[0].line,2)
  assert.equal(search('symbol:Added branch:main').count,1); assert.equal(search('Added ref:v1 OR Added ref:main').count,1)
  f.db.close()
})
test('_meta issues, pulls, comments/reviews/logs and ref deletion are indexed by tip', async () => {
  const f = setup(); startIndex(f.store,f.target(f.first)); await f.complete()
  f.run('checkout','--orphan','_meta'); f.run('rm','-r','--cached','.')
  const issue = { number:1,title:'Find indexed code',body:'Please search',author:'ava',state:'open',labels:[],claim:null }
  const pull = { number:2,title:'Index',head:'feature',base:'main',state:'open' }
  const meta = { schema:1,issues:[issue],pulls:[pull],queue:[2] }
  f.write('.gild/index.json',JSON.stringify(meta)); f.write('.gild/queue.json','[2]')
  f.write('.gild/1/issue/issue.json',JSON.stringify(issue)); f.write('.gild/1/issue/c-1-a.json',JSON.stringify({body:'first'})); f.write('.gild/1/log/1-a.json',JSON.stringify({kind:'opened'}))
  f.write('.gild/2/pr/pr.json',JSON.stringify(pull)); f.write('.gild/2/pr/r-1-a.json',JSON.stringify({verdict:'approve'}))
  f.run('add','.gild'); f.run('-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-m','metadata')
  const tip = f.run('rev-parse','HEAD')
  startIndex(f.store,{...f.target(f.first),refs:[{name:'main',kind:'branch',hash:f.first}],meta:tip}); await f.complete()
  assert.deepEqual(JSON.parse(f.store.metaFile('.gild/index.json')!),meta)
  assert.deepEqual(f.store.metaItem(1,'issue')?.item,issue)
  assert.equal(f.store.metaItem(1,'issue')?.comments[0].body,'first'); assert.equal(f.store.metaItem(1,'issue')?.log[0].kind,'opened')
  assert.equal(f.store.metaItem(2,'pr')?.reviews[0].verdict,'approve'); assert.deepEqual(f.store.metaItem(2,'pr')?.queue,[2])
  assert.equal(f.store.resolve('v1'),null); assert.equal(f.store.refs().length,1)
  assert.equal(f.store.search('Please search',{repo:'acme/demo',ownerKind:'org'}).count,0,'forge metadata never enters code search')
  f.db.close()
})
test('unicode61 fallback preserves substrings, punctuation, Unicode and file paths', async () => {
  const f = setup()
  const db = new DatabaseSync(':memory:')
  const sql: SQL = { exec(q,...args) {
    if (q.includes("tokenize='trigram'")) throw new Error('trigram unavailable')
    if (!args.length && q.includes(';')) { db.exec(q); return [] }
    return db.prepare(q).all(...args) as never
  } }
  const store = new IndexStore(sql)
  const source = gitSource(fs,f.dir,{})
  startIndex(store,f.target(f.first)); while (!(await indexStep(store,async () => source,3)).done) {}
  assert.equal(store.trigram,false)
  const context = {repo:'acme/demo',ownerKind:'org' as const}
  assert.equal(store.search('parseInd',context).hits[0].path,'src/index.ts')
  assert.equal(store.search('"SparseIndex()"',context).count,1)
  assert.equal(store.search('path:other.rs',context).count,1)
  assert.equal(store.search('sparse OR farewell NOT path:vendor',context).count,2)
  db.close(); f.db.close()
})
test('history sizes are cached by tree without flattening intermediate commits', async () => {
  const f = setup()
  f.write('src/middle.go','package demo\nfunc Middle() {}\n'); f.run('add','.'); f.run('-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-m','middle')
  const middle = f.run('rev-parse','HEAD')
  f.write('src/last.go','package demo\nfunc Last() {}\n'); f.run('add','.'); f.run('-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-m','last')
  startIndex(f.store,f.target(f.run('rev-parse','HEAD'))); await f.complete()
  const root = f.store.commit(middle)!.tree
  const flatBefore = f.store.counts().files
  assert.equal(f.store.sizes(root)?.find((f) => f.path === 'src/middle.go')?.lines,2)
  assert.ok(!f.store.sizes(root)?.some((f) => f.path === 'src/last.go'))
  assert.equal(f.store.counts().files,flatBefore)
  assert.equal(f.store.search('sparse branch:v1',{repo:'acme/demo',ownerKind:'org'}).count,0)
  assert.equal(f.store.search('sparse ref:V1',{repo:'acme/demo',ownerKind:'org'}).count,1)
  f.db.close()
})
test('pagination and facets count files sharing a blob, with Unicode content', async () => {
  const f = setup()
  for (let i=0;i<25;i++) f.write(`pages/page-${String(i).padStart(2,'0')}.txt`,'pagination-token\n')
  f.write('pages/unicode.txt','CAFÉ ÜBER\n')
  f.run('add','.'); f.run('-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-m','pages')
  startIndex(f.store,f.target(f.run('rev-parse','HEAD'))); await f.complete()
  const context = {repo:'acme/demo',ownerKind:'org' as const}
  const first = f.store.search('pagination-token',context), next = f.store.search('pagination-token',context,undefined,20,20)
  assert.equal(first.count,25); assert.equal(first.hits.length,20); assert.equal(next.hits.length,5); assert.equal(next.hits[0].path,'pages/page-20.txt')
  assert.equal(first.languages.Other,25); assert.equal(first.paths.pages,25)
  assert.equal(f.store.search('café ÜB',context).hits[0].path,'pages/unicode.txt')
  assert.equal(f.store.search('language:Other content:café',context).count,1)
  assert.equal(f.store.counts().blobs,7,'all 25 page paths share a single indexed blob')
  assert.equal(f.store.counts().blob_fts,5,'binary and >512KB blobs are excluded')
  f.db.close()
})
test('an observed tip superseded during backfill keeps its flattened files', async () => {
  const f = setup()
  f.write('middle.txt','middle\n'); f.run('add','.'); f.run('-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-m','middle')
  const middle = f.run('rev-parse','HEAD'); startIndex(f.store,f.target(middle))
  f.write('last.txt','last\n'); f.run('add','.'); f.run('-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-m','last')
  const last = f.run('rev-parse','HEAD'); startIndex(f.store,f.target(last)); await f.complete()
  assert.equal(f.store.resolve('main'),last)
  assert.equal(f.store.counts().files,18,'all three observed tips have flattened snapshots')
  assert.equal(f.store.search(`middle ref:${middle}`,{repo:'acme/demo',ownerKind:'org'}).count,1)
  f.db.close()
})
test('ancestors are recorded from commit info, without fetching or walking their snapshots', async () => {
  const f = setup()
  f.write('src/extra.ts', 'export const two = 2\n'); f.run('add', '.'); f.run('-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-m','second')
  const tip = f.run('rev-parse', 'HEAD')
  const fetched: string[] = [], infos: string[] = []
  const all = gitSource(fs, f.dir, {})
  // Only the main tip is a tip here (no tag), so `first` is an ancestor.
  startIndex(f.store, { refs: [{ name: 'main', kind: 'branch', hash: tip }], defaultBranch: 'main', meta: null })
  let rounds = 0
  while (!(await indexStep(f.store, async (h) => { fetched.push(h); return all }, 50, Infinity, async (h) => { infos.push(h); return all.commit(h) })).done) assert.ok(++rounds < 100)
  assert.deepEqual([...new Set(fetched)], [tip])
  assert.deepEqual(infos, [f.first])
  assert.equal(f.store.log(tip).length, 2)
  assert.equal(f.store.file('src/extra.ts', 'main')?.content?.kind, 'text')
})
