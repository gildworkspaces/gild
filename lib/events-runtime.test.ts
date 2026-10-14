import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {mkdirSync} from 'node:fs'
import {build} from 'esbuild'
import {deliverHTTP} from './events/transport.ts'
import {consumeWebhooks} from './events/consumer.ts'
import {eventRepositories} from './events/repositories.ts'
import {mayRead} from './repo-read.ts'
import {createHmac} from 'node:crypto'
mkdirSync('.tmp', {recursive:true})
await build({entryPoints:['lib/events/hub-do.ts'],outfile:'.tmp/events-hub-test.mjs',bundle:true,platform:'node',format:'esm',plugins:[{name:'workerd-host',setup(b){
  b.onResolve({filter:/^cloudflare:(workers|sockets)$/}, a=>({path:a.path,namespace:'host'}))
  b.onLoad({filter:/.*/,namespace:'host'}, a=>({contents:a.path.endsWith('workers') ? 'export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}' : 'export function connect(){throw Error("unexpected native socket")}',loader:'js'}))
}}]})
const {ForgeEvents} = await import('../.tmp/events-hub-test.mjs')
function fixture() {
  const db = new DatabaseSync(':memory:')
  const sql = {exec(q:string,...args:any[]) {
    if (!args.length && q.includes(';')) { db.exec(q); return [] }
    const st = db.prepare(q); if(st.columns().length) return st.all(...args)
    st.run(...args); return []
  }}
  const sent:any[] = [], alarms:number[] = []
  const env:any = {WEBHOOKS:{send:async (...args:any[])=>{sent.push(args)}},REPO_INDEX:{idFromName:(n:string)=>n,get:()=>({status:async()=>({ready:true}),metaFile:async()=>'{"visibility":"private"}'})},DB:{prepare:()=>({bind:()=>({first:async()=>null})})}}
  const ctx = {storage:{sql,transactionSync:(fn:()=>void)=>{db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}},setAlarm:async(n:number)=>{alarms.push(n)}}}
  const hub = new ForgeEvents(ctx,env)
  return {db,sql,env,sent,alarms,hub}
}
function input() {return {config:{url:'https://receiver.example',secret:'fixture-secret'},events:['issues']}}
async function queued(f:any) {
  const hook = await f.hub.create('repo:acme/demo',input(),'https://gild.test','acme')
  const row = (await f.hub.deliveries('repo:acme/demo',hook.id))[0]
  return {hook,id:row.guid}
}
test('shared read policy restricts streams including unrestricted tokens and default sets',async()=>{
  const s:any={store:{orgRole:async()=>null},index:async(_o:string,r:string)=>({metaFile:async()=>JSON.stringify({visibility:r==='private'?'private':'public'})})}
  const c:any={query:{},principal:{name:'outsider',repos:null,scopes:null}}
  const read=(o:string,r:string,v:string)=>mayRead(s,o,r,v)
  assert.deepEqual(await eventRepositories(c,async()=>['acme/public','acme/private'],read),['acme/public'])
  c.query.repos='acme/private'
  await assert.rejects(eventRepositories(c,async()=>[],read),/not readable/)
  c.principal.name='acme'
  assert.deepEqual(await eventRepositories(c,async()=>[],read),['acme/private'])
  c.principal.repos=['acme/public']
  await assert.rejects(eventRepositories(c,async()=>[],read),/not readable/)
})
test('creator access revocation disables even manual deliveries; org private events require read access',async()=>{
  const f=fixture(), {hook,id}=await queued(f)
  let sends=0; f.hub.send=async()=>{sends++;return {status:200,headers:{},body:'',truncated:false}}
  f.sql.exec("UPDATE forge_hooks SET creator='former-admin' WHERE id=?",hook.id)
  await f.hub.attempt(id)
  assert.equal(sends,0)
  assert.equal(f.hub.get('repo:acme/demo',hook.id,'https://gild.test').active,false)
  assert.match(f.hub.get('repo:acme/demo',hook.id,'https://gild.test').disabled_reason,/no longer/)
  const redelivery=await f.hub.redeliver('repo:acme/demo',hook.id,(await f.hub.deliveries('repo:acme/demo',hook.id))[0].id)
  await f.hub.attempt(redelivery.guid)
  assert.equal(sends,0)
  const orgHook=await f.hub.create('org:team',input(),'https://gild.test','org-admin')
  f.env.DB={prepare:()=>({bind:()=>({first:async()=>({role:'admin'})})})}
  // org admin access alone cannot read another owner's private repository.
  f.env.REPO_INDEX.get=()=>({status:async()=>({ready:true}),metaFile:async()=>'{"visibility":"private"}'})
  // Role lookup for private owner must now fail.
  f.env.DB={prepare:(q:string)=>({bind:(owner:string)=>({first:async()=>q.includes('org_members') && owner==='team'?{role:'admin'}:null})})}
  await f.hub.emit({id:'private',event:'issues',repository:'team/private',payload:{}})
  // Test a private event retained for org hook whose read policy rejects it.
  f.env.REPO_INDEX.get=()=>({status:async()=>({ready:false}),metaFile:async()=>null})
  const d=(await f.hub.deliveries('org:team',orgHook.id)).find((r:any)=>r.event==='issues')
  await f.hub.attempt(d.guid)
  assert.equal(sends,0)
  assert.equal(f.hub.get('org:team',orgHook.id,'https://gild.test').active,false)
})
test('delivery signs timestamp and exact body; redirects fail and attempts back off',async()=>{
  const f=fixture(), {hook,id}=await queued(f)
  const calls:any[]=[]
  f.hub.send=async(url:string,headers:any,body:string)=>{calls.push({headers,body});return {status:302,headers:{location:'http://127.0.0.1'},body:'redirect',truncated:false}}
  for(let attempt=1;attempt<=8;attempt++){
    const result=await f.hub.attempt(id)
    assert.equal(result.retry,attempt<8)
    assert.equal(result.delaySeconds,5*2**(attempt-1))
  }
  assert.equal(calls.length,8)
  assert.equal((await f.hub.deliveries('repo:acme/demo',hook.id))[0].status,'failed')
  const {headers,body}=calls[0]
  assert.match(headers['x-gild-timestamp'],/^\d+$/)
  assert.equal(headers['x-gild-signature-256'],'sha256='+createHmac('sha256','fixture-secret').update(headers['x-gild-timestamp']+'.'+body).digest('hex'))
})
test('alarm sweeps stuck queued and sending rows; dead letters become visible failed deliveries',async()=>{
  const f=fixture(), {hook,id}=await queued(f)
  f.sql.exec("UPDATE hook_deliveries SET queued=1,queued_at=1,state='sending',lease=1 WHERE id=?",id)
  await f.hub.alarm()
  assert.equal(f.sent.length,1)
  assert.equal(f.sent[0][0].delivery,id)
  assert.ok(f.alarms.length>=2)
  f.hub.deadLetter(id)
  const delivery=(await f.hub.deliveries('repo:acme/demo',hook.id))[0]
  assert.equal(delivery.status,'failed'); assert.match(delivery.error,/exhausted/)
  await f.hub.alarm(); assert.equal(f.sent.length,1)
})
test('queue consumer delays lease collisions without retry; backoff, DLQ and RPC failure settle correctly',async()=>{
  const calls:any[]=[]
  let result:any={retry:false,defer:true,delaySeconds:15}
  const hub:any={attempt:async()=>result,deadLetter:async(id:string)=>{calls.push(['dead',id])}}
  const env:any={EVENTS:{idFromName:()=>'',get:()=>hub},WEBHOOKS:{send:async(...args:any[])=>{calls.push(['send',...args])}}}
  const msg:any={body:{delivery:'d'},ack:()=>calls.push(['ack']),retry:(o:any)=>calls.push(['retry',o])}
  await consumeWebhooks({queue:'gild-webhooks',messages:[msg]} as any,env)
  assert.deepEqual(calls,[['send',{delivery:'d'},{delaySeconds:15}],['ack']])
  calls.length=0;result={retry:true,delaySeconds:10}
  await consumeWebhooks({queue:'gild-webhooks',messages:[msg]} as any,env)
  assert.deepEqual(calls,[['retry',{delaySeconds:10}]])
  calls.length=0
  await consumeWebhooks({queue:'gild-webhooks-dead',messages:[msg]} as any,env)
  assert.deepEqual(calls,[['dead','d'],['ack']])
  calls.length=0;hub.attempt=async()=>{throw Error('RPC down')}
  await consumeWebhooks({queue:'gild-webhooks',messages:[msg]} as any,env)
  assert.deepEqual(calls,[['retry',{delaySeconds:30}]])
})
test('deliverHTTP blocks SSRF before connection, pins public address and does not follow redirect',async()=>{
  let connections=0, pinned=''
  const io:any={resolve:async()=>['8.8.8.8'],connect:(a:any)=>{connections++;pinned=a.hostname;return {opened:Promise.resolve(),closed:Promise.resolve(),close:async()=>{},writable:new WritableStream({write(){}}),readable:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1\r\n\r\nredirect'));c.close()}})}}}
  await assert.rejects(deliverHTTP('http://127.0.0.1',{},'body',io),/public/)
  assert.equal(connections,0)
  await assert.rejects(deliverHTTP('https://receiver.example',{},'body',{...io,resolve:async()=>['8.8.8.8','10.0.0.1']}),/public/)
  assert.equal(connections,0)
  const r=await deliverHTTP('http://receiver.example',{},'body',io)
  assert.equal(r.status,302);assert.equal(connections,1);assert.equal(pinned,'8.8.8.8')
})
test('deliverHTTP total timeout covers hung DNS and socket opening', {timeout: 500}, async()=>{
  const io:any={timeoutMs:20,resolve:async()=>new Promise(()=>{}),connect:()=>{throw Error('must not connect')}}
  await assert.rejects(deliverHTTP('http://receiver.example',{},'body',io),/timed out/)
  let closed=0
  await assert.rejects(deliverHTTP('http://receiver.example',{},'body',{timeoutMs:20,resolve:async()=>['8.8.8.8'],connect:()=>({opened:new Promise(()=>{}),closed:Promise.resolve(),close:async()=>{closed++}})} as any),/timed out/)
  assert.ok(closed>=1)
})
