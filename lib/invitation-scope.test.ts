import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {readFileSync,readdirSync} from 'node:fs'
import {d1Store} from './drivers/d1.ts'
import {entity} from './settings-store.ts'
import {privacyHandler} from './collaborators.ts'
import {dispatch,type Dependencies} from './api/dispatch.ts'
import {service,type Services} from './api/service.ts'
import {ApiControlStore} from './api/control-store.ts'
import {hashToken,verifyStoredToken} from './token-verifier.ts'

async function fixture() {
  const db=new DatabaseSync(':memory:')
  for(const file of readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync('migrations/'+file,'utf8'))
  const prepare=(query:string,args:any[]=[])=>({
    bind:(...values:any[])=>prepare(query,values),
    async first(){return db.prepare(query).get(...args)??null},
    async all(){return {results:db.prepare(query).all(...args)}},
    async run(){return {success:true,meta:db.prepare(query).run(...args)}},
  })
  const store=d1Store({prepare,batch:async(items:any[])=>Promise.all(items.map(s=>s.all()))} as any)
  await store.createOrg('acme',null,'owner')
  await store.addOrgMember('acme','other-owner','owner')
  for(const repo of ['a','b']){
    await store.settings.putState({...entity('acme/'+repo),id:'repo-'+repo})
    await store.fenceRepoAccess('repo-'+repo,'meta-'+repo)
    await store.publishRepoAccess('repo-'+repo,'meta-'+repo,{visibility:'private',read:[],write:[]})
    await store.inviteRepo({id:'invite-'+repo,repo:'repo-'+repo,invitee:'alice',permission:'write',inviter:'owner',created_at:'2026-10-12T00:00:00Z'})
  }
  await store.saveApiToken(await hashToken('gf_scoped'),'alice','fixture-public-key',Date.now()+60000,{scopes:['repo:read','repo:write'],repos:['acme/a']})
  await store.saveApiToken(await hashToken('gf_unrestricted'),'alice','fixture-public-key',Date.now()+60000,{scopes:['repo:read','repo:write']})
  let aclWrites=0,invitationRemoves=0
  const remove=store.removeInvitation.bind(store)
  store.removeInvitation=async id=>{invitationRemoves++;await remove(id)}
  const privacy=privacyHandler({store,index:async()=>null},{acl:async(owner,repo,_by,change)=>{
    aclWrites++
    const state=await store.settings.state(owner+'/'+repo),access=await store.getRepoAccess(state.id)
    assert.ok(access,'Write must target the current stored repository')
    change(access.acl)
    const meta='changed-'+aclWrites
    await store.fenceRepoAccess(state.id,meta);assert.equal(await store.publishRepoAccess(state.id,meta,access.acl),true)
  }})
  const handlers=service({store,index:async()=>null,privacy} as unknown as Services)
  const controls=new Map<string,ApiControlStore>(),controlDBs:DatabaseSync[]=[]
  const deps:Dependencies={...handlers,
    authenticate:async request=>{
      if(request.headers.get('cookie')==='disposable-browser')return {id:'browser:alice',name:'alice',publicKey:'fixture-public-key',scopes:null,repos:null}
      const token=request.headers.get('authorization')?.match(/^Bearer (gf_\w+)$/)?.[1]
      if(!token)return null
      const value=await verifyStoredToken(token,store)
      if(!value?.name)return null
      return {id:await hashToken(token),name:value.name,publicKey:value.publicKey,scopes:value.scopes,repos:value.repos?await Promise.all(value.repos.map(r=>store.settings.canonical(r))):null}
    },
    control:async id=>{
      if(!controls.has(id)){
        const sql=new DatabaseSync(':memory:');controlDBs.push(sql)
        controls.set(id,new ApiControlStore({exec(query:string,...args:any[]){
          if(!args.length&&query.includes(';')){sql.exec(query);return []}
          const statement=sql.prepare(query);if(statement.columns().length)return statement.all(...args);statement.run(...args);return []
        }} as any))
      }
      return controls.get(id)!
    },
  }
  return {store,db,effects:()=>({aclWrites,invitationRemoves}),close:()=>{db.close();for(const c of controlDBs)c.close()},
    request:(method='GET',id='',auth='scoped')=>dispatch(new Request('https://gild.test/api/v1/user/repository_invitations'+(id?'/'+id:''),{method,headers:auth==='browser'?{cookie:'disposable-browser'}:{authorization:'Bearer gf_'+auth}}),deps)}
}

for(const method of ['PATCH','DELETE'])test('A-scoped token cannot '+method+' B invitation or change its ACL/store row',async()=>{
  const f=await fixture()
  try{
    const before=await f.store.getRepoAccess('repo-b'),response=await f.request(method,'invite-b')
    assert.deepEqual(f.effects(),{aclWrites:0,invitationRemoves:0},'Out-of-scope invitation must cause zero ACL writes and removals')
    assert.equal(response.status,404)
    assert.deepEqual(await f.store.getRepoAccess('repo-b'),before)
    assert.equal((await f.store.invitations('repo-b','alice')).length,1)
    const missing=await f.request(method,'not-an-invitation');assert.equal(missing.status,404);assert.equal(await response.text(),await missing.text(),'Private denial must match a missing invitation')
  }finally{f.close()}
})

test('A-scoped token lists only A opaque invitation and never removes hidden B',async()=>{
  const f=await fixture()
  try{const response=await f.request();assert.equal(response.status,200);assert.deepEqual(await response.json(),[{id:'invite-a',permission:'write'}]);assert.deepEqual(f.effects(),{aclWrites:0,invitationRemoves:0});assert.equal((await f.store.invitations()).length,2)}finally{f.close()}
})

test('In-scope acceptance and decline produce only their intended D1 effects',async()=>{
  for(const method of ['PATCH','DELETE']){
    const f=await fixture()
    try{assert.equal((await f.request(method,'invite-a')).status,200);assert.deepEqual(f.effects(),{aclWrites:method==='PATCH'?1:0,invitationRemoves:1});assert.deepEqual((await f.store.getRepoAccess('repo-a'))!.acl.write,method==='PATCH'?['@alice']:[]);assert.equal((await f.store.invitations('repo-a','alice')).length,0);assert.equal((await f.store.invitations('repo-b','alice')).length,1)}finally{f.close()}
  }
})

test('Unrestricted browser principal retains listing and B acceptance/decline',async()=>{
  for(const method of ['PATCH','DELETE']){
    const f=await fixture()
    try{assert.deepEqual(await(await f.request('GET','','browser')).json(),[{id:'invite-a',permission:'write'},{id:'invite-b',permission:'write'}]);assert.equal((await f.request(method,'invite-b','browser')).status,200);assert.deepEqual(f.effects(),{aclWrites:method==='PATCH'?1:0,invitationRemoves:1})}finally{f.close()}
  }
})

test('Acceptance preserves inviter revalidation and unrestricted stale-deleted decline cleanup',async()=>{
  for(const stale of ['inviter','deleted','missing']){
    const f=await fixture()
    try{
      if(stale==='inviter')await f.store.removeOrgMember('acme','owner')
      else if(stale==='deleted')await f.store.settings.putState({...await f.store.settings.state('acme/b'),deletedAt:Date.now()})
      else await f.store.inviteRepo({id:'invite-missing',repo:'unmapped-id',invitee:'alice',permission:'read',inviter:'owner',created_at:'now'})
      const id=stale==='missing'?'invite-missing':'invite-b'
      assert.equal((await f.request('PATCH',id,'browser')).status,404);assert.deepEqual(f.effects(),{aclWrites:0,invitationRemoves:0})
      assert.equal((await f.request('DELETE',id,'browser')).status,200);assert.deepEqual(f.effects(),{aclWrites:0,invitationRemoves:1})
    }finally{f.close()}
  }
})

test('Scoped checks use current repository entity after rename and case-insensitive allowed target',async()=>{
  const f=await fixture()
  try{
    await f.store.settings.rename('acme/b','acme/renamed',false)
    assert.equal((await f.request('DELETE','invite-b')).status,404);assert.deepEqual(f.effects(),{aclWrites:0,invitationRemoves:0})
    await f.store.saveApiToken(await hashToken('gf_renamed'),'alice','fixture-public-key',Date.now()+60000,{scopes:['repo:read','repo:write'],repos:['ACME/RENAMED']})
    assert.equal((await f.request('PATCH','invite-b','renamed')).status,200);assert.deepEqual(f.effects(),{aclWrites:1,invitationRemoves:1});assert.deepEqual((await f.store.getRepoAccess('repo-b'))!.acl.write,['@alice'])
  }finally{f.close()}
})
