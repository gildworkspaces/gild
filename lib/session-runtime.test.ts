import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import { sessionInput, receiptSchema } from './api/sessions-contract.ts'
import { SessionStore } from './sessions/store.ts'
import { saveCurrentSession, decodeCurrentSession } from './channel/session.ts'
import { sessionHandler } from './api/sessions.ts'
import { routes } from './api/contract.ts'
const started='2026-10-12T18:00:00Z',later='2026-10-12T18:01:00Z'
const worker={id:'5e88ffcb-2a57-4d03-802f-99d4f8d4d380',name:'Demo worker'}
const runtime={mode:'VM' as const,worker,host:{os:'linux' as const,version:'6.12.112'},guest:{os:'Ubuntu',version:'24.04.5 LTS'},observed_at:started}
function draft() {return receiptSchema.parse({id:randomUUID(),agent:'acme/bot',repository:'acme/demo',target:'commit:'+'a'.repeat(40),started_at:started,model:'codex',runtime,state:{status:'busy',last_activity:started},created_at:started,updated_at:started,version:1,closed:false})}
function fixture() {
 const db=new DatabaseSync(':memory:')
 const sql={exec(q:string,...args:any[]){if(!args.length&&q.includes(';')){db.exec(q);return []}return db.prepare(q).all(...args) as any}}
 sql.exec('CREATE TABLE channel_states(agent TEXT PRIMARY KEY,json TEXT NOT NULL,activity INTEGER NOT NULL)')
 const store=new SessionStore(sql)
 const current=()=>{const r=db.prepare('SELECT json FROM channel_states WHERE agent=?').get('acme/bot');return r?decodeCurrentSession(r.json as string):null}
 return {db,sql,store,current}
}
test('observed HOST/VM telemetry survives receipt storage and old clients can omit it',async()=>{
 const f=fixture(),r=draft();f.store.put(r,0)
 assert.deepEqual(new SessionStore(f.sql).get(r.id)?.runtime,runtime)
 const old=draft();delete old.runtime;f.store.put(old,0);assert.equal(f.store.get(old.id)?.runtime,undefined)
 const index={sessionGet:async(id:string)=>f.store.get(id),sessionPut:async(r:any,v:number)=>f.store.put(r,v),resolveRef:async()=>{},commit:async()=>({})} as any
 // Pull handler exercises production ownership and omission-preserving updates.
 index.metaItem=async()=>({item:{}})
 const p=receiptSchema.parse({...draft(),target:'pull:1'});f.store.put(p,0)
 const body={...p,version:undefined,runtime:undefined,state:{status:'idle',last_activity:later}}
 const context={params:{owner:'acme',repo:'demo',number:'1'},route:routes.find(r=>r.id==='createPullSession'),body,principal:{name:'acme/bot'}} as any
 const response=await sessionHandler(context,index)
 assert.deepEqual((response.data as any).runtime,runtime)
 await assert.rejects(()=>sessionHandler({...context,principal:{name:'acme/foreign'}},index),/match|original agent/)
 const input={started_at:started,model:'codex',runtime:{mode:'HOST',worker,host:{os:'macos'},observed_at:started}}
 assert.equal(sessionInput.parse(input).runtime?.mode,'HOST')
 f.db.close()
})
test('telemetry rejects unsupported modes, invented HOST guest, missing VM guest and private payloads',()=>{
 const input={started_at:started,model:'codex'}
 for(const bad of [{...runtime,mode:'CONTAINER'},{...runtime,mode:'HOST'},{...runtime,guest:undefined},{...runtime,ip:'100.64.1.2'},{...runtime,cwd:'/private/checkout'},{...runtime,worker:{...worker,id:'demon.local'}},{...runtime,worker:{...worker,name:'100.64.1.2'}},{...runtime,worker:{...worker,name:'gf_fixtureCredential1234567890'}},{...runtime,guest:{os:'Ubuntu',version:'/home/secret'}},{...runtime,host:{os:'linux',token:'fixture-secret'}}]){
  assert.equal(sessionInput.safeParse({...input,runtime:bad}).success,false,JSON.stringify(bad))
 }
})
test('same session cannot rewrite its launch identity or move observation/activity backwards',()=>{
 const f=fixture(),r=draft();f.store.put(r,0)
 for(const changed of [{...r,started_at:later},{...r,runtime:{mode:'HOST',worker,host:{os:'macos'},observed_at:started}},{...r,runtime:{...runtime,worker:{...worker,name:'Another machine'}}},{...r,runtime:{...runtime,observed_at:'2026-10-12T17:59:00Z'}},{...r,state:{status:'busy',last_activity:'2026-10-12T17:59:00Z'}}]){
  assert.throws(()=>f.store.put({...changed,version:2} as any,1),/immutable|backwards/)
 }
 assert.deepEqual(f.store.get(r.id),r)
 f.db.close()
})
test('new HOST session wins over VM history even if old session ends much later; replays cannot revive stopped session',()=>{
 const f=fixture(),old=draft();assert.equal(saveCurrentSession(f.sql,old),true)
 const next=receiptSchema.parse({...draft(),started_at:later,updated_at:later,runtime:{mode:'HOST',worker,host:{os:'macos',version:'15.7'},observed_at:later},state:{status:'idle',last_activity:later}})
 assert.equal(saveCurrentSession(f.sql,next),true)
 const delayed={...old,version:8,ended_at:'2026-10-12T20:00:00Z',updated_at:'2026-10-12T20:00:00Z',closed:true,state:{status:'ended',last_activity:'2026-10-12T20:00:00Z'}}
 assert.equal(saveCurrentSession(f.sql,delayed),false)
 assert.equal(f.current()?.session?.id,next.id)
 assert.equal(f.current()?.session?.runtime?.mode,'HOST')
 assert.equal(saveCurrentSession(f.sql,{agent:old.agent,state:delayed.state}),false)
 const ended={...next,version:2,ended_at:'2026-10-12T18:02:00Z',closed:true,state:{status:'ended',last_activity:'2026-10-12T18:02:00Z'}}
 assert.equal(saveCurrentSession(f.sql,ended),true)
 assert.equal(saveCurrentSession(f.sql,{...next,version:3}),false)
 assert.equal(f.current()?.session?.closed,true)
 assert.equal(decodeCurrentSession(JSON.stringify(f.current()))?.session?.id,next.id)
 f.db.close()
})

test('unknown VM guest upgrades once and equivalent fractional timestamps do not relabel the session',()=>{
 const f=fixture(),r=receiptSchema.parse({...draft(),runtime:{...runtime,guest:null}})
 f.store.put(r,0)
 const saved=f.store.put({...r,version:2,started_at:'2026-10-12T18:00:00.000Z',runtime:{...runtime,observed_at:'2026-10-12T18:00:00.000Z'}},1)
 assert.deepEqual(saved.runtime?.mode==='VM' ? saved.runtime.guest : null,runtime.guest)
 assert.equal(saved.started_at,r.started_at)
 for(const guest of [null,{os:'Fedora',version:'43'}])assert.throws(()=>f.store.put({...saved,version:3,runtime:{...runtime,guest}},2),/guest identity/)
 assert.equal(saveCurrentSession(f.sql,r),true)
 assert.equal(saveCurrentSession(f.sql,{...saved,started_at:'2026-10-12T18:00:00.000Z'}),true)
 assert.equal(f.current()?.session?.version,2)
 assert.equal(f.current()?.session?.runtime?.mode==='VM' && f.current()?.session?.runtime.guest?.os,'Ubuntu')
 f.db.close()
})

test('generated CLI session artifact accepts and returns exact observation bytes',async()=>{
 mkdirSync('.tmp',{recursive:true})
 const target=mkdtempSync(resolve('.tmp/session-runtime-contract-'))
 execFileSync(process.execPath,['scripts/generate-api-client.mjs',target+'/src/api'])
 const {sessionInput:generatedInput,receiptSchema:generatedReceipt}=await import(pathToFileURL(target+'/src/api/sessions-contract.ts').href)
 rmSync(target,{recursive:true,force:true})
 const r=draft()
 assert.deepEqual(generatedInput.parse(r).runtime,r.runtime)
 assert.deepEqual(generatedReceipt.parse(r),receiptSchema.parse(r))
 const unknown=generatedInput.parse({...r,runtime:{...runtime,guest:null}})
 assert.equal(unknown.runtime.mode,'VM')
 assert.equal(unknown.runtime.guest,null)
})
