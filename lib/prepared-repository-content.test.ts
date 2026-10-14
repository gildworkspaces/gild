import {service,type Services} from './api/service.ts'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {readFileSync,readdirSync} from 'node:fs'
import {PreparedRepositoryContent,CONTENT_VERSION,type ContentEntry} from './prepared-repository-content.ts'
import {publishPreparedContentSnapshot,publishPreparedContentBlob} from './prepared-repository-content-producer.ts'
import {PreparedReadModels} from './prepared-read-models.ts'
import {publishPreparedCatalogue} from './prepared-catalogue-producer.ts'
import {fencePreparedRefs,preparedRefsEpoch,publishPreparedRefs} from './prepared-repository-producer.ts'
import {d1Store} from './drivers/d1.ts'
import {entity} from './settings-store.ts'
import {dispatch,type Context} from './api/dispatch.ts'
import {routes} from './api/contract.ts'
import type {Principal} from './api/scopes.ts'

const commit='a'.repeat(40),next='b'.repeat(40),root='c'.repeat(40),sub='d'.repeat(40),blob='e'.repeat(40),moduleSha='f'.repeat(40)
const binary=Buffer.from([0,255,128,10,65])
const inventory:ContentEntry[]=[
  {path:'Z.bin',mode:'100644',type:'blob',sha:blob,size:binary.length},
  {path:'dir',mode:'40000',type:'tree',sha:sub,size:0},
  {path:'dir/case.txt',mode:'100755',type:'blob',sha:blob,size:binary.length},
  {path:'module',mode:'160000',type:'commit',sha:moduleSha,size:0},
]
const alice:Principal={id:'alice',name:'alice',publicKey:'fixture',scopes:['repo:read'],repos:['acme/a']}
async function fixture(){
  const db=new DatabaseSync(':memory:')
  for(const file of readdirSync('migrations').filter(file=>file.endsWith('.sql')).sort())db.exec(readFileSync('migrations/'+file,'utf8'))
  let reading=false,queries=0,writes=0,batches=0
  const prepare=(query:string,args:any[]=[])=>({
    bind:(...values:any[])=>prepare(query,values),
    async first(){queries++;if(reading)assert.match(query,/^\s*(SELECT|WITH)\b/);return db.prepare(query).get(...args)??null},
    async all(){queries++;if(reading)assert.match(query,/^\s*(SELECT|WITH)\b/);return {results:db.prepare(query).all(...args)}},
    async run(){assert.equal(reading,false,'GET wrote or invoked producer');writes++;return {success:true,meta:db.prepare(query).run(...args)}},
  })
  const sql={prepare,async batch(items:any[]){assert.equal(reading,false,'GET producer batch');batches++;assert.ok(items.length<=80,'producer batch must remain bounded');db.exec('BEGIN');try{const results=[];for(const item of items)results.push(await item.run());db.exec('COMMIT');return results}catch(error){db.exec('ROLLBACK');throw error}}}
  const store=d1Store({...sql,batch:async(items:any[])=>Promise.all(items.map(item=>item.all()))} as any)
  db.prepare('INSERT INTO claims VALUES (?,?,?,?,?)').run('alice','public','private@example.test',1,'2026-01-01')
  await store.createOrg('acme',null,'owner')
  for(const repo of ['a','b']){
    await store.settings.putState({...entity('acme/'+repo),id:'repo-'+repo})
    await store.fenceRepoAccess('repo-'+repo,'meta')
    await store.publishRepoAccess('repo-'+repo,'meta',{visibility:'private',read:['@alice']})
    await store.putListing('repo-'+repo,1,{tip:commit,meta:'meta',acl:{visibility:'private'},issues:0,pulls:0,updated:1} as any)
    const epoch=await preparedRefsEpoch(sql as any,'repo-'+repo)
    await publishPreparedRefs(sql as any,'repo-'+repo,epoch,{ready:true,meta:'meta',defaultBranch:'main',refs:[{name:'main',kind:'branch',hash:commit}]})
  }
  await publishPreparedCatalogue(sql as any,'acme',['a','b'].map(name=>({id:'repo-'+name,name,description:null,defaultBranch:'main',createdAt:null,updatedAt:null})),1)
  const models=new PreparedReadModels(sql as any),reader=new PreparedRepositoryContent(sql as any,models)
  const forbidden=async()=>{throw new Error('Legacy index/catalog fallback forbidden')}
  const handlers=service({readModels:models,contentReads:reader,store:new Proxy({},{get(){throw new Error('Legacy store fallback forbidden')}}),index:forbidden,catalog:forbidden} as unknown as Services)
  async function request(path:string,principal=alice){
    reading=true
    const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('GET network forbidden')}
    try{return await dispatch(new Request('https://gild.test/api/v1/repos/acme/'+path,{headers:{authorization:'Bearer gf_fixture'}}),{
      authenticate:async()=>principal,control:async()=>({rate:async()=>({allowed:true,limit:10000,remaining:9999,reset:9999999999})} as any),
      ...handlers,
    })}finally{reading=false;globalThis.fetch=oldFetch}
  }
  return {db,sql,store,models,reader,request,close:()=>db.close(),counts:()=>({queries,writes,batches}),
    publish:()=>publishPreparedContentSnapshot(sql as any,'repo-a',{sha:commit,tree:root,complete:true,entries:inventory})}
}

test('actual registered content/tree/blob responses preserve canonical shapes, Git order, case and binary bytes with read-only D1',async()=>{
  const f=await fixture();try{
    await f.publish();await publishPreparedContentBlob(f.sql as any,'repo-a',blob,{size:binary.length,content:binary.toString('base64')})
    const before=f.counts()
    const listing=await f.request('a/contents?ref=main')
    assert.equal(listing.status,200);assert.match(listing.headers.get('cache-control')!,/no-store/)
    const files=await listing.json();assert.deepEqual(files.map((file:any)=>file.name),['Z.bin','dir','module'])
    assert.equal(files[0].size,5);assert.equal(files[0].content,undefined);assert.equal(files[2].type,'submodule');assert.equal(files[2].download_url,null)
    assert.equal(files[0].url,'https://gild.test/api/v1/repos/acme/a/contents/Z.bin?ref='+commit)
    const file=await f.request('a/contents/dir/case.txt?ref='+commit);assert.equal(file.status,200)
    assert.deepEqual(Buffer.from((await file.json()).content,'base64'),binary)
    const directory=await f.request('a/contents/dir');assert.equal(directory.status,200);assert.equal((await directory.json())[0].path,'dir/case.txt')
    const tree=await f.request('a/git/trees/'+root+'?recursive=1');assert.equal(tree.status,200)
    const treeData=await tree.json();assert.equal(treeData.sha,root);assert.deepEqual(treeData.tree.map((entry:any)=>entry.path),inventory.map(entry=>entry.path))
    assert.equal(treeData.tree[1].mode,'040000');assert.equal(treeData.tree[0].size,undefined);assert.equal(treeData.truncated,false)
    const subtree=await f.request('a/git/trees/'+sub);assert.equal((await subtree.json()).tree[0].path,'case.txt')
    const commitTree=await f.request('a/git/trees/main');assert.equal((await commitTree.json()).sha,root)
    const raw=await f.request('a/git/blobs/'+blob);assert.equal(raw.status,200);assert.deepEqual(Buffer.from((await raw.json()).content,'base64'),binary)
    assert.equal((await f.request('a/contents/z.bin')).status,404)
    assert.equal(f.counts().writes,before.writes);assert.equal(f.counts().batches,before.batches)
    assert.ok(f.counts().queries-before.queries<100,'bounded actual indexed queries for nine HTTP reads')
  }finally{f.close()}
})

test('absent snapshot/blob is typed Pending, complete empty snapshot is ready, indexed absent path is 404',async()=>{
  const f=await fixture();try{
    const pending=await f.request('a/contents');assert.equal(pending.status,503);assert.equal((await pending.json()).errors[0].code,'PREPARATION_PENDING')
    assert.equal(pending.headers.get('retry-after'),'1')
    await f.publish()
    assert.equal((await f.request('a/contents/Z.bin')).status,503,'known file with missing bytes is not an empty file')
    assert.equal((await f.request('a/git/blobs/'+blob)).status,503)
    await publishPreparedContentBlob(f.sql as any,'repo-a',blob,{size:binary.length,content:binary.toString('base64')})
    f.db.prepare('UPDATE prepared_content_blobs SET size=0 WHERE id=? AND sha=?').run('repo-a',blob)
    assert.equal((await f.request('a/contents/Z.bin')).status,503,'mismatched object size is not a ready file response')
    assert.equal((await f.request('a/contents/absent')).status,404)
    await publishPreparedContentSnapshot(f.sql as any,'repo-a',{sha:next,tree:'1'.repeat(40),complete:true,entries:[]})
    const empty=await f.request('a/contents?ref='+next);assert.equal(empty.status,200);assert.deepEqual(await empty.json(),[])
    const emptyTree=await f.request('a/git/trees/'+next);assert.equal(emptyTree.status,200);assert.deepEqual((await emptyTree.json()).tree,[])
    f.db.prepare('UPDATE prepared_content_snapshots SET version=? WHERE sha=?').run('old-schema',next)
    assert.equal((await f.request('a/contents?ref='+next)).status,503,'old version cannot certify empty content')
  }finally{f.close()}
})

test('immutable cached bytes still check current ACL, allow-list, lifecycle, agent and metadata readiness before data',async()=>{
  const f=await fixture();try{
    await f.publish();await publishPreparedContentBlob(f.sql as any,'repo-a',blob,{size:5,content:binary.toString('base64')})
    assert.equal((await f.request('a/git/blobs/'+blob,{...alice,name:'outsider'})).status,404)
    assert.equal((await f.request('b/git/blobs/'+blob)).status,404,'cached object in another repo never bypasses allow-list')
    assert.equal((await f.request('a/git/blobs/'+blob,{...alice,name:'alice/agent'})).status,404,'agent cannot inherit sponsor access')
    await f.store.publishRepoAccess('repo-a','meta',{visibility:'private',read:[]})
    assert.equal((await f.request('a/git/blobs/'+blob)).status,404,'revocation denies previously prepared bytes')
    await f.store.publishRepoAccess('repo-a','meta',{visibility:'private',read:['@alice']})
    await f.store.fenceRepoAccess('repo-a','meta-next')
    assert.equal((await f.request('a/contents')).status,404,'pending ACL is never stale collaborator access')
    await f.store.publishRepoAccess('repo-a','meta-next',{visibility:'private',read:['@alice']})
    assert.equal((await f.request('a/contents')).status,503,'authorized metadata mismatch remains Pending')
    f.db.prepare('UPDATE settings_entities SET deleted_at=1 WHERE key=?').run('acme/a')
    assert.equal((await f.request('a/contents')).status,404)
  }finally{f.close()}
})

test('moving ref fence cannot expose old tip; explicit immutable commit stays current-policy readable',async()=>{
  const f=await fixture();try{
    await f.publish()
    await fencePreparedRefs(f.sql as any,'repo-a')
    assert.equal((await f.request('a/contents?ref=main')).status,503)
    assert.equal((await f.request('a/git/trees/main')).status,503)
    assert.equal((await f.request('a/contents?ref='+commit)).status,200)
    await publishPreparedRefs(f.sql as any,'repo-a',await preparedRefsEpoch(f.sql as any,'repo-a'),{ready:true,meta:'meta',defaultBranch:'main',refs:[{name:'main',kind:'branch',hash:next}]})
    assert.equal((await f.request('a/contents?ref=main')).status,503,'new tip must not borrow old content receipt')
    assert.equal((await f.request('a/contents?ref=missing')).status,404)
  }finally{f.close()}
})

test('producer verifies complete tree closure/bytes and leaves no false-ready receipt on invalid input or failed chunk',async()=>{
  const f=await fixture();try{
    await assert.rejects(publishPreparedContentSnapshot(f.sql as any,'repo-a',{sha:commit,tree:root,complete:false,entries:[]} as any),/Complete/)
    await assert.rejects(publishPreparedContentSnapshot(f.sql as any,'repo-a',{sha:commit,tree:root,complete:true,entries:[inventory[2]]}),/closure/)
    await assert.rejects(publishPreparedContentBlob(f.sql as any,'repo-a',blob,{size:0,content:binary.toString('base64')}),/bytes/)
    assert.equal((await f.request('a/contents')).status,503)
    f.db.exec("CREATE TRIGGER content_failure BEFORE INSERT ON prepared_content_trees BEGIN SELECT RAISE(ABORT,'fixture failed tree publication'); END")
    await assert.rejects(f.publish(),/fixture failed/)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM prepared_content_snapshots').get()!.n,0)
    assert.equal((await f.request('a/contents')).status,503)
    f.db.exec('DROP TRIGGER content_failure');await f.publish();assert.equal((await f.request('a/contents')).status,200)
  }finally{f.close()}
})

test('prepared module refuses operations outside the selected current canonical subset',async()=>{
  const f=await fixture();try{
    const context={route:routes.find(route=>route.id==='commit')!,principal:alice,params:{owner:'acme',repo:'a',sha:commit},query:{},body:{},request:new Request('https://gild.test')} as Context
    await assert.rejects(f.reader.response(context),/Unsupported/)
  }finally{f.close()}
})

test('multi-chunk publication resumes without certifying a failed partial inventory as complete',async()=>{
  const f=await fixture();try{
    const entries=Array.from({length:205},(_,index)=>({path:'file-'+String(index).padStart(3,'0'),mode:'100644',type:'blob' as const,sha:blob,size:5}))
    const publish=()=>publishPreparedContentSnapshot(f.sql as any,'repo-a',{sha:commit,tree:root,complete:true,entries})
    f.db.exec("CREATE TRIGGER content_chunk_failure BEFORE INSERT ON prepared_content_entries WHEN NEW.path='file-150' BEGIN SELECT RAISE(ABORT,'fixture failed second chunk'); END")
    await assert.rejects(publish(),/second chunk/)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM prepared_content_entries').get()!.n,80,'first immutable producer chunk remains resumable')
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM prepared_content_snapshots').get()!.n,0)
    assert.equal((await f.request('a/contents')).status,503)
    f.db.exec('DROP TRIGGER content_chunk_failure');await publish()
    const response=await f.request('a/contents');assert.equal(response.status,200);const data=await response.json()
    assert.equal(data.length,205);assert.equal(data.at(-1).name,'file-204')
  }finally{f.close()}
})


test('oversized immutable tree retains Pending without publishing a partial receipt',async()=>{
  const f=await fixture();try{
    const huge=Array.from({length:6000},(_,i)=>({path:String(i).padStart(5,'0')+'x'.repeat(95),mode:'100644',type:'blob' as const,sha:blob,size:binary.length}))
    const before=f.counts()
    await assert.rejects(publishPreparedContentSnapshot(f.sql as any,'repo-a',{sha:commit,tree:root,complete:true,entries:huge}),e=>e.status===413)
    assert.equal(f.counts().writes,before.writes);assert.equal(f.counts().batches,before.batches)
    const response=await f.request('a/contents');assert.equal(response.status,503)
    assert.equal((await response.json()).errors[0].code,'PREPARATION_PENDING')
  }finally{f.close()}
})
