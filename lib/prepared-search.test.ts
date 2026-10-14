import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {readFileSync,readdirSync} from 'node:fs'
import {d1Store} from './drivers/d1.ts'
import {entity} from './settings-store.ts'
import {publishPreparedCatalogue} from './prepared-catalogue-producer.ts'
import {fencePreparedRefs,preparedRefsEpoch,publishPreparedRefs} from './prepared-repository-producer.ts'
import {PreparedSearch,SEARCH_CANDIDATE_LIMIT,searchCandidateFilter} from './prepared-search.ts'
import {publishPreparedSearch,stagePreparedSearchDocuments,publishPreparedSearchReceipt,searchSnapshotKey,type SearchDocument,type SearchSnapshot} from './prepared-search-producer.ts'
import {PreparationPending} from './prepared-read-models.ts'
import {parseQuery} from './search-query.ts'
import type {Principal} from './api/scopes.ts'
import {Miniflare} from 'miniflare'
import {dispatch,paginate,paginationOffset,type Dependencies} from './api/dispatch.ts'
import {ApiControlStore} from './api/control-store.ts'
import {hashToken,verifyStoredToken} from './token-verifier.ts'

const SHA='a'.repeat(40),BLOB='b'.repeat(40)
const principal=(name='alice',repos:Principal['repos']=null,scopes:Principal['scopes']=null):Principal=>({name,id:name,publicKey:'fixture',repos,scopes})
const document=(path='src/main.ts',content='export function hello() { return "secret searchable" }'):SearchDocument=>({path,blob:BLOB,language:'TypeScript',content,symbols:[{name:'hello',kind:'function',line:1}]})
async function fixture(){
  const db=new DatabaseSync(':memory:')
  for(const file of readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync('migrations/'+file,'utf8'))
  let readonly=false,queries=0,materialized=0
  const statements:{query:string;args:any[]}[]=[]
  const prepare=(query:string,args:any[]=[])=>({
    bind:(...args:any[])=>prepare(query,args),
    async first(){queries++;statements.push({query,args});if(readonly)assert.match(query,/^\s*(SELECT|WITH)/);return db.prepare(query).get(...args)??null},
    async all(){queries++;statements.push({query,args});if(readonly)assert.match(query,/^\s*(SELECT|WITH)/);const results=db.prepare(query).all(...args);materialized+=results.length;return {results}},
    async run(){assert.equal(readonly,false,'GET cannot prepare/write data');return {success:true,meta:db.prepare(query).run(...args)}},
  })
  const sql={prepare,batch:async(items:any[])=>{assert.equal(readonly,false);db.exec('BEGIN');try{const out=[];for(const item of items)out.push(await item.run());db.exec('COMMIT');return out}catch(error){db.exec('ROLLBACK');throw error}}}
  const store=d1Store({...sql,batch:async(items:any[])=>Promise.all(items.map(item=>item.all()))} as any)
  db.prepare('INSERT INTO claims VALUES (?,?,?,?,?)').run('alice','public','email',1,'2026-01-01')
  await store.createOrg('acme',null,'owner')
  const snapshots:Record<string,SearchSnapshot>={}
  for(const repo of ['public','private']){
    await store.settings.putState({...entity('acme/'+repo),id:'id-'+repo})
    const acl=repo==='private'?{visibility:'private' as const,read:['@alice'],agents:{'@alice/granted':['review']}}:{visibility:'public' as const}
    await store.fenceRepoAccess('id-'+repo,'meta-'+repo)
    await store.publishRepoAccess('id-'+repo,'meta-'+repo,acl)
    await store.putListing('id-'+repo,1,{tip:SHA,meta:'meta-'+repo,acl,issues:2,pulls:3,updated:1000} as any)
    const epoch=await preparedRefsEpoch(sql as any,'id-'+repo)
    await publishPreparedRefs(sql as any,'id-'+repo,epoch,{ready:true,meta:'meta-'+repo,defaultBranch:'main',refs:[{name:'main',kind:'branch',hash:SHA},{name:'v1',kind:'tag',hash:SHA}]})
    snapshots[repo]={id:'id-'+repo,epoch,meta:'meta-'+repo,ref:'main',tip:SHA}
  }
  await publishPreparedCatalogue(sql as any,'acme',['public','private'].map(name=>({name,id:'id-'+name,description:'Stored '+name,defaultBranch:'main',createdAt:'2026-01-01',updatedAt:'2026-01-02'})),100)
  await publishPreparedCatalogue(sql as any,'alice',[],100)
  for(const name of ['alice/no-grant','alice/granted'])db.prepare('INSERT INTO agents(name,sponsor,label,created_at) VALUES (?,?,?,?)').run(name,'alice',name.split('/')[1],'2026-01-01')
  const reader=new PreparedSearch(sql as any)
  return {db,sql,store,snapshots,reader,statements,close:()=>db.close(),effects:()=>({queries,materialized}),
    async search(q='hello',p=principal(),limit=30,offset=0){
      readonly=true
      const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('GET cannot reach network')}
      try{return await reader.read(p,new Request('https://gild.test/api/v1/search/code'),{q,limit,offset})}
      finally{globalThis.fetch=oldFetch;readonly=false}
    }}
}

test('actual D1/workerd executes trigram migration, triggers, paged producer and search queries',async()=>{
  const mf=new Miniflare({telemetry:{enabled:false},resourceTmpPath:process.cwd()+'/.tmp/miniflare',workers:[{config:{name:'search-fixture',compatibilityDate:'2026-10-06',manifest:{mainModule:'fixture.mjs',modules:{'fixture.mjs':{type:'esm',contents:'export default {fetch(){return new Response("fixture")}}'}}},env:{DB:{type:'d1',id:'search-fixture'}}}}]})
  try{
    const db=await mf.getD1Database('DB')
    // All additive source migrations, including actual trigger DDL, are applied
    // as statements by D1; this is not native SQLite tokenizer evidence alone.
    for(const file of readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort()){
      const sql=readFileSync('migrations/'+file,'utf8')
      // D1 exec splits on newlines; batch statement groups keep trigger bodies.
      const chunks=sql.replace(/^--.*$/gm,'').match(/\s*CREATE TRIGGER[\s\S]*?END;|[^;]+;/g)??[]
      for(const chunk of chunks)await db.prepare(chunk).run()
    }
    await db.prepare('INSERT INTO prepared_repository_refs VALUES (?,?,?,?,?,?)').bind('id',0,0,'meta',JSON.stringify({ready:true,meta:'meta',defaultBranch:'main',refs:[{name:'main',kind:'branch',hash:SHA}]}),1).run()
    const snapshot={id:'id',epoch:0,meta:'meta',ref:'main',tip:SHA}
    await stagePreparedSearchDocuments(db as any,snapshot,[document('Unicode.ts','İstanbul KELVIN café 🐈猫狗')])
    const hits=await db.prepare('SELECT rowid FROM prepared_search_fts WHERE prepared_search_fts MATCH ?').bind('"kelvin"').all()
    assert.equal(hits.results.length,1)
    await stagePreparedSearchDocuments(db as any,snapshot,[document('Unicode.ts','Replacement café 🐈猫狗')])
    assert.equal((await db.prepare('SELECT rowid FROM prepared_search_fts WHERE prepared_search_fts MATCH ?').bind('"kelvin"').all()).results.length,0)
    assert.equal((await db.prepare('SELECT rowid FROM prepared_search_fts WHERE prepared_search_fts MATCH ?').bind('"café"').all()).results.length,1)
    assert.equal(await publishPreparedSearchReceipt(db as any,snapshot,1),true)
    await stagePreparedSearchDocuments(db as any,snapshot,[document('Unicode.ts','tampered')])
    assert.equal((await db.prepare('SELECT rowid FROM prepared_search_fts WHERE prepared_search_fts MATCH ?').bind('"café"').all()).results.length,1,'certified immutable snapshot is not rewritten')
    const f=await fixture();try{
      for(const table of ['claims','orgs','org_members','owner_names','settings_entities','repo_access','repo_listing','prepared_catalogues','prepared_repositories','prepared_repository_refs']){
        const rows=f.db.prepare('SELECT * FROM '+table).all()
        for(const row of rows){
          const columns=Object.keys(row)
          await db.prepare('INSERT OR REPLACE INTO '+table+' ('+columns.join(',')+') VALUES ('+columns.map(()=>'?').join(',')+')').bind(...Object.values(row)).run()
        }
      }
      await publishPreparedSearch(db as any,f.snapshots.public,[document('unicode.ts','KELVIN café 🐈猫狗')],true)
      const reader=new PreparedSearch(db as any)
      const actual=await reader.read(principal('outsider'),new Request('https://gild.test/api/v1/search/code'),{q:'repo:acme/public café'})
      assert.equal(actual.data.total_count,1);assert.equal(actual.data.items[0].path,'unicode.ts');assert.equal(actual.noStore,false)
      console.log(JSON.stringify({effect:'workerd-d1-reader',status:200,count:actual.data.total_count,privateExcluded:true}))
    }finally{f.close()}

  }finally{await mf.dispose()}
})

test('canonical search shape reads current authorized indexed data without producer/network, with stable pagination',async()=>{
  const f=await fixture();try{
    await publishPreparedSearch(f.sql as any,f.snapshots.public,[document('a.ts'),document('b.ts')],true)
    await publishPreparedSearch(f.sql as any,f.snapshots.private,[document('private.ts')],true)
    const before=f.effects(),first=await f.search('hello',principal(),1)
    assert.equal(first.data.total_count,3);assert.equal(first.data.items.length,1);assert.equal(first.noStore,true)
    assert.equal(first.data.items[0].sha,BLOB);assert.equal(first.data.items[0].text_matches[0].matches[0].text,'hello')
    assert.equal(first.data.items[0].repository.description,'Stored private')
    assert.equal(first.data.items[0].repository.created_at,'2026-01-01')
    assert.equal(first.data.items[0].repository.stargazers_count,0,'actual stars SQL count')
    const second=await f.search('hello',principal(),1,1)
    assert.notEqual(second.data.items[0].path,first.data.items[0].path)
    assert.ok(f.effects().queries-before.queries<=8,'four bounded D1 queries per human read, no per-hit queries')
    const query=f.statements.findLast(s=>s.query.includes('WITH bounded'))!
    const plan=f.db.prepare('EXPLAIN QUERY PLAN '+query.query).all(...query.args)
    assert.ok(plan.some((r:any)=>/VIRTUAL TABLE INDEX.*M/.test(r.detail)),'actual FTS MATCH index in SQL query plan')
    assert.ok(plan.some((r:any)=>/prepared_search_documents.*INDEX/.test(r.detail)||/SEARCH d USING (INDEX|INTEGER PRIMARY KEY)/.test(r.detail)))
    console.log(JSON.stringify({effect:'indexed-search-query-plan',plan,queriesPerRead:4}))
  }finally{f.close()}
})

test('ACL/allowlist/scopes/agent lifecycle precede private readiness, never sponsor inheritance',async()=>{
  const f=await fixture();try{
    await publishPreparedSearch(f.sql as any,f.snapshots.public,[document()],true)
    // Private search has deliberately not been prepared.
    assert.equal((await f.search('hello',principal('outsider'))).data.total_count,1)
    assert.equal((await f.search('hello',principal('',null,['repo:read']))).noStore,false)
    assert.equal((await f.search('hello',principal('alice',['acme/public']))).data.total_count,1)
    await assert.rejects(f.search('hello',principal('alice')),PreparationPending)
    f.db.prepare('INSERT INTO org_members(org,member,role,added_at) VALUES (?,?,?,?)').run('acme','alice','owner','2026-01-01')
    assert.equal((await f.search('repo:acme/private hello',principal('alice/no-grant'))).data.total_count,0,'agent never inherits sponsor org membership')
    await assert.rejects(f.search('repo:acme/private hello',principal('alice/granted')),PreparationPending)
    await assert.rejects(f.search('hello',principal('alice',null,['issues:write'])),{status:403})
    f.db.prepare('UPDATE agents SET suspended_at=? WHERE name=?').run('now','alice/granted')
    await assert.rejects(f.search('hello',principal('alice/granted')),{status:404})
    f.db.prepare('UPDATE agents SET suspended_at=NULL,revoked_at=? WHERE name=?').run('now','alice/granted')
    await assert.rejects(f.search('hello',principal('alice/granted')),{status:404})
    f.db.prepare('DELETE FROM org_members WHERE org=? AND member=?').run('acme','alice')
    f.db.prepare('UPDATE repo_access SET pending=1 WHERE id=?').run('id-private')
    assert.equal((await f.search('repo:acme/private hello',principal())).data.total_count,0,'revoked collaborator learns no readiness')
    await assert.rejects(f.search('repo:acme/private hello',principal('owner')),PreparationPending,'structural org human retains honest policy Pending')
  }finally{f.close()}
})

test('Unicode/punctuation/boolean/regex/path/symbol queries preserve original evaluator semantics',async()=>{
  const f=await fixture();try{
    await publishPreparedSearch(f.sql as any,f.snapshots.public,[document('src/a.ts','İstanbul KELVIN café 🐈猫狗 foo::bar abcXYZ'),document('lib/b.ts','unrelated')],true)
    for(const q of ['kelvin','i̇stanbul','café','🐈猫狗','"foo::bar"','abc','content:abcXYZ','path:src/*.ts','symbol:hello','/abc[A-Z]+/','kelvin OR unrelated','NOT content:unrelated']){
      const result=await f.search('repo:acme/public '+(q.includes(' OR ')?'('+q+')':q),principal('outsider'))
      assert.ok(result.data.total_count>=1,'exact query '+q)
    }
    assert.equal((await f.search('repo:acme/public kelvin AND content:unrelated',principal('outsider'))).data.total_count,0)
    const tag={...f.snapshots.public,ref:'v1'}
    await publishPreparedSearch(f.sql as any,tag,[document('tag.ts','tagneedle')],true)
    assert.equal((await f.search('repo:acme/public ref:v1 tagneedle',principal('outsider'))).data.total_count,1)
    assert.equal((await f.search('repo:acme/public branch:v1 tagneedle',principal('outsider'))).data.total_count,0)
    assert.equal((await f.search('repo:acme/public ref:missing hello',principal('outsider'))).data.total_count,0)
  }finally{f.close()}
})

test('failed/incomplete staging and stale epoch/meta/tips cannot certify ready empty; complete empty is actual zero',async()=>{
  const f=await fixture();try{
    await assert.rejects(publishPreparedSearch(f.sql as any,f.snapshots.public,[],false),/not complete/)
    await stagePreparedSearchDocuments(f.sql as any,f.snapshots.public,[document()])
    assert.equal(await publishPreparedSearchReceipt(f.sql as any,f.snapshots.public,2),false)
    await assert.rejects(f.search('repo:acme/public hello',principal('outsider')),PreparationPending)
    assert.equal(await publishPreparedSearchReceipt(f.sql as any,{...f.snapshots.public,meta:'old'},0),false)
    assert.equal(await publishPreparedSearchReceipt(f.sql as any,{...f.snapshots.public,tip:'c'.repeat(40)},0),false)
    assert.equal(await publishPreparedSearchReceipt(f.sql as any,f.snapshots.public,1),true)
    assert.equal((await f.search('repo:acme/public hello',principal('outsider'))).data.total_count,1)
    await fencePreparedRefs(f.sql as any,'id-public')
    assert.equal(await publishPreparedSearchReceipt(f.sql as any,f.snapshots.public,1),false)
    await assert.rejects(f.search('repo:acme/public hello',principal('outsider')),PreparationPending)
    const sameTipEpoch=await preparedRefsEpoch(f.sql as any,'id-public')
    await publishPreparedRefs(f.sql as any,'id-public',sameTipEpoch,{ready:true,meta:f.snapshots.public.meta,defaultBranch:'main',refs:[{kind:'branch',name:'main',hash:SHA}]})
    assert.equal(await publishPreparedSearchReceipt(f.sql as any,f.snapshots.public,1),false,'older producer cannot recertify after new epoch with the same tip')
    await fencePreparedRefs(f.sql as any,'id-public')
    const epoch=await preparedRefsEpoch(f.sql as any,'id-public'),snapshot={...f.snapshots.public,epoch,tip:'c'.repeat(40)}
    await publishPreparedRefs(f.sql as any,'id-public',epoch,{ready:true,meta:snapshot.meta,defaultBranch:'main',refs:[{kind:'branch',name:'main',hash:snapshot.tip}]})
    await assert.rejects(f.search('repo:acme/public hello',principal('outsider')),PreparationPending,'new ref cannot read old snapshot')
    assert.equal(await publishPreparedSearch(f.sql as any,snapshot,[],true),true)
    const empty=await f.search('repo:acme/public hello',principal('outsider'))
    assert.equal(empty.data.total_count,0);assert.equal(empty.data.incomplete_results,false)
    f.db.prepare('UPDATE settings_entities SET deleted_at=1 WHERE id=?').run('id-public')
    assert.equal((await f.search('repo:acme/public hello',principal('outsider'))).data.total_count,0,'deleted prepared repo omitted')
  }finally{f.close()}
})

test('candidate/byte budgets bound materialization and signal truthful lower counts; literal uses FTS',async()=>{
  const f=await fixture();try{
    const documents=Array.from({length:SEARCH_CANDIDATE_LIMIT+5},(_,i)=>document(i.toString().padStart(5,'0')+'.ts','needle'))
    await publishPreparedSearch(f.sql as any,f.snapshots.public,documents,true)
    const before=f.effects(),result=await f.search('repo:acme/public needle',principal('outsider'),100)
    assert.equal(result.data.total_count,SEARCH_CANDIDATE_LIMIT);assert.equal(result.data.incomplete_results,true);assert.equal(result.data.items.length,100);assert.equal(result.noStore,true)
    assert.ok(f.effects().materialized-before.materialized<=SEARCH_CANDIDATE_LIMIT+3)
    console.log(JSON.stringify({effect:'bounded-search',...f.effects(),count:result.data.total_count,partial:result.data.incomplete_results}))
    const key=searchSnapshotKey(f.snapshots.public)
    f.db.prepare('DELETE FROM prepared_search_receipts WHERE snapshot=?').run(key)
    f.db.prepare('DELETE FROM prepared_search_documents WHERE snapshot=?').run(key)
    await publishPreparedSearch(f.sql as any,f.snapshots.public,Array.from({length:6},(_,i)=>document('large'+i+'.ts','needle '+'x'.repeat(511*1024))),true)
    const bounded=await f.search('repo:acme/public needle',principal('outsider'))
    assert.equal(bounded.data.total_count,4);assert.equal(bounded.data.incomplete_results,true)
    assert.match(searchCandidateFilter(parseQuery('café').query).sql,/prepared_search_fts/)
  }finally{f.close()}
})


test('registered canonical GET validates stored-token scopes, real search DTO, Link, Pending and cache headers',async()=>{
  const f=await fixture(),controls=new Map<string,ApiControlStore>(),controlDBs:DatabaseSync[]=[]
  try{
    await f.store.saveApiToken(await hashToken('gf_search'),'alice','public',Date.now()+60000,{scopes:['repo:read'],repos:['acme/public']})
    const deps:Dependencies={authenticate:async request=>{
      const token=request.headers.get('authorization')?.slice(7);if(!token)return null
      const verified=await verifyStoredToken(token,f.store);return verified?.name?{...verified,id:await hashToken(token),name:verified.name}:null
    },control:async id=>{
      if(!controls.has(id)){
        const db=new DatabaseSync(':memory:');controlDBs.push(db)
        controls.set(id,new ApiControlStore({exec(query:string,...args:any[]){if(!args.length&&query.includes(';')){db.exec(query);return []}const stmt=db.prepare(query);if(stmt.columns().length)return stmt.all(...args);stmt.run(...args);return []}} as any))
      }
      return controls.get(id)!
    },authorize:async()=>{},execute:async c=>{
      const read=await f.reader.read(c.principal,c.request,{q:c.query.q,limit:c.query.per_page,offset:paginationOffset(c)})
      const page=paginate(read.data.items,c,read.data.total_count,true)
      return {data:{...read.data,items:page.data},headers:page.headers,noStore:read.noStore}
    }}
    const request=()=>dispatch(new Request('https://gild.test/api/v1/search/code?q=hello&per_page=1',{headers:{authorization:'Bearer gf_search'}}),deps)
    const pending=await request();assert.equal(pending.status,503);assert.equal(pending.headers.get('retry-after'),'1')
    assert.equal((await pending.json()).errors[0].code,'PREPARATION_PENDING')
    await publishPreparedSearch(f.sql as any,f.snapshots.public,[document('a.ts'),document('b.ts')],true)
    const ready=await request();assert.equal(ready.status,200);assert.match(ready.headers.get('link')!,/rel="next"/)
    assert.equal((await ready.json()).items.length,1);assert.ok(ready.headers.has('etag'))
    f.db.prepare('UPDATE repo_access SET acl=? WHERE id=?').run(JSON.stringify({visibility:'private',read:['@alice']}),'id-public')
    const invited=await request();assert.equal(invited.status,200);assert.match(invited.headers.get('cache-control')!,/no-store/)
    f.db.prepare('UPDATE repo_access SET acl=? WHERE id=?').run(JSON.stringify({visibility:'private',read:[]}),'id-public')
    const revoked=await request();assert.equal(revoked.status,200);assert.equal((await revoked.json()).total_count,0)
  }finally{f.close();for(const db of controlDBs)db.close()}
})

test('missing catalogues authorize named and allowlisted repositories before Pending; global unknown remains honest',async()=>{
  const f=await fixture();try{
    f.db.prepare('DELETE FROM prepared_catalogues WHERE owner=?').run('acme')
    assert.equal((await f.search('repo:acme/private hello',principal('outsider'))).data.total_count,0)
    assert.equal((await f.search('hello',principal('outsider',['acme/private']))).data.total_count,0)
    assert.equal((await f.search('repo:acme/missing hello',principal('outsider'))).data.total_count,0)
    await assert.rejects(f.search('repo:acme/private hello',principal()),PreparationPending)
    await assert.rejects(f.search('hello',principal('outsider',['acme/public'])),PreparationPending)
    await assert.rejects(f.search('hello',principal('outsider')),PreparationPending)
    assert.equal((await f.search('hello',principal('outsider',[]))).data.total_count,0)
  }finally{f.close()}
})


test('required repository DTO dates are observed facts; missing facts never fabricate epoch timestamps',async()=>{
  const f=await fixture();try{
    await publishPreparedSearch(f.sql as any,f.snapshots.public,[document()],true)
    f.db.prepare('UPDATE prepared_repositories SET created_at=NULL WHERE id=?').run('id-public')
    await assert.rejects(f.search('repo:acme/public hello',principal('outsider')),PreparationPending)
    assert.equal((await f.search('repo:acme/public absent',principal('outsider'))).data.total_count,0)
  }finally{f.close()}
})
