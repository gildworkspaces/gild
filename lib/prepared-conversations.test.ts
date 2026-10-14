import {service,type Services} from './api/service.ts'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {readFileSync,readdirSync} from 'node:fs'
import {PreparedReadModels,PreparationPending} from './prepared-read-models.ts'
import {PreparedConversations} from './prepared-conversations.ts'
import {beginPreparedConversations,stagePreparedConversationThreads,stagePreparedConversationComments,stagePreparedConversationReviews,finishPreparedConversations,
  prunePreparedConversations,type ConversationTicket,type ConversationThread,type ConversationComment} from './prepared-conversations-producer.ts'
import {match,dispatch,type Context} from './api/dispatch.ts'
import type {Principal} from './api/scopes.ts'

const owner:Principal={id:'owner',name:'acme',publicKey:'fixture',scopes:null,repos:null}
const alice:Principal={id:'alice',name:'alice',publicKey:'fixture',scopes:['repo:read'],repos:['acme/site']}
const stranger:Principal={...alice,id:'stranger',name:'stranger',repos:null}
const repository={defaultBranch:'main',description:'Prepared source',stars:2,createdAt:'2026-10-10T00:00:00.000Z',updatedAt:'2026-10-11T00:00:00.000Z'}
const issue=(number:number):ConversationThread=>({kind:'issue',item:{schema:1,number,title:'Issue '+number,body:'Stored body '+number,
  author:'alice',createdAt:'2026-10-10T00:00:00.000Z',state:'open',labels:number%2?['demo']:[],claim:null},
  updatedAt:'2026-10-11T00:00:00.000Z',comments:0,reviews:0})
function fixture(){
  const db=new DatabaseSync(':memory:')
  for(const file of readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync('migrations/'+file,'utf8'))
  let reading=false,queries=0,maxRows=0,writes=0
  const prepare=(query:string,args:any[]=[])=>({bind:(...values:any[])=>prepare(query,values),
    async first(){queries++;if(reading)assert.match(query,/^\s*(SELECT|WITH)\b/i);return db.prepare(query).get(...args)??null},
    async all(){queries++;if(reading)assert.match(query,/^\s*(SELECT|WITH)\b/i);const results=db.prepare(query).all(...args);if(reading)maxRows=Math.max(maxRows,results.length);return {results}},
    async run(){assert.equal(reading,false,'reads cannot prepare or publish');writes++;return {success:true,meta:db.prepare(query).run(...args)}},
  })
  const sql={prepare,async batch(items:any[]){assert.equal(reading,false,'reads cannot batch writes');db.exec('BEGIN');try{
    const out=[];for(const item of items)out.push(await item.run());db.exec('COMMIT');return out
  }catch(e){db.exec('ROLLBACK');throw e}}}
  db.prepare('INSERT INTO claims VALUES (?,?,?,?,?)').run('acme','fixture','private@test.invalid',1,'2026-10-10')
  db.prepare('INSERT INTO settings_entities(key,id) VALUES (?,?)').run('acme/site','repo-site')
  const acl={visibility:'private',read:['@alice']}
  db.prepare('INSERT INTO repo_access VALUES (?,?,?,0)').run('repo-site','meta-1',JSON.stringify(acl))
  db.prepare('INSERT INTO repo_listing VALUES (?,1,?)').run('repo-site',JSON.stringify({tip:'a'.repeat(40),meta:'meta-1',acl,issues:0,pulls:0,updated:1}))
  db.prepare('INSERT INTO prepared_catalogues VALUES (?,1)').run('acme')
  db.prepare('INSERT INTO prepared_repositories VALUES (?,?,?,1,NULL,?,NULL,NULL,1)').run('acme','site','repo-site','main')
  db.prepare('INSERT INTO prepared_repository_refs VALUES (?,1,0,?,NULL,1)').run('repo-site','meta-1')
  const models=new PreparedReadModels(sql as any),reads=new PreparedConversations(sql as any,models)
  const forbidden=async()=>{throw new Error('Legacy index/catalog fallback forbidden')}
  const handlers=service({readModels:models,conversationReads:reads,store:new Proxy({},{get(){throw new Error('Legacy store fallback forbidden')}}),index:forbidden,catalog:forbidden} as unknown as Services)
  const ticket=(generation:string):ConversationTicket=>({id:'repo-site',generation,epoch:1,meta:'meta-1',refs:null})
  const context=(path:string,p:Principal=alice):Context=>{
    const request=new Request('https://gild.test/api/v1/repos/acme/site'+path),url=new URL(request.url)
    const found=match('GET',url.pathname.replace('/api/v1',''))!
    return {...found,request,query:found.route.query.parse(Object.fromEntries(url.searchParams)),body:{},principal:p}
  }
  const read=async(path:string,p:Principal=alice)=>{
    reading=true;const old=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('GET cannot call Git/index/network')}
    try{return await reads.read(context(path,p))}finally{reading=false;globalThis.fetch=old}
  }
  return {db,sql,models,reads,handlers,ticket,context,read,effects:()=>({queries,maxRows,writes}),close:()=>db.close()}
}
const status=(value:number)=>(e:any)=>{assert.equal(e.status,value);return true}
async function publish(f:ReturnType<typeof fixture>,t:ConversationTicket,threads:ConversationThread[],comments:ConversationComment[]=[]){
  await beginPreparedConversations(f.sql as any,t,repository,{threads:threads.length,comments:comments.length,reviews:0})
  for(let i=0;i<threads.length;i+=100)await stagePreparedConversationThreads(f.sql as any,t,threads.slice(i,i+100))
  for(let i=0;i<comments.length;i+=100)await stagePreparedConversationComments(f.sql as any,t,comments.slice(i,i+100))
  assert.equal(await finishPreparedConversations(f.sql as any,t),true)
}

test('complete inventory and child receipts distinguish Pending, unknown and ready empty after current authorization',async()=>{
  const f=fixture();try{
    await assert.rejects(f.read('/issues'),e=>e instanceof PreparationPending)
    await assert.rejects(f.read('/issues',stranger),status(404))
    await assert.rejects(f.read('/issues',{...alice,repos:['acme/other']}),status(404))
    await assert.rejects(f.read('/issues',{...alice,scopes:[]}),status(403))
    const unknown=f.context('/issues');unknown.params.repo='missing'
    await assert.rejects(f.reads.read(unknown),status(404))
    const t=f.ticket('partial'),a={...issue(1),comments:1}
    await beginPreparedConversations(f.sql as any,t,repository,{threads:1,comments:1,reviews:0})
    assert.equal(await beginPreparedConversations(f.sql as any,t,repository,{threads:1,comments:1,reviews:0}),true)
    await assert.rejects(beginPreparedConversations(f.sql as any,t,repository,{threads:0,comments:0,reviews:0}),/different inventory/)
    await stagePreparedConversationThreads(f.sql as any,t,[a]);assert.equal(await finishPreparedConversations(f.sql as any,t),false)
    await assert.rejects(f.read('/issues/1'),e=>e instanceof PreparationPending)
    await stagePreparedConversationComments(f.sql as any,t,[{kind:'issue',number:1,ordinal:0,item:{id:'c1',author:'alice',createdAt:'2026-10-10',body:'Reply'}}])
    assert.equal(await finishPreparedConversations(f.sql as any,t),true)
    assert.equal((await f.read('/issues/1')).data && ((await f.read('/issues/1')).data as any).comments,1)
    await assert.rejects(f.read('/issues/9'),status(404))
    await publish(f,f.ticket('empty'),[])
    assert.deepEqual((await f.read('/issues')).data,[])
    await assert.rejects(f.read('/issues/1'),status(404))
  }finally{f.close()}
})
test('normalized inventory pages beyond 1000 and child pages remain bounded and preserve existing filters/cursors',async()=>{
  const f=fixture();try{
    const threads=Array.from({length:1053},(_,i)=>issue(i+1));threads[0]={...threads[0],comments:103}
    const comments=Array.from({length:103},(_,i)=>({number:1,kind:'issue' as const,ordinal:i,item:{id:'c'+i,author:'alice',body:'Reply '+i,createdAt:'2026-10-10'}}))
    await publish(f,f.ticket('large'),threads,comments)
    const writes=f.effects().writes
    const last=await f.read('/issues?state=all&direction=asc&page=11&per_page=100')
    assert.equal((last.data as any[]).length,53);assert.equal((last.data as any[])[0].number,1001)
    const labels=await f.read('/issues?labels=demo&sort=comments&per_page=1')
    assert.equal((labels.data as any[])[0].number,1);assert.match(labels.headers!.link,/rel="next"/)
    const next=new URL(labels.headers!.link.match(/<([^>]+)>/)![1])
    const page=await f.read(next.pathname.replace('/api/v1/repos/acme/site','')+next.search)
    assert.notEqual((page.data as any[])[0].number,1)
    const replies=await f.read('/issues/1/comments?per_page=100&page=2')
    assert.equal((replies.data as any[]).length,3);assert.equal((replies.data as any[])[0].body,'Reply 100')
    assert.ok(f.effects().maxRows<=100);assert.equal(f.effects().writes,writes)
  }finally{f.close()}
})
test('pull issue facade, inline comments and review states use existing successful canonical payloads',async()=>{
  const f=fixture();try{
    const t=f.ticket('pull'),pull:ConversationThread={kind:'pr',item:{schema:1,number:2,title:'Pull',body:'Merge',author:'alice',createdAt:'2026-10-10',head:'topic',base:'main',state:'merged',merged:{by:'acme',at:'2026-10-11',commit:'c'.repeat(40)}},
      head:'b'.repeat(40),base:'a'.repeat(40),updatedAt:'2026-10-11',comments:2,reviews:1}
    await beginPreparedConversations(f.sql as any,t,repository,{threads:1,comments:2,reviews:1})
    await stagePreparedConversationThreads(f.sql as any,t,[pull])
    await stagePreparedConversationComments(f.sql as any,t,[
      {kind:'pr',number:2,ordinal:0,item:{id:'discussion',author:'alice',body:'Comment',createdAt:'2026-10-10'}},
      {kind:'pr',number:2,ordinal:1,item:{id:'inline',author:'alice',body:'Inline',createdAt:'2026-10-10',path:'index.ts',line:2,side:'RIGHT',commit_id:'b'.repeat(40)}},
    ])
    await stagePreparedConversationReviews(f.sql as any,t,[{number:2,ordinal:0,item:{id:'review',author:'acme',verdict:'approve',body:'Approved',createdAt:'2026-10-10',headOid:'b'.repeat(40)}}])
    assert.equal(await finishPreparedConversations(f.sql as any,t),true)
    const detail=(await f.read('/pulls/2')).data as any
    assert.equal(detail.merged,true);assert.equal(detail.state,'closed');assert.equal(detail.head.sha,'b'.repeat(40));assert.equal(detail.base.repo.private,true)
    assert.equal(detail.head.repo.html_url,'https://gild.test/acme/site')
    const facade=(await f.read('/issues/2')).data as any;assert.match(facade.pull_request.url,/pulls\/2$/)
    assert.equal(((await f.read('/issues/2/comments')).data as any[]).length,2)
    const inline=(await f.read('/pulls/2/comments')).data as any[];assert.equal(inline.length,1);assert.equal(inline[0].path,'index.ts')
    assert.equal(((await f.read('/pulls/2/reviews')).data as any[])[0].state,'APPROVED')
    assert.equal(((await f.read('/pulls?state=closed')).data as any[]).length,1)
    assert.equal(((await f.read('/pulls?state=open')).data as any[]).length,0)
    // A finalized generation cannot be rewritten by delayed producer pages.
    await stagePreparedConversationThreads(f.sql as any,t,[{...pull,item:{...pull.item,title:'Late overwrite'}}])
    assert.equal(((await f.read('/pulls/2')).data as any).title,'Pull')
  }finally{f.close()}
})
test('current private ACL, lifecycle, allowlist and agent grant revocation apply before stored conversation bytes',async()=>{
  const f=fixture();try{
    await publish(f,f.ticket('access'),[issue(1)])
    assert.equal((await f.read('/issues/1')).noStore,true)
    f.db.prepare('UPDATE repo_access SET acl=?').run(JSON.stringify({visibility:'public',read:['@alice']}))
    const anonymous={id:'anonymous',name:'',publicKey:'',anonymous:true,scopes:['repo:read'],repos:null}
    assert.equal((await f.read('/issues/1',anonymous)).noStore,false)
    f.db.prepare('UPDATE repo_access SET acl=?').run(JSON.stringify({visibility:'private',read:['@alice']}))
    await assert.rejects(f.read('/issues/1',anonymous),status(404))
    const agent={...alice,name:'acme/helper',repos:null}
    f.db.prepare('INSERT INTO agents(name,sponsor,label,created_at) VALUES (?,?,?,?)').run(agent.name,'acme','helper','2026-10-10')
    await assert.rejects(f.read('/issues/1',agent),status(404),'agent never inherits sponsor owner role')
    f.db.prepare('UPDATE repo_access SET acl=?').run(JSON.stringify({visibility:'private',agents:{'@acme/helper':['review']}}))
    assert.equal(((await f.read('/issues/1',agent)).data as any).number,1)
    f.db.prepare('UPDATE agents SET revoked_at=? WHERE name=?').run('2026-10-12',agent.name)
    await assert.rejects(f.read('/issues/1',agent),status(404))
    await assert.rejects(f.read('/issues/1'),status(404),'revoked invitation loses access immediately')
    f.db.prepare('UPDATE settings_entities SET deleted_at=1 WHERE key=?').run('acme/site')
    await assert.rejects(f.read('/issues/1',owner),status(404))
  }finally{f.close()}
})
test('new push epochs fence old receipts and stale completion while incomplete or orphan staging cannot certify',async()=>{
  const f=fixture();try{
    const t=f.ticket('old');await publish(f,t,[issue(1)])
    f.db.prepare('UPDATE prepared_repository_refs SET epoch=2,pending=0 WHERE id=?').run(t.id)
    await assert.rejects(f.read('/issues/1'),e=>e instanceof PreparationPending)
    assert.equal(await finishPreparedConversations(f.sql as any,t),false,'old receipt must not report readiness at a new epoch')
    const next={...t,generation:'new',epoch:2}
    await publish(f,next,[issue(2)])
    assert.equal(await finishPreparedConversations(f.sql as any,t),false,'old publication cannot replace the new epoch receipt')
    assert.equal(((await f.read('/issues')).data as any[])[0].number,2)
    const orphan={...next,generation:'orphan'}
    await beginPreparedConversations(f.sql as any,orphan,repository,{threads:0,comments:1,reviews:0})
    await stagePreparedConversationComments(f.sql as any,orphan,[{kind:'issue',number:99,ordinal:0,item:{id:'orphan',author:'alice',body:'No parent',createdAt:'2026-10-10'}}])
    assert.equal(await finishPreparedConversations(f.sql as any,orphan),false)
    assert.equal(((await f.read('/issues')).data as any[])[0].number,2)
    assert.equal(await prunePreparedConversations(f.sql as any,t.id),1)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM prepared_conversation_runs WHERE generation=?').get('old')!.n,0)
    assert.equal(((await f.read('/issues')).data as any[])[0].number,2)
  }finally{f.close()}
})
test('actual registered dispatch returns normalized canonical replies and typed Pending with producer ports absent',async()=>{
  const f=fixture();try{
    const deps={authenticate:async()=>alice,control:async()=>({rate:async()=>({allowed:true,limit:10000,remaining:9999,reset:Date.now()})}) as any,
      ...f.handlers}
    const path='https://gild.test/api/v1/repos/acme/site/issues'
    const pending=await dispatch(new Request(path),deps);assert.equal(pending.status,503)
    assert.equal((await pending.json()).errors[0].code,'PREPARATION_PENDING')
    await publish(f,f.ticket('http'),[issue(1)])
    const response=await dispatch(new Request(path),deps);assert.equal(response.status,200);assert.match(response.headers.get('cache-control')!,/no-store/)
    assert.equal((await response.json())[0].title,'Issue 1')
  }finally{f.close()}
})


test('unknown required repository dates leave pull Pending rather than fabricating epoch dates',async()=>{
  const f=fixture();try{
    const t=f.ticket('dates'),thread:ConversationThread={kind:'pr',item:{schema:1,number:2,title:'Pull',body:'Body',author:'alice',createdAt:'2026-10-10',head:'topic',base:'main',state:'open'},head:'b'.repeat(40),base:'a'.repeat(40),updatedAt:'2026-10-11',comments:0,reviews:0}
    await beginPreparedConversations(f.sql as any,t,{...repository,createdAt:null},{threads:1,comments:0,reviews:0})
    await stagePreparedConversationThreads(f.sql as any,t,[thread]);assert.equal(await finishPreparedConversations(f.sql as any,t),true)
    await assert.rejects(f.read('/pulls/2'),e=>e instanceof PreparationPending)
    assert.equal(((await f.read('/issues/2')).data as any).number,2)
  }finally{f.close()}
})


test('same-epoch changed ref payload fences stale receipts and stale completion',async()=>{
  const f=fixture();try{
    const old=f.ticket('old-ref');await publish(f,old,[issue(1)])
    assert.equal(((await f.read('/issues/1')).data as any).number,1)
    f.db.prepare('UPDATE prepared_repository_refs SET data=? WHERE id=?').run(JSON.stringify({refs:[{name:'main',kind:'branch',hash:'c'.repeat(40)}]}),old.id)
    await assert.rejects(f.read('/issues/1'),e=>e instanceof PreparationPending)
    assert.equal(await finishPreparedConversations(f.sql as any,old),false)
    const next={...old,generation:'new-ref',refs:JSON.stringify({refs:[{name:'main',kind:'branch',hash:'c'.repeat(40)}]})}
    await publish(f,next,[issue(2)])
    assert.equal(((await f.read('/issues/2')).data as any).number,2)
    assert.equal(await finishPreparedConversations(f.sql as any,old),false)
    assert.equal(((await f.read('/issues/2')).data as any).number,2)
  }finally{f.close()}
})
