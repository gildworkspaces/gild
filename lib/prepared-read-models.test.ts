import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {readFileSync,readdirSync} from 'node:fs'
import {d1Store} from './drivers/d1.ts'
import {entity,emptyProfile} from './settings-store.ts'
import {PreparedReadModels} from './prepared-read-models.ts'
import {publishPreparedCatalogue,reconcilePreparedCatalogue} from './prepared-catalogue-producer.ts'
import {dispatch,type Dependencies} from './api/dispatch.ts'
import {service,type Services} from './api/service.ts'
import {ApiControlStore} from './api/control-store.ts'
import {hashToken,verifyStoredToken} from './token-verifier.ts'
import {PREPARATION_PENDING} from './api/read-contract.ts'
import {build} from 'esbuild'
import {fencePreparedRefs,preparedRefsEpoch,publishPreparedRefs,publishPreparedHealth,publishPreparedDiff,publishPreparedPullHeads} from './prepared-repository-producer.ts'
import {scoreCacheKey} from './cqx-score-cache.ts'
import {CHANGE_VERSION} from './api/change-version.ts'
import {preparedHealth} from './api/prepared-health.ts'
import {preparedChangePage} from './prepared-change-walk.ts'

async function fixture(){
  const db=new DatabaseSync(':memory:')
  for(const file of readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync('migrations/'+file,'utf8'))
  let readOnly=false,queries=0,producerCalls=0
  const prepare=(query:string,args:any[]=[])=>({
    bind:(...values:any[])=>prepare(query,values),
    async first(){queries++;if(readOnly)assert.match(query,/^\s*(SELECT|WITH)\b/i);return db.prepare(query).get(...args)??null},
    async all(){queries++;if(readOnly)assert.match(query,/^\s*(SELECT|WITH)\b/i);return {results:db.prepare(query).all(...args)}},
    async run(){assert.equal(readOnly,false,'prepared GET must not write/prep its data');return {success:true,meta:db.prepare(query).run(...args)}},
  })
  const sql={prepare,batch:async(items:any[])=>{
    assert.equal(readOnly,false,'prepared GET must not call producer batch')
    db.exec('BEGIN');try{const result=[];for(const s of items)result.push(await s.run());db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}
  }}
  // The actual store's read batches use all(); native fixture supports both
  // kinds without replacing the SQL statements or authorization code.
  const store=d1Store({...sql,batch:async(items:any[])=>Promise.all(items.map(s=>s.all()))} as any)
  db.prepare('INSERT INTO claims VALUES (?,?,?,?,?)').run('alice','alice-public','private-alice@example.test',1,'2026-01-01')
  db.prepare('INSERT INTO claims VALUES (?,?,?,?,?)').run('empty','empty-public','private-empty@example.test',1,'2026-01-01')
  await store.createOrg('acme',null,'owner')
  await store.settings.saveProfile('alice',{...emptyProfile(),displayName:'Alice',publicEmail:'public@example.test',description:'Public bio'})
  for(const repo of ['a','b']){
    await store.settings.putState({...entity('acme/'+repo),id:'repo-'+repo})
    await store.fenceRepoAccess('repo-'+repo,'meta-'+repo)
    await store.publishRepoAccess('repo-'+repo,'meta-'+repo,{visibility:'private',read:['@alice']})
    await store.putListing('repo-'+repo,1,{tip:repo.repeat(40),meta:'meta-'+repo,acl:{visibility:'private'},issues:2,pulls:3,updated:1000,
      factsTip:repo.repeat(40),facts:{language:{name:'TypeScript',color:'#00f'},license:'MIT',updated:1000,weeks:{'2026-01-05':2}}} as any)
  }
  const rows=['a','b'].map(name=>({name,id:'repo-'+name,description:'Stored '+name,defaultBranch:'main',createdAt:null,updatedAt:null}))
  await publishPreparedCatalogue(sql as any,'acme',rows,100)
  await publishPreparedCatalogue(sql as any,'empty',[],100)
  await store.saveApiToken(await hashToken('gf_scoped'),'alice','alice-public',Date.now()+60000,{scopes:['repo:read'],repos:['acme/a']})
  await store.saveApiToken(await hashToken('gf_unrestricted'),'alice','alice-public',Date.now()+60000,{scopes:['repo:read']})
  const forbidden=async()=>{producerCalls++;throw new Error('Git/index/scorer/build producer disabled for GET')}
  const models=new PreparedReadModels(sql as any),handlers=service({readModels:models,store:new Proxy(store,{get(){throw new Error('Legacy store fallback disabled')}}),index:forbidden,catalog:forbidden,health:forbidden} as unknown as Services)
  const controls=new Map<string,ApiControlStore>(),controlDBs:DatabaseSync[]=[]
  const deps:Dependencies={...handlers,authenticate:async request=>{
    if(request.headers.get('cookie')==='fixture-owner')return {id:'owner',name:'owner',publicKey:'fixture-public',scopes:null,repos:null}
    const token=request.headers.get('authorization')?.match(/^Bearer (gf_\w+)$/)?.[1]
    if(!token)return null
    const value=await verifyStoredToken(token,store);return value?.name?{id:await hashToken(token),name:value.name,publicKey:value.publicKey,scopes:value.scopes,repos:value.repos}:null
  },control:async id=>{
    if(!controls.has(id)){
      const c=new DatabaseSync(':memory:');controlDBs.push(c)
      controls.set(id,new ApiControlStore({exec(query:string,...args:any[]){if(!args.length&&query.includes(';')){c.exec(query);return []}const s=c.prepare(query);if(s.columns().length)return s.all(...args);s.run(...args);return []}} as any))
    }
    return controls.get(id)!
  }}
  return {db,sql,store,models,rows,effects:()=>({producerCalls,queries}),close:()=>{db.close();for(const c of controlDBs)c.close()},
    async request(path='/owners/acme/repositories',auth='scoped'){
      readOnly=true
      const oldFetch=globalThis.fetch;globalThis.fetch=forbidden as any
      try{return await dispatch(new Request('https://gild.test/api/v1'+path,{headers:auth==='owner'?{cookie:'fixture-owner'}:auth==='anonymous'?{'cf-connecting-ip':'192.0.2.1'}:{authorization:'Bearer gf_'+auth}}),deps)}
      finally{readOnly=false;globalThis.fetch=oldFetch}
    }}
}

test('canonical generated client preserves typed Pending from registered dispatch and native D1',async()=>{
  const compiled=await build({entryPoints:['lib/api/client.ts'],bundle:true,platform:'node',format:'esm',write:false})
  const {GildClient,ApiRequestError}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].contents).toString('base64'))
  const f=await fixture();try{
    const client=new GildClient('https://gild.test/api/v1','gf_unrestricted',async(input:URL)=>f.request(input.pathname.replace('/api/v1',''),'unrestricted'))
    f.db.prepare('DELETE FROM prepared_catalogues WHERE owner=?').run('acme')
    await assert.rejects(client.request('ownerRepoCards',{owner:'acme'}),(error:any)=>{
      assert.ok(error instanceof ApiRequestError);assert.equal(error.status,503);assert.equal(error.code,PREPARATION_PENDING)
      assert.deepEqual(error.codes,[PREPARATION_PENDING]);return true
    })
    await assert.rejects(client.request('ownerRepoCards',{owner:'unknown'}),(error:any)=>{
      assert.equal(error.status,404);assert.notEqual(error.code,PREPARATION_PENDING);return true
    })
    assert.equal(f.effects().producerCalls,0)
  }finally{f.close()}
})

test('registered legacy branch/ref reads preserve success shapes with all Git/index/network ports disabled',async()=>{
  const f=await fixture();try{
    const refs={ready:true,meta:'meta-a',defaultBranch:'main',refs:[
      {kind:'branch' as const,name:'main',hash:'a'.repeat(40)},
      {kind:'branch' as const,name:'topic/with-slash',hash:'b'.repeat(40)},
      {kind:'tag' as const,name:'v1',hash:'c'.repeat(40)},
    ]}
    const epoch=await preparedRefsEpoch(f.sql as any,'repo-a')
    await publishPreparedRefs(f.sql as any,'repo-a',epoch,refs)
    const queriesBefore=f.effects().queries
    const branches=await f.request('/repos/acme/a/branches?per_page=1')
    assert.ok(f.effects().queries-queriesBefore<=6,'one document read must not repeat ACL SQL at dispatch/authorize/execute')
    assert.equal(branches.status,200);assert.match(branches.headers.get('cache-control')!,/no-store/)
    assert.match(branches.headers.get('link')!,/cursor=.+; rel="next"/)
    const next=new URL(branches.headers.get('link')!.match(/<([^>]+)>/)![1])
    const second=await f.request(next.pathname.replace('/api/v1','')+next.search)
    assert.equal((await second.json())[0].name,'topic/with-slash')
    const body=await branches.json();assert.equal(body[0].name,'main');assert.equal(body[0].protected,true);assert.equal(body[0].commit.sha,'a'.repeat(40))
    const all=await f.request('/repos/acme/a/git/refs');assert.equal(all.status,200)
    assert.deepEqual((await all.json()).map((r:any)=>r.ref),['refs/heads/main','refs/heads/topic/with-slash','refs/tags/v1'])
    const slash=await f.request('/repos/acme/a/git/ref/heads/topic/with-slash');assert.equal(slash.status,200)
    assert.equal((await slash.json()).object.sha,'b'.repeat(40))
    assert.equal((await f.request('/repos/acme/a/git/ref/heads/missing')).status,404)
    assert.equal((await f.request('/repos/acme/a/git/refs','anonymous')).status,404)
    assert.equal((await f.request('/repos/acme/b/git/refs')).status,404)
    assert.equal(f.effects().producerCalls,0)
  }finally{f.close()}
})
test('ref receipts distinguish ready empty, unprepared, known authorized Pending and nonexistent repos',async()=>{
  const f=await fixture();try{
    assert.equal((await f.request('/repos/acme/a/git/refs')).status,503)
    const epoch=await preparedRefsEpoch(f.sql as any,'repo-a')
    await publishPreparedRefs(f.sql as any,'repo-a',epoch,{ready:false,meta:'meta-a',defaultBranch:'main',refs:[]})
    assert.equal((await f.request('/repos/acme/a/git/refs')).status,503,'unprepared cannot masquerade as ready empty')
    await publishPreparedRefs(f.sql as any,'repo-a',epoch,{ready:true,meta:'meta-a',defaultBranch:'main',refs:[]})
    const empty=await f.request('/repos/acme/a/git/refs');assert.equal(empty.status,200);assert.deepEqual(await empty.json(),[])
    f.db.prepare('DELETE FROM prepared_catalogues WHERE owner=?').run('acme')
    const started=performance.now(),known=await f.request('/repos/acme/a/git/refs')
    assert.equal(known.status,503,'current ACL authorizes known repo BEFORE catalogue Pending')
    assert.equal((await known.json()).errors[0].code,PREPARATION_PENDING);assert.ok(performance.now()-started<500)
    assert.equal((await f.request('/repos/acme/missing/git/refs')).status,404)
    assert.equal((await f.request('/repos/acme/a/git/refs','anonymous')).status,404,'unknown preparation must not leak private identity')
    assert.equal(f.effects().producerCalls,0)
  }finally{f.close()}
})
test('producer ref epoch cannot clear a newer push fence; current ACL remains independent',async()=>{
  const f=await fixture();try{
    const refs={ready:true,meta:'meta-a',defaultBranch:'main',refs:[{kind:'branch' as const,name:'main',hash:'a'.repeat(40)}]}
    const epoch=await preparedRefsEpoch(f.sql as any,'repo-a')
    await publishPreparedRefs(f.sql as any,'repo-a',epoch,refs)
    assert.equal((await f.request('/repos/acme/a/git/refs')).status,200)
    await fencePreparedRefs(f.sql as any,'repo-a')
    assert.equal((await f.request('/repos/acme/a/git/refs')).status,503,'accepted push must hide the previously prepared refs')
    await publishPreparedRefs(f.sql as any,'repo-a',epoch,refs)
    assert.equal((await f.request('/repos/acme/a/git/refs')).status,503,'older awaited publication cannot clear newer fence')
    await publishPreparedRefs(f.sql as any,'repo-a',await preparedRefsEpoch(f.sql as any,'repo-a'),refs)
    assert.equal((await f.request('/repos/acme/a/git/refs')).status,200)
    f.db.prepare('UPDATE repo_access SET pending=1 WHERE id=?').run('repo-a')
    assert.equal((await f.request('/repos/acme/a/git/refs')).status,404,'cached refs cannot bypass revoked/current ACL fence')
    assert.equal((await f.request('/repos/acme/a/git/refs','owner')).status,503)
    assert.equal(f.effects().producerCalls,0)
  }finally{f.close()}
})

test('health reads use prepared immutable version keys only; absent and prepared null remain distinct',async()=>{
  const f=await fixture();try{
    const sha='a'.repeat(40),key=scoreCacheKey('acme','a',sha)
    assert.equal((await f.request('/repos/acme/a/health/'+sha)).status,503,'missing report must not invoke scorer')
    await publishPreparedHealth(f.sql as any,'repo-a',key+'-old-version',sha,null)
    assert.equal((await f.request('/repos/acme/a/health/'+sha)).status,503,'another tool version must not satisfy this version')
    await publishPreparedHealth(f.sql as any,'repo-a',key,sha,null)
    const response=await f.request('/repos/acme/a/health/'+sha)
    assert.equal(response.status,200);assert.equal(await response.json(),null,'actual prepared unscored commit remains null')
    assert.equal((await f.request('/repos/ACME/A/health/'+sha)).status,200,'stored version identity uses canonical case')
    assert.equal((await f.request('/repos/acme/a/health/'+sha,'anonymous')).status,401,'health keeps its existing authenticated boundary')
    assert.equal(f.effects().producerCalls,0)
  }finally{f.close()}
})
test('partial health semantics, moving ref fences and complete immutable report survive producer outages',async()=>{
  const f=await fixture();try{
    const sha='a'.repeat(40),key=scoreCacheKey('acme','a',sha)
    const partial={lines:0,incomplete:'c-family-unavailable',scores:{quality:1,containment:1,legibility:1,security:1,modularity:1},rules:[],calibrated:false}
    await publishPreparedHealth(f.sql as any,'repo-a',key,sha,partial as any,100)
    const failed=await f.request('/repos/acme/a/health/'+sha);assert.equal(failed.status,200)
    assert.equal((await failed.json()).scores,null);assert.match(failed.headers.get('cache-control')!,/no-store/)
    const refs={ready:true,meta:'meta-a',defaultBranch:'main',refs:[{kind:'branch' as const,name:'main',hash:sha}]}
    await publishPreparedRefs(f.sql as any,'repo-a',await preparedRefsEpoch(f.sql as any,'repo-a'),refs)
    const branch=await f.request('/repos/acme/a/health?ref=main');assert.equal(branch.status,200)
    assert.equal((await branch.json()).incomplete,'c-family-unavailable')
    await fencePreparedRefs(f.sql as any,'repo-a')
    assert.equal((await f.request('/repos/acme/a/health?ref=main')).status,503,'moving ref cannot resolve old tip after push')
    assert.equal((await f.request('/repos/acme/a/health/'+sha)).status,200,'authorized immutable report is independent of moving ref preparation')
    const complete={lines:3,scores:{quality:100,containment:100,legibility:100,security:100,modularity:100},rules:[],calibrated:false}
    await publishPreparedHealth(f.sql as any,'repo-a',key,sha,complete as any,200)
    await publishPreparedHealth(f.sql as any,'repo-a',key,sha,partial as any,300)
    assert.deepEqual(await(await f.request('/repos/acme/a/health/'+sha)).json(),complete,'producer outage must not replace complete immutable result')
    f.db.prepare('UPDATE repo_access SET pending=1 WHERE id=?').run('repo-a')
    assert.equal((await f.request('/repos/acme/a/health/'+sha)).status,404,'immutable report never bypasses current ACL')
    assert.equal(f.effects().producerCalls,0)
  }finally{f.close()}
})

test('health hex-named branch resolves advertised tip and moving fence, never an unrelated report prefix',async()=>{
 const f=await fixture();try{
  const advertised='a'.repeat(40),other='dead'+'b'.repeat(36)
  const complete={lines:3,scores:{quality:100,containment:100,legibility:100,security:100,modularity:100},rules:[],calibrated:false}
  const epoch=await preparedRefsEpoch(f.sql as any,'repo-a')
  await publishPreparedRefs(f.sql as any,'repo-a',epoch,{ready:true,meta:'meta-a',defaultBranch:'main',refs:[
   {kind:'branch',name:'main',hash:advertised},{kind:'branch',name:'dead',hash:advertised},
  ]})
  await publishPreparedHealth(f.sql as any,'repo-a',scoreCacheKey('acme','a',advertised),advertised,null)
  await publishPreparedHealth(f.sql as any,'repo-a',scoreCacheKey('acme','a',other),other,complete as any)
  const named=await f.request('/repos/acme/a/health?ref=dead');assert.equal(named.status,200)
  assert.equal(await named.json(),null,'hex named ref must equal advertised SHA report, not another commit prefix')
  assert.equal(await(await f.request('/repos/acme/a/health?ref=refs/heads/dead')).json(),null)
  assert.equal((await f.request('/repos/acme/a/health?ref=deadbbbb')).status,404,'unadvertised short hex is not a new lookup capability')
  await fencePreparedRefs(f.sql as any,'repo-a')
  assert.equal((await f.request('/repos/acme/a/health?ref=dead')).status,503,'hex-named branch obeys moving ref fence')
  assert.deepEqual(await(await f.request('/repos/acme/a/health/'+other)).json(),complete,'explicit complete SHA remains independent')
  assert.equal(f.effects().producerCalls,0)
 }finally{f.close()}
})

test('commit diff GET reads stored immutable facts without Git/tree walks; missing is Pending, ready empty stays empty',async()=>{
 const f=await fixture();try{
  const sha='a'.repeat(40),change={from:null,to:sha,files:[],truncated:false,total:0,sizes:[]}
  assert.equal((await f.request('/repos/acme/a/changes/'+sha)).status,503)
  await publishPreparedDiff(f.sql as any,'repo-a','commit',sha,sha,null,null,change)
  const response=await f.request('/repos/acme/a/changes/'+sha)
  assert.equal(response.status,200);assert.deepEqual(await response.json(),change)
  await publishPreparedRefs(f.sql as any,'repo-a',await preparedRefsEpoch(f.sql as any,'repo-a'),{ready:true,meta:'meta-a',defaultBranch:'main',refs:[{kind:'branch',name:'main',hash:sha}]})
  assert.equal((await f.request('/repos/acme/a/changes/'+sha.slice(0,12))).status,404,'unadvertised short hashes preserve legacy named-ref semantics')
  f.db.prepare('UPDATE prepared_repository_diffs SET version=?').run(CHANGE_VERSION+'-old')
  assert.equal((await f.request('/repos/acme/a/changes/'+sha)).status,503,'wrong diff tool version cannot satisfy preparation')
  assert.equal((await f.request('/repos/acme/a/changes/'+sha,'anonymous')).status,401)
  assert.equal(f.effects().producerCalls,0)
 }finally{f.close()}
})

test('commit diff hex-named branch uses shared advertised resolution and moving fence',async()=>{
 const f=await fixture();try{
  const advertised='a'.repeat(40),other='dead'+'b'.repeat(36),epoch=await preparedRefsEpoch(f.sql as any,'repo-a')
  const empty=(to:string)=>({from:null,to,files:[],truncated:false,total:0,sizes:[]})
  await publishPreparedRefs(f.sql as any,'repo-a',epoch,{ready:true,meta:'meta-a',defaultBranch:'main',refs:[{kind:'branch',name:'dead',hash:advertised}]})
  await publishPreparedDiff(f.sql as any,'repo-a','commit',advertised,advertised,null,null,empty(advertised))
  await publishPreparedDiff(f.sql as any,'repo-a','commit',other,other,null,null,empty(other))
  assert.equal((await(await f.request('/repos/acme/a/changes/dead')).json()).to,advertised)
  assert.equal((await f.request('/repos/acme/a/changes/deadbbbb')).status,404)
  await fencePreparedRefs(f.sql as any,'repo-a')
  assert.equal((await f.request('/repos/acme/a/changes/dead')).status,503)
  assert.equal((await f.request('/repos/acme/a/changes/'+other)).status,200)
  assert.equal(f.effects().producerCalls,0)
 }finally{f.close()}
})
test('pull diff GET validates actual current membership, metadata and BOTH resolved refs before stored payload',async()=>{
 const f=await fixture();try{
  const head='a'.repeat(40),base='b'.repeat(40),change={from:base,to:head,files:[],truncated:false,total:0,sizes:[]}
  const epoch=await preparedRefsEpoch(f.sql as any,'repo-a')
  await publishPreparedRefs(f.sql as any,'repo-a',epoch,{ready:true,meta:'meta-a',defaultBranch:'main',refs:[
   {kind:'branch',name:'feature',hash:head},{kind:'branch',name:'main',hash:base},
  ]})
  assert.equal((await f.request('/repos/acme/a/pulls/2/changes')).status,503)
  await publishPreparedPullHeads(f.sql as any,'repo-a',epoch,'meta-a',[{number:2,head:'feature',base:'main'}])
  assert.equal((await f.request('/repos/acme/a/pulls/99/changes')).status,404,'prepared membership establishes absent pull')
  assert.equal((await f.request('/repos/acme/a/pulls/2/changes')).status,503,'known pull diff still preparing')
  await publishPreparedDiff(f.sql as any,'repo-a','pull','2',head,base,'meta-a',change)
  assert.deepEqual(await(await f.request('/repos/acme/a/pulls/2/changes')).json(),change)
  await publishPreparedRefs(f.sql as any,'repo-a',epoch,{ready:true,meta:'meta-a',defaultBranch:'main',refs:[
   {kind:'branch',name:'feature',hash:head},{kind:'branch',name:'main',hash:'c'.repeat(40)},
  ]})
  assert.equal((await f.request('/repos/acme/a/pulls/2/changes')).status,503,'changed base cannot reuse old merge-base diff')
  await publishPreparedRefs(f.sql as any,'repo-a',epoch,{ready:true,meta:'meta-a',defaultBranch:'main',refs:[
   {kind:'branch',name:'feature',hash:'d'.repeat(40)},{kind:'branch',name:'main',hash:base},
  ]})
  assert.equal((await f.request('/repos/acme/a/pulls/2/changes')).status,503,'changed head cannot reuse old pull diff')
  await publishPreparedRefs(f.sql as any,'repo-a',epoch,{ready:true,meta:'meta-a',defaultBranch:'main',refs:[
   {kind:'branch',name:'feature',hash:head},{kind:'branch',name:'main',hash:base},
  ]})
  f.db.prepare('UPDATE prepared_repository_diffs SET meta=?').run('other-meta')
  assert.equal((await f.request('/repos/acme/a/pulls/2/changes')).status,503,'current metadata must match prepared pull')
  f.db.prepare('UPDATE repo_access SET pending=1 WHERE id=?').run('repo-a')
  assert.equal((await f.request('/repos/acme/a/pulls/2/changes')).status,404,'cached diff never bypasses ACL revocation')
  assert.equal(f.effects().producerCalls,0)
 }finally{f.close()}
})
test('older pull membership publication cannot overwrite a newer push epoch',async()=>{
 const f=await fixture();try{
  const epoch=await preparedRefsEpoch(f.sql as any,'repo-a')
  await publishPreparedPullHeads(f.sql as any,'repo-a',epoch,'meta-a',[{number:2,head:'feature',base:'main'}])
  await fencePreparedRefs(f.sql as any,'repo-a')
  await publishPreparedPullHeads(f.sql as any,'repo-a',await preparedRefsEpoch(f.sql as any,'repo-a'),'new-meta',[])
  await publishPreparedPullHeads(f.sql as any,'repo-a',epoch,'meta-a',[{number:2,head:'feature',base:'main'}])
  assert.equal(f.db.prepare('SELECT meta FROM prepared_pull_catalogues WHERE id=?').get('repo-a')!.meta,'new-meta','old producer must not resurrect prior pull membership')
 }finally{f.close()}
})

test('invalid producer pull membership fails before SQL and never certifies a ready-empty catalogue',async()=>{
 const f=await fixture();try{
  const epoch=await preparedRefsEpoch(f.sql as any,'repo-a')
  await publishPreparedPullHeads(f.sql as any,'repo-a',epoch,'meta-a',[{number:2,head:'feature',base:'main'}])
  const before=f.db.prepare('SELECT * FROM prepared_pull_catalogues WHERE id=?').get('repo-a')
  for(const invalid of [undefined,[{state:'open'}],[{number:2,head:'',base:'main'}],[{number:2,head:'feature',base:'main'},{number:2,head:'feature',base:'main'}]]){
   await assert.rejects(publishPreparedPullHeads(f.sql as any,'repo-a',epoch,'invalid-meta',invalid as any),/Invalid pull catalogue/)
   assert.deepEqual(f.db.prepare('SELECT * FROM prepared_pull_catalogues WHERE id=?').get('repo-a'),before,'invalid metadata must not acknowledge new ready catalogue')
  }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM prepared_pull_heads WHERE id=?').get('repo-a')!.n,1)
 }finally{f.close()}
})

test('shared API and SSR health service validates actual stored partial/null data with current policy and no producer fallback',async()=>{
 const f=await fixture();try{
  const sha='a'.repeat(40),key=scoreCacheKey('acme','a',sha)
  const partial={lines:1,incomplete:'c-family-unavailable',scores:{quality:100,containment:100,legibility:100,security:70,modularity:100},rules:[],calibrated:false,
    languages:{TypeScript:{lines:1,scores:{quality:100,containment:100,legibility:100,security:70,modularity:100},rules:[]}}}
  await publishPreparedHealth(f.sql as any,'repo-a',key,sha,partial as any)
  const principal={id:'fixture-page',name:'alice',publicKey:'alice-public',scopes:['repo:read'],repos:['acme/a']}
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('SSR must not use loopback/network')}
  try{
   const result=await preparedHealth(f.models,principal,'acme','a',sha)
   assert.deepEqual(result.report,partial,'SSR retains actual producer language facts, not a parallel partial format')
   assert.equal(result.data.incomplete,'c-family-unavailable');assert.equal(result.noStore,true)
   assert.deepEqual(await(await f.request('/repos/acme/a/health/'+sha)).json(),result.data,'HTTP uses the same canonical validated DTO')
   const emptySha='b'.repeat(40)
   await publishPreparedHealth(f.sql as any,'repo-a',scoreCacheKey('acme','a',emptySha),emptySha,null)
   const empty=await preparedHealth(f.models,principal,'acme','a',emptySha)
   assert.equal(empty.report,null);assert.equal(empty.data,null);assert.equal(empty.noStore,false)
   const zeroSha='c'.repeat(40),zero={...partial,lines:0}
   await publishPreparedHealth(f.sql as any,'repo-a',scoreCacheKey('acme','a',zeroSha),zeroSha,zero as any)
   const unavailable=await preparedHealth(f.models,principal,'acme','a',zeroSha)
   assert.equal(unavailable.data.scores,null,'unscored zero-line partial follows canonical DTO')
   assert.equal(unavailable.noStore,true)
   const {incomplete,...complete}=partial
   await publishPreparedHealth(f.sql as any,'repo-a',key,sha,complete as any)
   const recovered=await preparedHealth(f.models,principal,'acme','a',sha)
   assert.deepEqual(recovered.report,complete);assert.equal(recovered.noStore,false)
   assert.deepEqual(await(await f.request('/repos/acme/a/health/'+sha)).json(),recovered.data)

   await assert.rejects(preparedHealth(f.models,{...principal,repos:['acme/b']},'acme','a',sha),{status:404})
   f.db.prepare('UPDATE repo_access SET pending=1 WHERE id=?').run('repo-a')
   await assert.rejects(preparedHealth(f.models,principal,'acme','a',sha),{status:404})
  }finally{globalThis.fetch=originalFetch}
  assert.equal(f.effects().producerCalls,0)
 }finally{f.close()}
})

test('registered prepared cards work with Git/scorer/build/network/legacy ports disabled and filter EACH token row',async()=>{
  const f=await fixture();try{
    const response=await f.request();assert.equal(response.status,200);const body=await response.json()
    assert.deepEqual(body.items.map((r:any)=>r.name),['a'],'scoped collection must never return B')
    assert.equal(body.items[0].facts.license,'MIT');assert.equal(body.items[0].issues,2);assert.equal(body.items[0].createdAt,null,'never invent unavailable dates')
    assert.equal(body.items[0].summaryPending,false);assert.equal(f.effects().producerCalls,0)
    const all=await(await f.request('/owners/acme/repositories','unrestricted')).json();assert.deepEqual(all.items.map((r:any)=>r.name),['a','b'])
  }finally{f.close()}
})
test('current ACL fences precede Pending; owner gets typed503 while private outsider cannot see rows',async()=>{
  const f=await fixture();try{
    f.db.prepare('UPDATE repo_access SET pending=1 WHERE id=?').run('repo-a')
    const hidden=await f.request();assert.equal(hidden.status,200);assert.deepEqual((await hidden.json()).items,[],'pending ACL must not reuse collaborator access')
    const started=performance.now(),pending=await f.request('/owners/acme/repositories','owner');assert.equal(pending.status,503,'authorized owner must get Pending while fenced')
    assert.equal((await pending.json()).errors[0].code,PREPARATION_PENDING);assert.equal(pending.headers.get('retry-after'),'1');assert.ok(performance.now()-started<500,'missing prepared data bounded with no index wait')
    assert.deepEqual((await(await f.request('/owners/acme/repositories','anonymous')).json()).items,[])
    assert.equal(f.effects().producerCalls,0)
  }finally{f.close()}
})
test('known unprepared catalogue503, certified empty200, unknown owner404 are distinct',async()=>{
  const f=await fixture();try{
    f.db.prepare('DELETE FROM prepared_catalogues WHERE owner=?').run('acme')
    assert.equal((await f.request()).status,503)
    const empty=await f.request('/owners/empty/repositories');assert.equal(empty.status,200);assert.deepEqual((await empty.json()).items,[])
    assert.equal((await f.request('/owners/unknown/repositories')).status,404)
    f.db.prepare('DELETE FROM repo_listing WHERE id=?').run('repo-a');await publishPreparedCatalogue(f.sql as any,'acme',f.rows,200)
    assert.equal((await f.request()).status,503,'missing projection must not invoke DO.listing/return success')
  }finally{f.close()}
})
test('old summary provenance is explicit and new tip never receives old facts as current',async()=>{
  const f=await fixture();try{
    f.db.prepare("UPDATE repo_listing SET data=json_set(data,'$.tip',?) WHERE id=?").run('c'.repeat(40),'repo-a')
    const card=(await(await f.request()).json()).items[0];assert.equal(card.summaryPending,true);assert.equal(card.facts,null);assert.equal(card.factsTip,'a'.repeat(40))
  }finally{f.close()}
})
test('public display is safe; viewer capability derives scopes AND allowlist AND current lifecycle',async()=>{
  const f=await fixture();try{
    const response=await f.request('/owners/alice/profile','anonymous');assert.equal(response.status,200);const text=await response.text();assert.ok(text.includes('Public bio'));assert.ok(text.includes('public@example.test'));assert.ok(!text.includes('private-alice'));assert.ok(!text.includes('alice-public'));assert.ok(!text.includes('claimedAt'))
    const view=await f.request('/viewer/context?owner=acme&repo=a');assert.equal(view.status,200);const data=await view.json();assert.equal(data.repository.read,true);assert.equal(data.repository.editPackageManifest,false);assert.equal(data.repository.updateSettings,false);assert.match(view.headers.get('cache-control')!,/no-store/)
    assert.equal((await f.request('/viewer/context?owner=acme&repo=b')).status,404,'out-of-scope viewer target denied')
    assert.equal((await f.request('/viewer/context','anonymous')).status,401)
    f.db.prepare('UPDATE settings_entities SET deleted_at=1 WHERE key=?').run('acme/a');assert.equal((await f.request('/viewer/context?owner=acme&repo=a')).status,404)
  }finally{f.close()}
})
test('agent does not inherit sponsor org membership and suspended/revoked actor is denied',async()=>{
  const f=await fixture();try{
    await f.store.addOrgMember('acme','alice','member')
    f.db.prepare('INSERT INTO agents(name,sponsor,label,public_key,created_at) VALUES (?,?,?,?,?)').run('alice/worker','alice','worker','worker-public','now')
    await f.store.saveApiToken(await hashToken('gf_agent'),'alice/worker','worker-public',Date.now()+60000,{scopes:['repo:read']})
    assert.deepEqual((await(await f.request('/owners/acme/repositories','agent')).json()).items,[])
    f.db.prepare('UPDATE repo_access SET acl=? WHERE id=?').run(JSON.stringify({visibility:'private',agents:{'@alice/worker':['review']}}),'repo-a')
    assert.deepEqual((await(await f.request('/owners/acme/repositories','agent')).json()).items.map((r:any)=>r.name),['a'])
    f.db.prepare('UPDATE agents SET suspended_at=? WHERE name=?').run('now','alice/worker');assert.equal((await f.request('/owners/acme/repositories','agent')).status,401)
  }finally{f.close()}
})
test('native producer receipt covers empty/error/out-of-order catalogues and reconciles external source separately',async()=>{
  const f=await fixture();try{
    let scheduled:string[]=[]
    await reconcilePreparedCatalogue(f.sql as any,async(owner)=>owner==='alice'?[]:f.rows,async(owner,row)=>{scheduled.push(owner+'/'+row.name)},300)
    const receipt=f.db.prepare('SELECT checked_at FROM prepared_catalogues WHERE owner=?').get('alice');assert.equal(receipt!.checked_at,300,'genuine external empty catalogue has receipt')
    await publishPreparedCatalogue(f.sql as any,'acme',[f.rows[0]],400)
    await publishPreparedCatalogue(f.sql as any,'acme',f.rows,350)
    assert.deepEqual((await(await f.request('/owners/acme/repositories','unrestricted')).json()).items.map((r:any)=>r.name),['a'],'older publication cannot resurrect removed B')
    const before=f.db.prepare('SELECT checked_at FROM prepared_catalogues WHERE owner=?').get('empty')
    await assert.rejects(()=>reconcilePreparedCatalogue(f.sql as any,async()=>{throw Error('source outage')},async()=>{},500))
    assert.deepEqual(f.db.prepare('SELECT checked_at FROM prepared_catalogues WHERE owner=?').get('empty'),before,'failed source cannot certify empty')
  }finally{f.close()}
})

test('the catalogue cron re-indexes only repositories that changed outside gild',async()=>{
  const f=await fixture();try{
    // Owners rotate by oldest check; only acme has repositories in this source.
    const source=(rows:typeof f.rows)=>async(owner:string)=>owner==='acme'?rows:[]
    const run=async(rows:typeof f.rows,at:number)=>{const s:string[]=[];for(let i=0;i<5;i++)await reconcilePreparedCatalogue(f.sql as any,source(rows),async(o,r)=>{s.push(o+'/'+r.name)},at+i);return s}
    const first=f.rows.map(r=>({...r,updatedAt:'2026-10-13T00:00:00Z'}))
    assert.deepEqual((await run(first,1000)).sort(),first.map(r=>'acme/'+r.name).sort(),'first observation indexes everything')
    assert.deepEqual(await run(first,2000),[],'unchanged: nothing re-indexed')
    const pushed=first.map((r,i)=>i===0?{...r,updatedAt:'2026-10-13T01:00:00Z'}:r)
    assert.deepEqual(await run(pushed,3000),['acme/'+first[0].name],'an external push re-indexes that repository only')
  }finally{f.close()}
})

test('agent pr grant enables only non-default push; read-only scope and archived owner cap mutations',async()=>{
 const f=await fixture();try{
  f.db.prepare('INSERT INTO agents(name,sponsor,label,public_key,created_at) VALUES (?,?,?,?,?)').run('alice/worker','alice','worker','worker-public','now')
  f.db.prepare('UPDATE repo_access SET acl=? WHERE id=?').run(JSON.stringify({visibility:'private',agents:{'@alice/worker':['pr']}}),'repo-a')
  await f.store.saveApiToken(await hashToken('gf_agent'),'alice/worker','worker-public',Date.now()+60000,{scopes:['repo:read','repo:write'],repos:['acme/a']})
  const r=await f.request('/viewer/context?owner=acme&repo=a','agent');assert.equal(r.status,200);const c=(await r.json()).repository
  assert.equal(c.pushNonDefaultBranch,true,'current pr + repo:write permits non-default branch')
  assert.equal(c.pushDefaultBranch,false);assert.equal(c.editPackageManifest,false);assert.equal(c.updateSettings,false)
  await f.store.saveApiToken(await hashToken('gf_readagent'),'alice/worker','worker-public',Date.now()+60000,{scopes:['repo:read'],repos:['acme/a']})
  assert.equal((await(await f.request('/viewer/context?owner=acme&repo=a','readagent')).json()).repository.pushNonDefaultBranch,false)
  await f.store.settings.putState({...entity('acme'),archived:true})
  assert.equal((await(await f.request('/viewer/context?owner=acme&repo=a','agent')).json()).repository.pushNonDefaultBranch,false)
 }finally{f.close()}
})


test('bounded pull membership publishes beyond1000 and keeps a failed/new-epoch page uncertified',async()=>{
 const f=await fixture();try{
  const epoch=await preparedRefsEpoch(f.sql as any,'repo-a'),head='a'.repeat(40),base='b'.repeat(40)
  await publishPreparedRefs(f.sql as any,'repo-a',epoch,{ready:true,meta:'meta-a',defaultBranch:'main',refs:[{kind:'branch',name:'feature',hash:head},{kind:'branch',name:'main',hash:base}]})
  const pulls=Array.from({length:1101},(_,i)=>({number:i+2,head:'feature',base:'main'})),batch=f.sql.batch,lengths:number[]=[]
  const bounded={...f.sql,batch:async(items:any[])=>{lengths.push(items.length);assert.ok(items.length<=100);return batch(items)}}
  await publishPreparedPullHeads(bounded as any,'repo-a',epoch,'meta-a',pulls)
  const change={from:base,to:head,files:[],total:0,truncated:false,sizes:[]}
  await publishPreparedDiff(f.sql as any,'repo-a','pull','1102',head,base,'meta-a',change as any)
  assert.equal((await f.request('/repos/acme/a/pulls/1102/changes')).status,200,'actual prepared HTTP reads membership beyond1000')
  assert.equal(lengths.length,12);assert.equal(f.effects().producerCalls,0)
  let calls=0
  const failed={...f.sql,batch:async(items:any[])=>{if(++calls===2)throw Error('interrupted page');return batch(items)}}
  await assert.rejects(publishPreparedPullHeads(failed as any,'repo-a',epoch,'unfinished',pulls),/interrupted page/)
  assert.equal(f.db.prepare('SELECT meta FROM prepared_pull_catalogues WHERE id=?').get('repo-a')!.meta,'meta-a','failed chunk cannot certify new catalogue')
  calls=0
  const fenced={...f.sql,batch:async(items:any[])=>{const result=await batch(items);if(++calls===1)await fencePreparedRefs(f.sql as any,'repo-a');return result}}
  await publishPreparedPullHeads(fenced as any,'repo-a',epoch,'stale',pulls)
  assert.equal(f.db.prepare('SELECT meta FROM prepared_pull_catalogues WHERE id=?').get('repo-a')!.meta,'meta-a','new push after first page prevents stale final receipt')
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM prepared_pull_heads WHERE meta=?').get('stale')!.n,100,'only captured epoch first page wrote')
 }finally{f.close()}
})

test('persisted producer walk reaches later refs/pulls, resumes after restart and resets on changed inputs',async()=>{
 const refs=Array.from({length:207},(_,i)=>({kind:'branch' as const,name:'ref-'+i,hash:i.toString(16).padStart(40,'0')}))
 const pulls=Array.from({length:205},(_,i)=>({number:i+2,head:'feature-'+i,base:'main'}))
 let saved:string|null=null,seenRefs:string[]=[],seenPulls:number[]=[],done=false
 for(let alarm=0;alarm<10&&!done;alarm++){
  const page=await preparedChangePage(refs,pulls,'meta',saved)
  assert.ok(page.refs.length+page.pulls.length<=100,'each producer continuation bounded')
  seenRefs.push(...page.refs.map(r=>r.name));seenPulls.push(...page.pulls.map(p=>p.number))
  saved=JSON.stringify(page.next);done=page.done
 }
 assert.equal(done,true);assert.deepEqual(seenRefs,refs.map(r=>r.name));assert.deepEqual(seenPulls,pulls.map(p=>p.number))
 const unchanged=await preparedChangePage(refs,pulls,'meta',saved);assert.equal(unchanged.refs.length+unchanged.pulls.length,0)
 const changed=await preparedChangePage(refs,pulls,'new-meta',saved);assert.equal(changed.refs[0].name,'ref-0');assert.equal(changed.done,false)
 const corrupt=await preparedChangePage(refs,pulls,'meta','{bad');assert.equal(corrupt.refs[0].name,'ref-0')
 const changedHead=await preparedChangePage([{...refs[0],hash:'f'.repeat(40)},...refs.slice(1)],pulls,'meta',saved)
 assert.equal(changedHead.refs[0].hash,'f'.repeat(40),'changed tips cannot inherit completed cursor')
})
