import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import type { D1Database } from '@cloudflare/workers-types'
import { d1Store } from './drivers/d1.ts'
import { repoAccess } from './repo-read.ts'
import { internalPrefix } from './import/visibility.ts'
import { refsFromAdvertisement } from './repo-refs.ts'
import { defaultAdvertisement } from './git-default.ts'

function fixture() {
  const sql = new DatabaseSync(':memory:'), queries:string[]=[]
  const db = {prepare(q:string) {
    let args:unknown[]=[]
    const statement={bind(...values:unknown[]){args=values;return statement},async first(){queries.push(q);return sql.prepare(q).get(...args as never[])??null},async run(){return {meta:{changes:Number(sql.prepare(q).run(...args as never[]).changes)}}}}
    return statement
  }} as unknown as D1Database
  return {sql,db,queries}
}
const migrations=()=>readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort()

test('import migration upgrades the live schema after the already-applied orchestrator migration',async()=>{
  const {sql,db}=fixture()
  try {
    // Exercise an upgrade beyond the live deployment watermark, 0018.
    // The shipped public-page and orchestrator migrations must remain intact
    // and the import column must arrive in a subsequent migration.
    for(const file of migrations().filter(f=>Number(f.slice(0,4))<=18 && !f.includes('import_internal_refs')))sql.exec(readFileSync('migrations/'+file,'utf8'))
    sql.exec("INSERT INTO public_asset_builds VALUES ('live-build')")
    sql.exec("INSERT INTO repo_imports VALUES ('owner/legacy','complete',0)")
    for(const file of migrations().filter(f=>Number(f.slice(0,4))>18))sql.exec(readFileSync('migrations/'+file,'utf8'))
    assert.equal(sql.prepare('SELECT internal_prefix FROM repo_imports').get()!.internal_prefix,'import/pr')
    assert.equal(await internalPrefix(db,'owner/legacy'),undefined)
    assert.equal(sql.prepare('SELECT build FROM public_asset_builds').get()!.build,'live-build')
    assert.ok(sql.prepare("SELECT name FROM sqlite_master WHERE name='fragment_heads'").get())
    assert.ok(sql.prepare("SELECT name FROM sqlite_master WHERE name='orchestrators'").get())
  } finally {sql.close()}
})

test('Git ACL reads carry only active import namespaces in one existing D1 query',async()=>{
  const {sql,db,queries}=fixture()
  try {
    for(const file of migrations())sql.exec(readFileSync('migrations/'+file,'utf8'))
    const st=d1Store(db)
    sql.exec("INSERT INTO repo_access(id,meta,acl,pending) VALUES ('stable-id',NULL,'{}',0); INSERT INTO settings_entities(key,id) VALUES ('owner/repo','stable-id'); INSERT INTO repo_imports(repository,state,updated,internal_prefix) VALUES ('owner/repo','running',0,'import_/pr')")
    const services={store:st,index:async()=>{throw Error('ACL projection must not contact the repository DO')}}
    for(const state of ['queued','running','mirroring','failed','complete','cutover','absent']) {
      if(state==='absent')sql.exec('DELETE FROM repo_imports')
      else sql.prepare('UPDATE repo_imports SET state=?').run(state)
      queries.length=0
      const access=await repoAccess(services,'Owner','repo')
      assert.equal(queries.length,3,'two existing settings reads and one ACL read; no separate namespace query')
      const expected=['queued','running','mirroring','failed'].includes(state)?'import_/pr':undefined
      assert.equal(access!.internalPrefix,expected,state)
      assert.equal(await internalPrefix(db,'OWNER/REPO'),expected,state)
      const refs=[{ref:'refs/heads/master',oid:'a'.repeat(40)},{ref:'refs/heads/import_/pr/2',oid:'b'.repeat(40)},{ref:'refs/heads/import/pr/2',oid:'c'.repeat(40)}]
      const visible=refsFromAdvertisement(refs,access!.internalPrefix).branches.map(b=>b.name)
      assert.deepEqual(visible,expected?['master','import/pr/2']:['master','import_/pr/2','import/pr/2'])
      const packet=(value:string)=>(Buffer.byteLength(value)+4).toString(16).padStart(4,'0')+value
      for(const protocol of ['v0','v2'] as const) {
        const advertisement=refs.map(r=>packet(r.oid+' '+r.ref+'\n')).join('')+'0000'
        assert.equal(defaultAdvertisement(advertisement,'master',protocol,access!.internalPrefix).includes('refs/heads/import_/pr/2'),!expected,state+' '+protocol)
      }
    }
  } finally {sql.close()}
})
