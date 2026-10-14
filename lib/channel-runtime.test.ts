import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { build } from 'esbuild'
import { d1Store } from './drivers/d1.ts'
import { EventOutbox } from './events/outbox.ts'
import { hashToken } from './token-verifier.ts'
import { SocketAuthorization, AUTHORIZATION_MS } from './channel/authorization.ts'
import { SessionStore } from './sessions/store.ts'
import { receiptSchema } from './api/sessions-contract.ts'
mkdirSync('.tmp', {recursive:true})
const work = mkdtempSync(resolve('.tmp/channel-runtime-'))
await build({entryPoints:['lib/channel/do.ts','lib/events/hub-do.ts','lib/repo-index-do.ts','lib/repo-islands.ts'],outdir:work,banner:{js:"import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);"},outExtension:{'.js':'.mjs'},bundle:true,platform:'node',format:'esm',plugins:[{name:'workerd-base',setup(b){
  b.onResolve({filter:/^cloudflare:/},a=>({path:a.path,namespace:'workerd-base'}))
  b.onLoad({filter:/.*/,namespace:'workerd-base'},a=>({contents:a.path === 'cloudflare:workers' ? 'export class DurableObject { constructor(ctx, env) {this.ctx=ctx;this.env=env} }' : 'export function connect(){throw Error("No network in unit fixture")}',loader:'js'}))
}}]})
const {RepoChannel} = await import(join(work,'channel/do.mjs'))
const {ForgeEvents} = await import(join(work,'events/hub-do.mjs'))
const {repoIslands} = await import(join(work,'repo-islands.mjs'))
const {RepoIndex} = await import(join(work,'repo-index-do.mjs'))
rmSync(work,{recursive:true,force:true})
function sqlDB() {
  const db = new DatabaseSync(':memory:')
  const sql = {exec(q:string,...args:any[]) { if (!args.length && q.includes(';')) {db.exec(q);return []} return db.prepare(q).all(...args) as any }}
  let alarm: number|null = null
  const sockets:any[]=[]
  const ctx = {storage:{sql,transactionSync(fn:()=>unknown){db.exec('BEGIN');try{const v=fn();db.exec('COMMIT');return v}catch(e){db.exec('ROLLBACK');throw e}},getAlarm:async()=>alarm,setAlarm:async(v:number)=>{alarm=v}},getWebSockets:()=>sockets}
  return {db,sql,ctx,sockets,alarm:()=>alarm}
}
function d1() {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/'+file,'utf8'))
  const queries:string[]=[]
  const prepare = (q:string,args:any[]=[]) => ({
    bind:(...a:any[])=>prepare(q,a),
    async first(){queries.push(q);return db.prepare(q).get(...args) ?? null},
    async all(){queries.push(q);return {results:db.prepare(q).all(...args)}},
    async run(){queries.push(q);return {success:true,meta:db.prepare(q).run(...args)}},
  })
  const binding = {prepare,batch:async(items:any[])=>Promise.all(items.map(s=>s.all()))} as any
  const store = d1Store(binding)
  return {db,binding,queries,store,publish:async(id:string,meta:string,acl:any)=>{await store.fenceRepoAccess(id,meta);await store.publishRepoAccess(id,meta,acl)}}
}
function socket(name='reader',id='browser:reader',token=false) {
  let attachment={repository:'acme/demo',principal:{id,name,publicKey:'key',scopes:null,repos:null},token,seen:Date.now(),expires:null}
  return {sent:[] as string[],closed:false,deserializeAttachment:()=>attachment,serializeAttachment:(v:any)=>{attachment=v},send(v:string){this.sent.push(v)},close(){this.closed=true}}
}
test('socket fan-out caches authorization and timer revokes silent sockets within five seconds',async()=>{
  const f=sqlDB(),st=d1(),ws=socket()
  await st.publish('acme/demo','meta',{schema:1,visibility:'private',read:['@reader']})
  f.sockets.push(ws)
  const channel=new RepoChannel(f.ctx,{DB:st.binding})
  assert.deepEqual(await channel.online(),['reader'])
  const queried=st.queries.length
  for(let i=0;i<10;i++)await channel.system({id:'issue-'+i,event:'issues',repository:'acme/demo',payload:{issue:{number:i+1}}})
  assert.equal(st.queries.length,queried,'fan-out must not requery D1 for each message')
  assert.equal(ws.sent.length,10)
  await st.publish('acme/demo','revoked',{schema:1,visibility:'private'})
  assert.deepEqual(await channel.online(),['reader'],'short authorization cache is in use')
  await channel.alarm()
  assert.ok(ws.closed,'the timer closes a revoked socket without any incoming traffic')
  assert.ok(AUTHORIZATION_MS<=5000)
  f.db.close();st.db.close()
})
test('socket cache expires on demand and access-change push invalidates before fan-out',async()=>{
  const f=sqlDB(),st=d1(),ws=socket()
  await st.publish('acme/demo','meta',{schema:1,visibility:'private',read:['@reader']})
  f.sockets.push(ws)
  const channel=new RepoChannel(f.ctx,{DB:st.binding})
  await channel.online()
  await st.publish('acme/demo','revoked',{schema:1,visibility:'private'})
  await channel.system({id:'acl-write',event:'push',repository:'acme/demo',payload:{ref:'refs/heads/_meta'}})
  assert.ok(ws.closed)
  assert.equal(ws.sent.length,0,'access change never sends to the revoked socket')
  f.db.close();st.db.close()
})
test('agent socket validation reads its agent once and token expiry bypasses cached access',async()=>{
  const f=sqlDB(),st=d1(),hash=await hashToken('gf_test'),ws=socket('acme/bot',hash,true)
  await st.store.createAgent('acme','bot','key')
  await st.store.saveApiToken(hash,'acme/bot','key',Date.now()+86400000,{scopes:['repo:read'],repos:['acme/demo']})
  await st.publish('acme/demo','meta',{schema:1})
  f.sockets.push(ws)
  const channel=new RepoChannel(f.ctx,{DB:st.binding})
  st.queries.length=0
  assert.deepEqual(await channel.online(),['acme/bot'])
  assert.equal(st.queries.filter(q=>q.startsWith('SELECT')&&q.includes('FROM agents')).length,1)
  await st.store.deleteApiToken('acme/bot',hash)
  await st.store.saveApiToken(hash,'acme/bot','key',Date.now()+86400000,{scopes:['repo:read','channel:write'],repos:['acme/demo']})
  await channel.alarm()
  assert.ok(ws.deserializeAttachment().principal.scopes?.includes('channel:write'))
  ws.serializeAttachment({...ws.deserializeAttachment(),expires:Date.now()-1})
  assert.deepEqual(await channel.online(),[]);assert.ok(ws.closed)
  f.db.close();st.db.close()
})
test('forge emit survives unavailable channel; alarm retries durable notes with original event time',async()=>{
  const f=sqlDB(),st=d1(),channelFixture=sqlDB()
  const channel=new RepoChannel(channelFixture.ctx,{DB:st.binding})
  let fail=true,calls=0
  const hub=new ForgeEvents(f.ctx,{DB:st.binding,WEBHOOKS:{send:async()=>{}},REPO_CHANNEL:{idFromName:(s:string)=>s,get:()=>({system:async(e:any)=>{calls++;if(fail)throw Error('Channel unavailable');await channel.system(e)}})}})
  const event={id:'stored-event',event:'issues',repository:'acme/demo',payload:{issue:{number:1}}}
  let cursor: unknown
  await assert.doesNotReject(async()=>{cursor=await hub.emit(event)})
  assert.equal(cursor,'1');assert.equal(calls,0,'emit must only persist and schedule')
  const at=f.db.prepare('SELECT at FROM forge_events WHERE id=?').get(event.id)!.at
  await hub.alarm()
  assert.equal(f.db.prepare('SELECT count(*) n FROM channel_outbox').get()!.n,1)
  fail=false;await hub.alarm()
  assert.equal(f.db.prepare('SELECT count(*) n FROM channel_outbox').get()!.n,0)
  assert.equal(channel.page({limit:50}).messages[0].created_at,at)
  await assert.doesNotReject(()=>hub.emit({id:'malformed',event:'session',repository:'acme/demo',payload:{receipt:{id:'broken'}}}))
  assert.equal(f.db.prepare('SELECT count(*) n FROM forge_events').get()!.n,2,'malformed session must not roll back the forge event')
  f.db.close();st.db.close();channelFixture.db.close()
})
test('channel state survives reconnect and stale receipt delivery cannot replace newer activity',async()=>{
  const f=sqlDB(),st=d1(),channel=new RepoChannel(f.ctx,{DB:st.binding})
  const event=(id:string,status:string,at:string)=>({id,event:'session',repository:'acme/demo',payload:{action:'updated',receipt:{id:'s',target:'pull:2',agent:'acme/bot',state:{status,tool:'Edit',last_activity:at}}}})
  await channel.system(event('new','busy','2026-10-09T10:00:00.100Z'))
  await channel.system(event('old','idle','2026-10-09T10:00:00Z'))
  assert.equal(channel.states()['acme/bot']?.status,'busy')
  const reopened=new RepoChannel(f.ctx,{DB:st.binding})
  assert.equal(reopened.states()['acme/bot']?.tool,'Edit')
  await reopened.system(event('waiting','waiting','2026-10-09T10:01:00Z'))
  assert.equal(reopened.states()['acme/bot']?.status,'waiting')
  // Updates change the roster, never the conversation.
  assert.equal(reopened.page({limit:50}).messages.filter(m=>m.body==='updated session').length,0)
  f.db.close();st.db.close()
})

test('quiet session updates reach the channel through the forge outbox',async()=>{
  const f=sqlDB(),st=d1(),channelFixture=sqlDB()
  const channel=new RepoChannel(channelFixture.ctx,{DB:st.binding})
  const hub=new ForgeEvents(f.ctx,{DB:st.binding,WEBHOOKS:{send:async()=>{}},REPO_CHANNEL:{idFromName:(s:string)=>s,get:()=>channel}})
  await hub.emit({id:'quiet-state',event:'session',repository:'acme/demo',payload:{action:'updated',receipt:{id:'s',target:'pull:2',agent:'acme/bot',state:{status:'waiting',last_activity:'2026-10-09T10:01:00Z'}}}})
  await hub.alarm()
  assert.equal(channel.states()['acme/bot']?.status,'waiting')
  assert.equal(channel.page({limit:50}).messages.length,0,'a quiet update changes the roster without adding a conversation line')
  f.db.close();st.db.close();channelFixture.db.close()
})

test('authorization TTL expires at five seconds and coalesces concurrent checks',async()=>{
  const cache=new SocketAuthorization(),ws={},calls={n:0}
  const check=async()=>{calls.n++;return true}
  assert.deepEqual(await Promise.all([cache.valid(ws,check,0),cache.valid(ws,check,0)]),[true,true])
  assert.equal(calls.n,1)
  await cache.valid(ws,check,4999);assert.equal(calls.n,1)
  await cache.valid(ws,check,5000);assert.equal(calls.n,2)
})

test('reported receipt state enters the durable event outbox on start and every update',async()=>{
  const f=sqlDB(),outbox=new EventOutbox(f.sql)
  let previous:any=null
  const ctx={ctx:f.ctx,sessions:{get:()=>previous,put:(receipt:any)=>receipt},outbox}
  const receipt={id:'receipt',agent:'acme/bot',target:'pull:2',repository:'acme/demo',version:1,closed:false,state:{status:'busy',tool:'Edit',last_activity:'2026-10-09T12:00:00Z'}}
  await RepoIndex.prototype.sessionPut.call(ctx,receipt,0)
  const rows=()=>[...f.sql.exec('SELECT event FROM event_outbox')].map((r:any)=>JSON.parse(r.event))
  assert.equal(rows()[0].payload.action,'started')
  assert.deepEqual(rows()[0].payload.receipt.state,receipt.state)
  previous=receipt
  const updated={...receipt,version:2,state:{status:'waiting',last_activity:'2026-10-09T12:00:01Z'}}
  await RepoIndex.prototype.sessionPut.call(ctx,updated,1)
  assert.equal(rows()[1].payload.action,'updated')
  assert.deepEqual(rows()[1].payload.receipt.state,updated.state)
  f.db.close()
})

test('revocation timer validates before attempting a stalled mention delivery',async()=>{
  const f=sqlDB(),st=d1(),ws=socket()
  await st.publish('acme/demo','meta',{schema:1,visibility:'private',read:['@reader']})
  f.sockets.push(ws)
  let release!:()=>void
  const stalled=new Promise<void>(resolve=>{release=resolve})
  const channel=new RepoChannel(f.ctx,{DB:st.binding,EVENTS:{idFromName:(s:string)=>s,get:()=>({emit:async()=>{assert.ok(ws.closed,'silent revoked socket closes before mention delivery stalls');await stalled}})}})
  await channel.online()
  await st.publish('acme/demo','revoked',{schema:1,visibility:'private'})
  f.sql.exec('INSERT INTO channel_mentions VALUES (?,?)','pending',JSON.stringify({id:'pending'}))
  const alarm=channel.alarm()
  // Allow authorization and the stalled delivery to reach their await points.
  await new Promise(resolve=>setTimeout(resolve,0))
  release();await alarm
  assert.ok(ws.closed)
  f.db.close();st.db.close()
})

function mentionChannel() {
  const f=sqlDB(),st=d1(),emitted:any[]=[]
  const channel=new RepoChannel(f.ctx,{DB:st.binding,EVENTS:{idFromName:(s:string)=>s,get:()=>({emit:async(e:any)=>{emitted.push(e)}})}})
  return {f,st,emitted,channel,close:()=>{f.db.close();st.db.close()}}
}

test('an agent starts a conversation unprompted: its @tag emits exactly one mention and it may post again',async()=>{
  const m=mentionChannel()
  const first=await m.channel.post('acme/demo','acme/alice','@bob the build on main is red',['acme/bob'])
  assert.equal(first.reply_to,null)
  assert.deepEqual(m.emitted.map(e=>[e.event,e.audience,e.payload.history_cursor]),[['channel.mention','acme/bob',first.cursor]])
  const second=await m.channel.post('acme/demo','acme/alice','@bob any news?',['acme/bob'])
  assert.notEqual(second.cursor,first.cursor)
  assert.equal(m.emitted.length,2)
  await assert.rejects(m.channel.post('acme/demo','acme/alice','x',[], '999'),/reply_to/)
  assert.equal((await m.channel.post('acme/demo','acme/alice','threaded',[],first.cursor)).reply_to,first.cursor)
  m.close()
})

test('agent ping-pong stops delivering mentions after 20 agent messages in a row and a human resets it',async()=>{
  const m=mentionChannel()
  for(let i=1;i<=20;i++)await m.channel.post('acme/demo',i%2?'acme/alice':'acme/bob','@other '+i,[i%2?'acme/bob':'acme/alice'])
  assert.equal(m.emitted.length,20)
  const stopped=await m.channel.post('acme/demo','acme/bob','@alice 21',['acme/alice'])
  assert.equal(m.emitted.length,20,'the 21st consecutive agent mention is stored but not delivered')
  assert.equal(m.channel.page({limit:5}).messages.some(x=>x.cursor===stopped.cursor),true)
  const notes=()=>m.channel.page({limit:200}).messages.filter(x=>x.kind==='system'&&/paused/.test(x.body))
  assert.equal(notes().length,1,'a system note announces the pause once')
  await m.channel.post('acme/demo','acme/alice','@bob 22',['acme/bob'])
  assert.equal(m.emitted.length,20);assert.equal(notes().length,1)
  await m.channel.post('acme/demo','sami','@alice please continue',['acme/alice'])
  assert.equal(m.emitted.length,21,'a human message always delivers')
  await m.channel.post('acme/demo','acme/alice','@bob back',['acme/bob'])
  assert.equal(m.emitted.length,22,'the counter reset on the human message')
  m.close()
})

// Count actual primary reads and prove that cache invalidation affects the roster.
test('participant facts batch once, warm reads reuse them, ACL/agent/token/org/orchestrator writes invalidate',async()=>{
  const f=sqlDB(),st=d1(),channel=new RepoChannel(f.ctx,{DB:st.binding})
  const acl={schema:1,agents:{'@acme/bot':['pr']},read:['@reader']}
  await st.store.createAgent('acme','bot','key')
  await st.store.saveApiToken('hash','acme/bot','key',Date.now()+86400000,{scopes:['repo:read','channel:write'],repos:['acme/demo']})
  await st.publish('acme/demo','meta',acl)
  st.queries.length=0
  assert.equal((await channel.participants('acme/demo',acl)).find((p:any)=>p.name==='acme/bot').prefix,'+')
  assert.equal(st.queries.length,6,'one generation read and one five-statement D1 batch, independent of agent count')
  st.queries.length=0
  await channel.participants('acme/demo',acl)
  assert.equal(st.queries.length,1,'warm list reads only its primary generation fence')
  await st.store.setSuspended('acme/bot','acme')
  assert.ok(!(await channel.participants('acme/demo',acl)).some((p:any)=>p.name==='acme/bot'))
  await st.store.setSuspended('acme/bot',null)
  assert.ok((await channel.participants('acme/demo',acl)).some((p:any)=>p.name==='acme/bot'))
  await st.store.deleteApiToken('acme/bot','hash')
  assert.equal((await channel.participants('acme/demo',acl)).find((p:any)=>p.name==='acme/bot').prefix,'')
  await st.store.grantOrchestrator({agent:'acme/bot',scope:'repo:acme/demo',childLimit:10,grantedBy:'acme'})
  assert.equal((await channel.participants('acme/demo',acl)).find((p:any)=>p.name==='acme/bot').prefix,'%')
  const changed={...acl,agents:{}}
  assert.ok(!(await channel.participants('acme/demo',changed)).some((p:any)=>p.name==='acme/bot'))
  await st.store.createOrg('acme',null,'owner')
  await st.store.addOrgMember('acme','newmember','admin')
  assert.equal((await channel.participants('acme/demo',changed)).find((p:any)=>p.name==='newmember').prefix,'@')
  f.db.close();st.db.close()
})
test('authorized handshake primes five seconds only; access events clear it',async()=>{
  const cache=new SocketAuthorization<object>(),socket={}
  let checks=0
  cache.prime(socket,100)
  assert.ok(await cache.valid(socket,async()=>{checks++;return false},101))
  assert.equal(checks,0)
  cache.clear()
  assert.equal(await cache.valid(socket,async()=>{checks++;return false},102),false)
  assert.equal(checks,1)
})

test('participant token expiry changes the rank without rebuilding unchanged facts',async()=>{
  const f=sqlDB(),st=d1(),channel=new RepoChannel(f.ctx,{DB:st.binding})
  const acl={schema:1,agents:{'@acme/bot':[]}},now=Date.now
  await st.store.createAgent('acme','bot','key')
  await st.store.saveApiToken('hash','acme/bot','key',now()+1000,{scopes:['channel:write'],repos:['acme/demo']})
  assert.equal((await channel.participants('acme/demo',acl)).find((p:any)=>p.name==='acme/bot').prefix,'+')
  try {
    Date.now=()=>now()+6000
    st.queries.length=0
    assert.equal((await channel.participants('acme/demo',acl)).find((p:any)=>p.name==='acme/bot').prefix,'')
    assert.equal(st.queries.length,1,'unchanged immutable facts survive the old five-second rebuild timer')
  } finally {Date.now=now;f.db.close();st.db.close()}
})
test('a hibernated channel restores the roster source and sends current state without REST',async()=>{
  const f=sqlDB(),st=d1(),ws=socket()
  await st.publish('acme/demo','meta',{schema:1,read:['@reader'],agents:{'@acme/bot':[]}})
  await st.store.createAgent('acme','bot','key')
  f.sockets.push(ws)
  const resumed=new RepoChannel(f.ctx,{DB:st.binding})
  await resumed.system({id:'busy',event:'session',repository:'acme/demo',payload:{action:'updated',receipt:{id:'s',target:'pull:2',agent:'acme/bot',state:{status:'busy',tool:'Edit',last_activity:new Date().toISOString()}}}})
  const presence=ws.sent.map(s=>JSON.parse(s)).find(d=>d.type==='presence')
  assert.equal(presence.participants.find((p:any)=>p.name==='acme/bot').state.tool,'Edit')
  f.db.close();st.db.close()
})

test('batched viewer island preserves an agent profile and gates private data before viewer reads',async()=>{
  const st=d1(),token='gf_profile_fixture',hash=await hashToken(token)
  await st.store.createAgent('acme','bot','key')
  await st.store.saveApiToken(hash,'acme/bot','key',Date.now()+86400000,{scopes:['repo:read'],repos:['acme/demo']})
  await st.store.settings.saveProfile('acme/bot',{displayName:'Bot',publicEmail:'',description:'',url:'',socialLinks:[],location:'',picture:'/pf/fixture-picture'})
  await st.publish('acme/demo','meta',{schema:1,visibility:'private',agents:{'@acme/bot':['pr']}})
  const env={DB:st.binding,REPO_CHANNEL:{idFromName:(id:string)=>id,get:()=>({participants(){throw Error('An ordinary viewer island must not request channel data')}} as any)}}
  const request=new Request('https://gild.gg/api/repos/acme/demo/islands',{headers:{authorization:'Bearer '+token}})
  const result=await repoIslands(request,env,'acme','demo')
  assert.equal(result.data.name,'acme/bot')
  assert.deepEqual(result.data.picture,{url:'/pf/fixture-picture',source:'Uploaded'})
  assert.match(result.timing,/identity;dur=.*policy;dur=.*viewer_data;dur=/)
  assert.ok(!JSON.stringify(result.data).includes(hash),'token hashes remain internal')
  await st.store.deleteApiToken('acme/bot',hash)
  await st.store.saveApiToken(hash,'acme/bot','key',Date.now()+86400000,{scopes:['repo:write'],repos:['acme/demo']})
  st.queries.length=0
  await assert.rejects(()=>repoIslands(request,env,'acme','demo'),(e:any)=>e.status===404)
  assert.ok(!st.queries.some(q=>q.includes('FROM profiles')),'a non-reader cannot reach the personalized data batch')
  const secret=crypto.randomUUID(),payload=Buffer.from(JSON.stringify({name:'acme/bot',publicKey:'key',at:new Date().toISOString()})).toString('base64url')
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign'])
  const mac=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(payload))).toString('base64url')
  const cookieRequest=new Request(request.url,{headers:{cookie:`gild_session=${payload}.${mac}`}})
  assert.equal((await repoIslands(cookieRequest,{...env,SESSION_SECRET:secret},'acme','demo')).data.name,'acme/bot')
  await st.store.setSuspended('acme/bot','acme')
  await assert.rejects(()=>repoIslands(cookieRequest,{...env,SESSION_SECRET:secret},'acme','demo'),(e:any)=>e.status===404)
  st.db.close()
})

test('a cold channel resolves missing policy once; warm viewer reads bypass the index',async()=>{
  const f=sqlDB(),st=d1(),channel=new RepoChannel(f.ctx,{DB:st.binding})
  let reads=0
  const env={DB:st.binding,REPO_CHANNEL:{idFromName:(n:string)=>n,get:()=>channel},REPO_INDEX:{idFromName:(n:string)=>n,get:()=>({fragmentAccess:async()=>{reads++;return {acl:{schema:1}}}})}}
  const request=new Request('https://gild.gg/api/repos/acme/demo/islands?channel=1')
  try {
    assert.ok((await repoIslands(request,env,'acme','demo')).data.channel.participants.some((p:any)=>p.name==='acme'))
    assert.equal(reads,1,'the cold fallback returns real channel data')
    await st.publish('acme/demo','meta',{schema:1})
    await repoIslands(request,env,'acme','demo')
    assert.equal(reads,1,'warm policy needs no index RPC')
    st.db.exec('DELETE FROM repo_access')
    env.REPO_INDEX.get=()=>({fragmentAccess:async()=>{throw Object.assign(Error('Repository is indexing'),{status:503})}})
    await assert.rejects(repoIslands(request,env,'acme','demo'),/Repository is indexing/)
  } finally {f.db.close();st.db.close()}
})


test('actual receipt outbox carries runtime binding and older stopped session cannot overwrite the current roster',async()=>{
  const f=sqlDB(),st=d1(),channel=new RepoChannel(f.ctx,{DB:st.binding})
  const acl={schema:1,visibility:'private',read:['@reader'],agents:{'@acme/bot':[]}}
  await st.store.createAgent('acme','bot','key')
  await st.publish('acme/demo','meta',acl)
  const allowed=socket(),foreign=socket('outsider','browser:outsider')
  f.sockets.push(allowed,foreign)
  await channel.participants('acme/demo',acl)
  const outbox=new EventOutbox(f.sql)
  let previous:any=null
  const ctx={ctx:f.ctx,sessions:{get:()=>previous,put:(receipt:any)=>receipt},outbox}
  const worker={id:'5e88ffcb-2a57-4d03-802f-99d4f8d4d380',name:'Demo worker'}
  const first={id:'412409d8-49cb-4a2c-a4c1-a59740f7f18c',agent:'acme/bot',target:'pull:2',repository:'acme/demo',version:1,closed:false,started_at:'2026-10-12T18:00:00Z',ended_at:null,updated_at:'2026-10-12T18:00:01Z',runtime:{mode:'VM',worker,host:{os:'linux'},guest:{os:'Ubuntu',version:'24.04.5 LTS'},observed_at:'2026-10-12T18:00:00Z'},state:{status:'busy',last_activity:'2026-10-12T18:00:01Z'}}
  await RepoIndex.prototype.sessionPut.call(ctx,first,0)
  const emitted=()=>[...f.sql.exec('SELECT event FROM event_outbox')].map((r:any)=>JSON.parse(r.event))
  assert.deepEqual(emitted()[0].payload.receipt.runtime,first.runtime)
  assert.equal(emitted()[0].payload.receipt.started_at,first.started_at)
  await channel.system(emitted()[0])
  const next={...first,id:'831a238a-4c0d-4be6-972f-3a68880d478d',started_at:'2026-10-12T18:01:00Z',updated_at:'2026-10-12T18:01:01Z',runtime:{mode:'HOST',worker,host:{os:'macos',version:'15.7'},observed_at:'2026-10-12T18:01:00Z'},state:{status:'idle',last_activity:'2026-10-12T18:01:01Z'}}
  await RepoIndex.prototype.sessionPut.call(ctx,next,0)
  await channel.system(emitted()[1])
  const late={...first,version:2,closed:true,ended_at:'2026-10-12T18:02:00Z',updated_at:'2026-10-12T18:02:00Z',state:{status:'ended',last_activity:'2026-10-12T18:02:00Z'}}
  previous=first
  await RepoIndex.prototype.sessionPut.call(ctx,late,1)
  await channel.system(emitted()[2])
  const reopened=new RepoChannel(f.ctx,{DB:st.binding})
  assert.equal(reopened.currentSessions()['acme/bot'].session.id,next.id)
  assert.equal(reopened.currentSessions()['acme/bot'].session.runtime.mode,'HOST')
  assert.equal(reopened.states()['acme/bot'].status,'idle')
  const snapshot=await reopened.snapshot('acme/demo',acl)
  const profile=snapshot.participants.find((p:any)=>p.name==='acme/bot')
  assert.ok(profile?.session?.runtime,'current session runtime projection must reach the scoped roster')
  assert.equal(profile.session.runtime.mode,'HOST')
  assert.equal(profile.session.runtime.worker.id,worker.id)
  const wire=allowed.sent.map(s=>JSON.parse(s)).filter(p=>p.type==='presence').at(-1)
  assert.equal(wire.participants.find((p:any)=>p.name==='acme/bot').session.runtime.mode,'HOST')
  assert.equal(foreign.closed,true)
  assert.equal(foreign.sent.length,0,'private runtime metadata must not reach an unapproved reader')
  f.db.close();st.db.close()
})


test('runtime-only receipt updates deliver observed guest and freshness to the current roster',async()=>{
  const f=sqlDB(),st=d1(),channel=new RepoChannel(f.ctx,{DB:st.binding})
  const acl={schema:1,visibility:'private',read:['@reader'],agents:{'@acme/bot':[]}}
  await st.store.createAgent('acme','bot','key')
  await st.publish('acme/demo','meta',acl)
  const allowed=socket(),foreign=socket('outsider','browser:outsider')
  f.sockets.push(allowed,foreign)
  await channel.participants('acme/demo',acl)
  const sessions=new SessionStore(f.sql),outbox=new EventOutbox(f.sql)
  const ctx={ctx:f.ctx,sessions,outbox}
  const emitted=()=>[...f.sql.exec('SELECT event FROM event_outbox ORDER BY rowid')].map((r:any)=>JSON.parse(r.event))
  const first=receiptSchema.parse({id:'af49e787-fd59-4d14-8c78-84d8268a7b40',agent:'acme/bot',target:'pull:3',repository:'acme/demo',model:'codex',version:1,closed:false,started_at:'2026-10-12T18:00:00Z',ended_at:null,created_at:'2026-10-12T18:00:00Z',updated_at:'2026-10-12T18:00:01Z',runtime:{mode:'VM',worker:{id:'5e88ffcb-2a57-4d03-802f-99d4f8d4d380',name:'Demo worker'},host:{os:'linux'},guest:null,observed_at:'2026-10-12T18:00:00Z'}})
  try {
    await RepoIndex.prototype.sessionPut.call(ctx,first,0)
    assert.equal(sessions.get(first.id)?.state,undefined,'this supported receipt really has no state')
    await channel.system(emitted()[0])
    const snapshot=()=>channel.snapshot('acme/demo',acl).then((s:any)=>s.participants.find((p:any)=>p.name==='acme/bot').session)
    assert.equal((await snapshot()).runtime.guest,null)
    const observed={...first,version:2,updated_at:'2026-10-12T18:01:01Z',runtime:{...first.runtime!,guest:{os:'Ubuntu',version:'24.04.5 LTS'},observed_at:'2026-10-12T18:01:00Z'}}
    await RepoIndex.prototype.sessionPut.call(ctx,observed,1)
    assert.deepEqual((sessions.get(first.id)?.runtime as any).guest,observed.runtime.guest,'actual receipt JSON stores the observed guest')
    assert.equal(emitted().length,2,'runtime-only update must emit a new session outbox event')
    assert.equal(emitted()[1].payload.action,'updated')
    assert.equal('state' in emitted()[1].payload.receipt,false)
    await channel.system(emitted()[1])
    assert.deepEqual((await snapshot()).runtime.guest,observed.runtime.guest)
    assert.equal((await snapshot()).updated_at,observed.updated_at)
    const refreshed={...observed,version:3,updated_at:'2026-10-12T18:02:01Z',runtime:{...observed.runtime,observed_at:'2026-10-12T18:02:00Z'}}
    await RepoIndex.prototype.sessionPut.call(ctx,refreshed,2)
    assert.equal(emitted().length,3,'runtime-only observation refresh must emit a session event')
    await channel.system(emitted()[2])
    assert.equal((await snapshot()).runtime.observed_at,refreshed.runtime.observed_at)
    assert.equal((await snapshot()).version,3)
    const wire=allowed.sent.map(s=>JSON.parse(s)).filter(p=>p.type==='presence').at(-1)
    assert.equal(wire.participants.find((p:any)=>p.name==='acme/bot').session.version,3)
    assert.equal(foreign.closed,true)
    assert.equal(foreign.sent.length,0)
    const legacy=receiptSchema.parse({...first,id:'327f3c4f-3697-4d27-b578-3b7d753dd20e',runtime:undefined})
    await RepoIndex.prototype.sessionPut.call(ctx,legacy,0)
    const count=emitted().length
    await RepoIndex.prototype.sessionPut.call(ctx,{...legacy,version:2,notes:'legacy receipt update'},1)
    assert.equal(emitted().length,count,'legacy receipt without state/runtime keeps its existing event semantics')
  } finally {f.db.close();st.db.close()}
})
