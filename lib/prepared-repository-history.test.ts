import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {readFileSync,readdirSync} from 'node:fs'
import {d1Store} from './drivers/d1.ts'
import {entity} from './settings-store.ts'
import {publishPreparedCatalogue} from './prepared-catalogue-producer.ts'
import {fencePreparedRefs,preparedRefsEpoch,publishPreparedRefs} from './prepared-repository-producer.ts'
import {PreparedRepositoryHistory} from './prepared-repository-history.ts'
import {HISTORY_VERSION,type HydratedHistoryCommit,type HistoryDiff} from './prepared-repository-history-facts.ts'
import {publishPreparedHistoryCommits,publishPreparedHistoryMissing,stagePreparedRepositoryHistory,publishPreparedRepositoryHistoryReceipt,publishPreparedRepositoryHistory,publishPreparedHistoryDetails,publishPreparedHistoryComparison} from './prepared-repository-history-producer.ts'
import {dispatch,type Dependencies} from './api/dispatch.ts'
import {ApiControlStore} from './api/control-store.ts'
import {hashToken,verifyStoredToken} from './token-verifier.ts'
import {IndexStore} from './repo-index-store.ts'
import {Miniflare} from 'miniflare'
import {routes} from './api/contract.ts'
import type {Context} from './api/dispatch.ts'
import {comparison,type Index} from './api/indexed.ts'
const SHA=(n:number)=>n.toString(16).padStart(40,'0')
const commit=(n:number,parents:number[]=[],time=n):HydratedHistoryCommit=>({hash:SHA(n),tree:SHA(100+n),parents:parents.map(SHA),author_name:'Actual author '+n,author_email:'author'+n+'@test',time,message:'Commit '+n,committer_name:'Actual committer '+n,committer_email:'committer'+n+'@test',committer_time:time+10})
const file={path:'src/main.ts',sha:SHA(999),status:'modified' as const,additions:2,deletions:1,hunks:[{oldStart:1,newStart:1,lines:['-old','+new','+second']}]}
const diff=(from:number|null,to:number,files=[file]):HistoryDiff=>({from:from===null?null:SHA(from),to:SHA(to),files,complete:true})
async function fixture(){
  const db=new DatabaseSync(':memory:')
  for(const name of readdirSync('migrations').filter(name=>name.endsWith('.sql')).sort())db.exec(readFileSync('migrations/'+name,'utf8'))
  let readonly=false,queries=0,returnedRows=0
  const statements:{query:string;args:any[]}[]=[]
  const prepare=(query:string,args:any[]=[])=>({bind:(...args:any[])=>prepare(query,args),
    async first(){queries++;statements.push({query,args});if(readonly)assert.match(query,/^\s*(SELECT|WITH)/i);return db.prepare(query).get(...args)??null},
    async all(){queries++;statements.push({query,args});if(readonly)assert.match(query,/^\s*(SELECT|WITH)/i);const results=db.prepare(query).all(...args);returnedRows+=results.length;return {results}},
    async run(){assert.equal(readonly,false,'GET cannot execute producer writes');return {success:true,meta:db.prepare(query).run(...args)}},
  })
  const sql={prepare,batch:async(items:any[])=>{assert.equal(readonly,false);db.exec('BEGIN');try{const out=[];for(const item of items)out.push(await item.run());db.exec('COMMIT');return out}catch(error){db.exec('ROLLBACK');throw error}}}
  const store=d1Store({...sql,batch:async(items:any[])=>Promise.all(items.map(item=>item.all()))} as any)
  await store.createOrg('acme',null,'owner')
  await store.settings.putState({...entity('acme/repo'),id:'id-repo'})
  const acl={visibility:'private' as const,read:['@alice'],agents:{'@alice/granted':['review']}}
  await store.fenceRepoAccess('id-repo','meta')
  await store.publishRepoAccess('id-repo','meta',acl)
  await store.putListing('id-repo',1,{tip:SHA(4),meta:'meta',acl,issues:0,pulls:0,updated:1000} as any)
  await publishPreparedCatalogue(sql as any,'acme',[{name:'repo',id:'id-repo',description:'Actual repo',defaultBranch:'main',createdAt:'2026-01-01',updatedAt:'2026-01-02'}],1)
  const epoch=await preparedRefsEpoch(sql as any,'id-repo')
  const refs={ready:true,meta:'meta',defaultBranch:'main',refs:[{kind:'branch' as const,name:'main',hash:SHA(4)},{kind:'branch' as const,name:'branch/with-slash',hash:SHA(3)},{kind:'tag' as const,name:'v1',hash:SHA(1)}]}
  await publishPreparedRefs(sql as any,'id-repo',epoch,refs)
  for(const name of ['alice/no-grant','alice/granted'])db.prepare('INSERT INTO agents(name,sponsor,label,created_at) VALUES (?,?,?,?)').run(name,'alice',name.split('/')[1],'2026-01-01')
  for(const [token,name,repos,scopes] of [['gf_alice','alice',null,['repo:read']],['gf_outsider','outsider',null,['repo:read']],['gf_owner','owner',null,['repo:read']],['gf_wrong','alice',['acme/other'],['repo:read']],['gf_no_scope','alice',null,['issues:write']],['gf_agent','alice/no-grant',null,['repo:read']],['gf_granted','alice/granted',null,['repo:read']]] as const){
    await store.saveApiToken(await hashToken(token),name,'fixture',Date.now()+60000,{scopes:[...scopes],...(repos?{repos:[...repos]}:{})})
  }
  const controls=new Map<string,ApiControlStore>(),controlDBs:DatabaseSync[]=[]
  const reader=new PreparedRepositoryHistory(sql as any)
  const deps:Dependencies={authenticate:async request=>{
    const token=request.headers.get('authorization')?.slice(7);if(!token)return null
    const verified=await verifyStoredToken(token,store)
    return verified?.name?{...verified,id:await hashToken(token),name:verified.name}:null
  },control:async id=>{
    if(!controls.has(id)){const c=new DatabaseSync(':memory:');controlDBs.push(c);controls.set(id,new ApiControlStore({exec(query:string,...args:any[]){if(!args.length&&query.includes(';')){c.exec(query);return []}const statement=c.prepare(query);if(statement.columns().length)return statement.all(...args);statement.run(...args);return []}} as any))}
    return controls.get(id)!
  },authorize:async()=>{},execute:c=>reader.read(c)}
  return {db,sql,store,reader,refs,epoch,statements,effects:()=>({queries,returnedRows}),close:()=>{db.close();for(const c of controlDBs)c.close()},
    async request(path='/commits',token='gf_alice'){
      readonly=true
      const previous=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('History GET cannot reach network/Git/DO')}
      try{return await dispatch(new Request('https://gild.test/api/v1/repos/acme/repo'+path,{headers:{authorization:'Bearer '+token}}),deps)}
      finally{readonly=false;globalThis.fetch=previous}
    }}
}

test('registered history uses observed complete ancestors, author/committer/parents and indexed cursor pages',async()=>{
  const f=await fixture();try{
    const graph=[commit(1,[],100),commit(2,[1],300),commit(3,[1],200),commit(4,[2,3],400)]
    const pending=await f.request();assert.equal(pending.status,503);assert.equal((await pending.json()).errors[0].code,'PREPARATION_PENDING')
    assert.equal(await publishPreparedRepositoryHistory(f.sql as any,'id-repo',SHA(4),graph,true),true)
    const before=f.effects(),first=await f.request('/commits?per_page=2')
    assert.equal(first.status,200);assert.match(first.headers.get('cache-control')!,/no-store/)
    const data=await first.json();assert.deepEqual(data.map((c:any)=>c.sha),[SHA(4),SHA(2)])
    assert.equal(data[0].commit.committer.name,'Actual committer 4');assert.equal(data[0].commit.author.name,'Actual author 4')
    assert.equal(data[0].commit.author.date,new Date(400000).toISOString());assert.equal(data[0].commit.committer.date,new Date(410000).toISOString())
    assert.deepEqual(data[0].parents.map((p:any)=>p.sha),[SHA(2),SHA(3)])
    assert.ok(f.effects().queries-before.queries<=10,'bounded ACL + ref/receipt/page queries, never one query per ancestor')
    const next=new URL(first.headers.get('link')!.match(/<([^>]+)>/)[1])
    const second=await f.request(next.pathname.replace('/api/v1/repos/acme/repo','')+next.search)
    assert.equal(second.status,200);assert.deepEqual((await second.json()).map((c:any)=>c.sha),[SHA(3),SHA(1)])
    const statement=f.statements.findLast(s=>s.query.includes('ORDER BY n.time'))!
    const plan=f.db.prepare('EXPLAIN QUERY PLAN '+statement.query).all(...statement.args)
    assert.ok(plan.some((row:any)=>/prepared_history_page/.test(row.detail)))
    console.log(JSON.stringify({effect:'history-indexed-pages',plan,returnedRows:f.effects().returnedRows-before.returnedRows}))
    const exact=await f.request('/commits?sha='+SHA(4)+'&per_page=100');assert.equal(exact.status,200)
    assert.equal((await f.request('/commits?sha=branch%2Fwith-slash')).status,503,'observed ref exists but its history is not prepared')
    assert.equal((await f.request('/commits?sha=not-a-ref')).status,404)
    assert.equal((await f.request('/commits?sha=0000')).status,404,'no abbreviated-SHA guess')
  }finally{f.close()}
})

test('history certificate rejects truncated/orphan/missing-parent membership, unhydrated facts and fake immutable replacements',async()=>{
  const f=await fixture();try{
    await assert.rejects(publishPreparedRepositoryHistory(f.sql as any,'id-repo',SHA(4),[commit(4,[2])],false),/incomplete/)
    await stagePreparedRepositoryHistory(f.sql as any,'id-repo',SHA(4),[commit(4,[2])])
    assert.equal(await publishPreparedRepositoryHistoryReceipt(f.sql as any,'id-repo',SHA(4),1),false,'missing parent never ready')
    assert.equal((await f.request()).status,503)
    await stagePreparedRepositoryHistory(f.sql as any,'id-repo',SHA(4),[commit(2,[1]),commit(1)])
    await stagePreparedRepositoryHistory(f.sql as any,'id-repo',SHA(4),[commit(77)])
    assert.equal(await publishPreparedRepositoryHistoryReceipt(f.sql as any,'id-repo',SHA(4),4),false,'orphan cannot fake count')
    f.db.prepare('DELETE FROM prepared_history_nodes WHERE sha=?').run(SHA(77))
    assert.equal(await publishPreparedRepositoryHistoryReceipt(f.sql as any,'id-repo',SHA(4),3),true)
    const incomplete={...commit(8),committer_name:undefined}
    await assert.rejects(publishPreparedHistoryCommits(f.sql as any,'id-repo',[incomplete]),/not hydrated/)
    await assert.rejects(publishPreparedHistoryCommits(f.sql as any,'id-repo',[{...commit(4,[2]),message:'fake'}]),/Conflicting immutable/)
    assert.equal((await f.request()).status,200)
  }finally{f.close()}
})

test('single commit waits for real first-parent file facts, retains patch/blob/stats and explicit proven absence',async()=>{
  const f=await fixture();try{
    assert.equal((await f.request('/commits/'+SHA(4))).status,503)
    await publishPreparedHistoryCommits(f.sql as any,'id-repo',[commit(4,[2])])
    assert.equal((await f.request('/commits/'+SHA(4))).status,503,'known commit lacks actual file data')
    await assert.rejects(publishPreparedHistoryDetails(f.sql as any,'id-repo',commit(4,[2]),diff(1,4)),/actual first-parent/)
    await publishPreparedHistoryDetails(f.sql as any,'id-repo',commit(4,[2]),diff(2,4))
    await assert.rejects(publishPreparedHistoryDetails(f.sql as any,'id-repo',commit(4,[2]),diff(2,4,[])),/Conflicting immutable commit file/)
    const response=await f.request('/commits/'+SHA(4));assert.equal(response.status,200)
    const body=await response.json();assert.deepEqual(body.stats,{additions:2,deletions:1,total:3})
    assert.equal(body.files[0].sha,SHA(999));assert.equal(body.files[0].patch,'@@ -1 +1 @@\n-old\n+new\n+second')
    assert.equal(body.parents[0].sha,SHA(2));assert.match(body.files[0].contents_url,/contents\/src\/main.ts$/)
    assert.equal((await f.request('/commits/'+SHA(9999))).status,503,'unknown object is Pending')
    await publishPreparedHistoryMissing(f.sql as any,'id-repo',SHA(9999))
    assert.equal((await f.request('/commits/'+SHA(9999))).status,404,'observed absence is 404')
    await publishPreparedHistoryDetails(f.sql as any,'id-repo',commit(9999),diff(null,9999,[]))
    const recovered=await f.request('/commits/'+SHA(9999));assert.equal(recovered.status,200);assert.deepEqual((await recovered.json()).files,[],'actual observed root has zero changes')
  }finally{f.close()}
})

test('prepared compare reuses real legacy merge-base/count/order, serves bounded pages, rejects wrong diff provenance',async()=>{
  const f=await fixture();try{
    // Native actual IndexStore is the producer graph source, not a mocked
    // ready response. Existing comparison computes actual ancestor sets.
    const sourceDB=new DatabaseSync(':memory:'),source=new IndexStore({exec(query:string,...args:any[]){if(!args.length&&query.includes(';')){sourceDB.exec(query);return []}const statement=sourceDB.prepare(query);return statement.columns().length?statement.all(...args):(statement.run(...args),[])}} as any)
    const graph=[commit(1,[],100),commit(2,[1],300),commit(3,[1],200),commit(4,[3],400)]
    for(const c of graph)source.putCommit(c)
    const actual=graph.map(c=>source.commit(c.hash)!)
    const baseline=await comparison({ensureHistory:async()=>true,commit:async sha=>source.commit(sha),hydrate:async()=>{throw new Error('source not hydrated')}} as unknown as Index,SHA(2),SHA(4))
    assert.equal(baseline.mergeBase,SHA(1));assert.equal(baseline.ahead,2);assert.equal(baseline.behind,1)
    await assert.rejects(publishPreparedHistoryComparison(f.sql as any,'id-repo',SHA(2),SHA(4),actual,diff(2,4)),/merge base\/head/)
    assert.equal((await f.request('/compare/'+SHA(2)+'...'+SHA(4))).status,503)
    const published=await publishPreparedHistoryComparison(f.sql as any,'id-repo',SHA(2),SHA(4),actual,diff(1,4))
    assert.equal(published.state,'ready')
    const response=await f.request('/compare/'+SHA(2)+'...main?per_page=1');assert.equal(response.status,200)
    const body=await response.json();assert.equal(body.status,'diverged');assert.equal(body.ahead_by,2);assert.equal(body.behind_by,1);assert.equal(body.total_commits,2)
    assert.equal(body.merge_base_commit.sha,SHA(1));assert.equal(body.base_commit.sha,SHA(2));assert.equal(body.commits[0].sha,SHA(3));assert.match(response.headers.get('link')!,/rel="next"/)
    const second=await f.request('/compare/'+SHA(2)+'...main?per_page=1&page=2');assert.equal((await second.json()).commits[0].sha,SHA(4))
    assert.equal(body.files[0].sha,SHA(999));assert.ok(body.files[0].blob_url.includes('?ref='+SHA(4)))
    for(const [base,head,state,ahead,behind] of [[1,4,'ahead',2,0],[4,1,'behind',0,2],[4,4,'identical',0,0]] as const){
      await publishPreparedHistoryComparison(f.sql as any,'id-repo',SHA(base),SHA(head),actual,diff(state==='ahead'?1:head,head,[]))
      const r=await f.request('/compare/'+SHA(base)+'...'+SHA(head));assert.equal(r.status,200)
      const data=await r.json();assert.equal(data.status,state);assert.equal(data.ahead_by,ahead);assert.equal(data.behind_by,behind)
    }
    await publishPreparedHistoryComparison(f.sql as any,'id-repo',SHA(1),SHA(99),[commit(1,[],100),commit(99)],undefined)
    assert.equal((await f.request('/compare/'+SHA(1)+'...'+SHA(99))).status,409,'actual closed unrelated graphs are a conflict')
    sourceDB.close()
  }finally{f.close()}
})

test('current ACL/allowlist/scopes/agent membership and moving refs govern already-prepared history',async()=>{
  const f=await fixture();try{
    const graph=[commit(1),commit(4,[1])]
    await publishPreparedRepositoryHistory(f.sql as any,'id-repo',SHA(4),graph,true)
    assert.equal((await f.request('/commits','gf_outsider')).status,404)
    assert.equal((await f.request('/commits','gf_wrong')).status,403)
    assert.equal((await f.request('/commits','gf_no_scope')).status,403)
    f.db.prepare('INSERT INTO org_members VALUES (?,?,?,?)').run('acme','alice','owner','now')
    assert.equal((await f.request('/commits','gf_agent')).status,404,'agent cannot inherit sponsor org membership')
    assert.equal((await f.request('/commits','gf_granted')).status,200)
    f.db.prepare('UPDATE agents SET suspended_at=? WHERE name=?').run('now','alice/granted')
    assert.equal((await f.request('/commits','gf_granted')).status,401)
    f.db.prepare('DELETE FROM org_members WHERE org=? AND member=?').run('acme','alice')
    f.db.prepare('UPDATE repo_access SET pending=1 WHERE id=?').run('id-repo')
    assert.equal((await f.request('/commits')).status,404,'revoked collaborator cannot learn prepared state')
    assert.equal((await f.request('/commits','gf_owner')).status,503)
    await f.store.publishRepoAccess('id-repo','meta',{visibility:'private',read:['@alice']})
    await fencePreparedRefs(f.sql as any,'id-repo')
    assert.equal((await f.request('/commits')).status,503,'moving ref does not expose old tip history')
    assert.equal((await f.request('/commits?sha='+SHA(4))).status,200,'explicit immutable SHA independent of moving ref')
    const epoch=await preparedRefsEpoch(f.sql as any,'id-repo')
    await publishPreparedRefs(f.sql as any,'id-repo',epoch,{...f.refs,refs:[{kind:'branch',name:'main',hash:SHA(8)}]})
    assert.equal((await f.request('/commits')).status,503,'new advertised tip unknown, never empty')
    f.db.prepare('UPDATE settings_entities SET deleted_at=1 WHERE id=?').run('id-repo')
    assert.equal((await f.request('/commits?sha='+SHA(4))).status,404,'lifecycle checked before immutable facts')
  }finally{f.close()}
})


test('actual workerd D1 stages/certifies producer histories and serves commit/compare window pages',async()=>{
  const mf=new Miniflare({telemetry:{enabled:false},resourceTmpPath:process.cwd()+'/.tmp/miniflare',workers:[{config:{name:'history-fixture',compatibilityDate:'2026-10-06',manifest:{mainModule:'fixture.mjs',modules:{'fixture.mjs':{type:'esm',contents:'export default {fetch(){return new Response("fixture")}}'}}},env:{DB:{type:'d1',id:'history-fixture'}}}}]})
  const f=await fixture()
  try{
    const db=await mf.getD1Database('DB')
    for(const file of readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort()){
      const chunks=readFileSync('migrations/'+file,'utf8').replace(/^--.*$/gm,'').match(/\s*CREATE TRIGGER[\s\S]*?END;|[^;]+;/g)??[]
      for(const statement of chunks)await db.prepare(statement).run()
    }
    for(const table of ['orgs','org_members','owner_names','settings_entities','repo_access','repo_listing','prepared_catalogues','prepared_repositories','prepared_repository_refs']){
      for(const row of f.db.prepare('SELECT * FROM '+table).all()){
        const keys=Object.keys(row)
        await db.prepare('INSERT OR REPLACE INTO '+table+' ('+keys.join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')').bind(...Object.values(row)).run()
      }
    }
    const graph=[commit(1),commit(2,[1]),commit(3,[1]),commit(4,[2,3])]
    assert.equal(await publishPreparedRepositoryHistory(db as any,'id-repo',SHA(4),graph,true),true)
    await publishPreparedHistoryDetails(db as any,'id-repo',commit(4,[2,3]),diff(2,4))
    await publishPreparedHistoryComparison(db as any,'id-repo',SHA(2),SHA(4),graph,diff(2,4))
    const reader=new PreparedRepositoryHistory(db as any)
    const context=(id:string,params:Record<string,string>={}):Context=>({request:new Request('https://gild.test/api/v1/repos/acme/repo/commits'),route:routes.find(r=>r.id===id)!,params:{owner:'acme',repo:'repo',...params},query:{per_page:2,page:1},body:{},principal:{id:'fixture',name:'alice',publicKey:'fixture',scopes:['repo:read'],repos:null}})
    const history=await reader.read(context('commits'))
    assert.deepEqual((history.data as any[]).map(c=>c.sha),[SHA(4),SHA(3)]);assert.equal(history.noStore,true)
    const detail=await reader.read(context('commit',{sha:SHA(4)}));assert.equal((detail.data as any).files[0].sha,SHA(999))
    const compare=await reader.read(context('compare',{base:SHA(2),head:'main'}))
    assert.equal((compare.data as any).merge_base_commit.sha,SHA(2));assert.equal((compare.data as any).ahead_by,2)
    console.log(JSON.stringify({effect:'workerd-d1-history',historyCount:2,commitFiles:1,compareAhead:2,noStore:history.noStore}))
  }finally{f.close();await mf.dispose()}
})

test('history GET byte caps return Pending without fabricated/truncated records; small page stays usable',async()=>{
  const f=await fixture();try{
    await assert.rejects(publishPreparedHistoryComparison(f.sql as any,'id-repo',SHA(8000),SHA(8000),[commit(8000)],diff(8000,8000)),/Identical commit diff/)
    const graph=Array.from({length:8},(_,i)=>({...commit(i+1,i?[i]:[]),message:'observed '+'x'.repeat(850*1024)}))
    await assert.rejects(publishPreparedHistoryCommits(f.sql as any,'id-repo',graph.slice(0,3)),/staging bound/)
    assert.equal(await publishPreparedRepositoryHistory(f.sql as any,'id-repo',SHA(8),graph,true),true)
    const pending=await f.request('/commits?sha='+SHA(8)+'&per_page=8');assert.equal(pending.status,503)
    assert.equal((await pending.json()).errors[0].code,'PREPARATION_PENDING')
    const small=await f.request('/commits?sha='+SHA(8)+'&per_page=1');assert.equal(small.status,200)
    const data=await small.json();assert.equal(data.length,1);assert.equal(data[0].commit.message,graph[7].message)
    const missing=await f.request('/commits?sha='+SHA(8888));assert.equal(missing.status,503)
    await assert.rejects(publishPreparedHistoryDetails(f.sql as any,'id-repo',commit(20),{...diff(null,20),complete:false}),/incomplete/)
  }finally{f.close()}
})
