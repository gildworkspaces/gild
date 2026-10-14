import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { memoryStore } from './drivers/memory.ts'
import { MergeQueueStore } from './merge-queue-store.ts'
import type { SQL } from './repo-index-store.ts'
mkdirSync('.tmp',{recursive:true})
const outfile=resolve('.tmp/merge-drain-test.mjs')
await build({stdin:{contents:"export {processQueue} from './lib/pulls.ts';export {RunQueue} from './lib/actions/queue-do.ts'",resolveDir:resolve('.')},outfile,bundle:true,platform:'node',format:'esm',packages:'external',plugins:[{name:'no-request-context',setup(b){
  b.onResolve({filter:/^@opennextjs\/cloudflare$/},()=>({path:'request',namespace:'fixture'}))
  b.onResolve({filter:/^next\/headers$/},()=>({path:'headers',namespace:'fixture'}))
  b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'host',namespace:'fixture'}))
  b.onResolve({filter:/\/merge-queue-runtime$/},()=>({path:'runtime',namespace:'fixture'}))
  b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='host'?'export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}':a.path==='runtime'?'export const backgroundMergeRuntime=async()=>globalThis.__mergeRuntime':a.path==='headers'?'export const cookies=()=>{throw Error("Alarm must not read Next request headers")};export const headers=cookies':'export const getCloudflareContext=()=>{throw Error("Alarm must not use Next request context")}',loader:'js'}))
}}]})
const {processQueue,RunQueue}=await import(pathToFileURL(outfile).href)
function ledger(db:DatabaseSync) {
 const sql:SQL={exec(q:string,...args:any[]){if(!args.length&&q.includes(';')){db.exec(q);return []}const st=db.prepare(q);if(st.columns().length)return st.all(...args) as any;st.run(...args);return []}}
 return new MergeQueueStore(sql)
}
test('durable preparation survives storage reopen and missing receipt is not retired',async()=>{
 const work=mkdtempSync(resolve('.tmp/merge-ledger-')),path=join(work,'state.sqlite')
 let db=new DatabaseSync(path),store=ledger(db)
 const id=store.prepare(2);store.scan(true);db.close()
 db=new DatabaseSync(path);store=ledger(db)
 assert.deepEqual(store.pending(),[{id,number:2}]);assert.equal(store.needed(),true)
 store.scan(false);assert.equal(store.needed(),true,'uncertain preparation cannot expire when no queue was observed')
 store.retire([id]);assert.equal(store.needed(),false);db.close();rmSync(work,{recursive:true,force:true})
})
async function fixture(t:any) {
 const work=mkdtempSync(resolve('.tmp/merge-git-')),source=join(work,'source'),bare=join(work,'repo.git')
 mkdirSync(source)
 const run=(...args:string[])=>execFileSync('git',args,{cwd:source,encoding:'utf8',stdio:'pipe'}).trim()
 const write=(path:string,value:unknown)=>{const full=join(source,path);mkdirSync(join(full,'..'),{recursive:true});writeFileSync(full,typeof value==='string'?value:JSON.stringify(value))}
 const commit=(message:string)=>{run('add','.');run('-c','commit.gpgsign=false','commit','-m',message)}
 run('init','-b','main');write('base.txt','base\n');commit('base');const base=run('rev-parse','HEAD')
 run('switch','-c','feature');write('feature.txt','feature\n');commit('feature');const head=run('rev-parse','HEAD')
 run('init','--bare','--initial-branch=main',bare);run('push',bare,'main','feature')
 run('switch','--orphan','_meta');run('rm','-rf','--ignore-unmatch','.')
 const pull={schema:1,number:2,title:'Fixes #1',body:'Merge fixture',author:'writer',createdAt:'2026-10-11T20:00:00.000Z',head:'feature',base:'main',state:'open',queueIntent:{id:'intent-one',headOid:head,head:'feature',base:'main'}}
 write('.gild/next','3');write('.gild/acl.json',{visibility:'public'});write('.gild/queue.json',[2]);write('.gild/2/pr/pr.json',pull)
 write('.gild/2/pr/r-1-review.json',{id:'review',author:'reviewer',verdict:'approve',body:'approved',createdAt:pull.createdAt,headOid:head})
 write('.gild/1/issue/issue.json',{schema:1,number:1,title:'issue',body:'',author:'writer',createdAt:pull.createdAt,state:'open',labels:[],claim:null})
 write('.gild/merge-requests/intent-one.json',{id:'intent-one',number:2,headOid:head})
 write('.gild/index.json',{schema:1,issues:[],pulls:[pull],queue:[2]});commit('queued receipt');run('push',bare,'_meta')
 const server=createServer((request,response)=>{
  const advertise=request.url?.includes('/info/refs'),service=request.url?.includes('receive-pack')?'receive-pack':'upload-pack'
  response.setHeader('content-type',`application/x-git-${service}-${advertise?'advertisement':'result'}`)
  if(advertise){const line='# service=git-'+service+'\n';response.write((Buffer.byteLength(line)+4).toString(16).padStart(4,'0')+line+'0000')}
  const child=spawn('git',['-c','uploadpack.allowAnySHA1InWant=true',service,'--stateless-rpc',...(advertise?['--advertise-refs']:[]),bare],{stdio:['pipe','pipe','pipe']})
  child.stderr.resume();request.pipe(child.stdin);child.stdout.pipe(response)
 })
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address==='object')
 const url=`http://127.0.0.1:${address.port}/repo.git`,store=memoryStore(),db=new DatabaseSync(join(work,'state.sqlite'))
 const intents=ledger(db);intents.prepare(2,'intent-one')
 let allowed=false,fail=false;const checked:string[]=[],pushes:any[]=[]
 const runtime={store,index:null,channels:{},plan:async(plan:any)=>intents.plan(plan),planned:async(id:string)=>intents.planned(id),connection:async()=>({token:'disposable-fixture',url}),gate:(sha:string)=>{checked.push(sha);return{ok:allowed}},pushed:async(update:any)=>{if(fail){fail=false;throw Error('Lost post-push notification')}pushes.push(update)}}
 const ref=(name:string)=>run('--git-dir='+bare,'rev-parse',name)
 const meta=(path:string)=>JSON.parse(run('--git-dir='+bare,'show','_meta:'+path))
 const drain=()=>processQueue('acme','demo',runtime,intents.pending())
 const edit=(path:string,value:unknown)=>{write(path,value);commit('metadata change');run('push',bare,'_meta')}
 t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));db.close();rmSync(work,{recursive:true,force:true})})
 return{base,head,intents,db,runtime,checked,pushes,ref,meta,drain,edit,pull,run,write,commit,deleteHead:()=>run('--git-dir='+bare,'update-ref','-d','refs/heads/feature'),allow:()=>{allowed=true},fail:()=>{fail=true},advance:()=>{run('switch','feature');write('new.txt','new head\n');commit('advance');run('push',bare,'feature');run('switch','_meta')}}
}
test('pending CI persists, then reconstructed intent drains actual Git once and closes its issue',async t=>{
 const f=await fixture(t),before=f.ref('main')
 const pending=await f.drain();assert.equal(pending.queued,true);assert.deepEqual(pending.completed,[]);assert.equal(f.ref('main'),before)
 assert.deepEqual(f.meta('.gild/queue.json'),[2]);assert.equal(f.meta('.gild/2/pr/pr.json').state,'open')
 f.allow();const finished=await f.drain();assert.equal(finished.queued,false);assert.deepEqual(finished.completed,['intent-one'])
 assert.notEqual(f.ref('main'),before);assert.equal(f.meta('.gild/2/pr/pr.json').state,'merged');assert.equal(f.meta('.gild/1/issue/issue.json').state,'closed')
 assert.ok(f.checked.every(sha=>sha===f.head),'CI must check the actual selected head')
 const accepted=f.ref('main'),metadata=f.ref('_meta');await f.drain();assert.equal(f.ref('main'),accepted);assert.equal(f.ref('_meta'),metadata,'completed drain must not create another commit')
})
test('lost post-push notification recovers original merge receipt without a second Git merge',async t=>{
 const f=await fixture(t);f.allow();f.fail();await assert.rejects(f.drain(),/Lost post-push notification/)
 const accepted=f.ref('main');assert.notEqual(accepted,f.base);assert.equal(f.meta('.gild/2/pr/pr.json').state,'open')
 f.deleteHead() // recovery is finalization, not a new head/CI authorization
 const recovered=await f.drain();assert.equal(recovered.queued,false);assert.equal(f.ref('main'),accepted,'uncertain code push must never be merged twice')
 assert.equal(f.meta('.gild/2/pr/pr.json').merged.commit,accepted,'recovery records original merge commit')
})
test('changed head and stale approval cannot silently merge even with successful current CI',async t=>{
 const f=await fixture(t);f.allow();f.advance();const before=f.ref('main')
 assert.equal((await f.drain()).queued,true);assert.equal(f.ref('main'),before,'changed head must require a new queue approval')
 assert.equal(f.meta('.gild/2/pr/pr.json').state,'open')
})
test('user-authored Git merge marker cannot replace server receipt or bypass CI',async t=>{
 const f=await fixture(t)
 f.run('switch','main');f.run('-c','commit.gpgsign=false','merge','--no-ff','feature','-m','Forged merge\n\nGild-Merge-Intent: intent-one');
 // The fixture remote can be addressed through the source's known sibling.
 f.run('push','../repo.git','main');f.run('switch','_meta')
 const forged=f.ref('main')
 assert.equal((await f.drain()).queued,true,'unattested marker must still require current CI')
 assert.equal(f.meta('.gild/2/pr/pr.json').state,'open','untrusted message cannot finalize a PR')
 assert.equal(f.ref('main'),forged)
})
test('fresh approval on a moved head still requires a new explicit queue selection',async t=>{
 const f=await fixture(t);f.allow();f.advance();const head=f.ref('feature')
 f.edit('.gild/2/pr/r-2-fresh.json',{id:'fresh',author:'reviewer',verdict:'approve',headOid:head})
 assert.equal((await f.drain()).queued,true);assert.equal(f.ref('main'),f.base,'queued head pin cannot silently become a newer selection')
})
test('legacy queue also rejects approval from an older head',async t=>{
 const f=await fixture(t);f.allow();f.advance();const {queueIntent,...legacy}=f.pull;f.edit('.gild/2/pr/pr.json',legacy)
 assert.equal((await f.drain()).queued,true);assert.equal(f.ref('main'),f.base,'legacy queue cannot substitute stale approval for the current head')
})
test('actual RunQueue alarm resumes persisted Git queue after reconstruction and serializes concurrent wakes',async t=>{
 const f=await fixture(t), alarms:number[]=[]
 const sql:any={exec(q:string,...args:any[]){if(!args.length&&q.includes(';')){f.db.exec(q);return []}const st=f.db.prepare(q);if(st.columns().length)return st.all(...args);st.run(...args);return []}}
 const state:any={storage:{sql,getAlarm:async()=>null,setAlarm:async(at:number)=>{alarms.push(at)},transactionSync(fn:()=>any){f.db.exec('BEGIN');try{const r=fn();f.db.exec('COMMIT');return r}catch(error){f.db.exec('ROLLBACK');throw error}}}}
 const env:any={DB:{},ARTIFACTS_TOKEN:'fixture-only'}
 ;(globalThis as any).__mergeRuntime=f.runtime
 let queue=new RunQueue(state,env);await queue.init('acme','demo');queue.writable=async()=>true
 const id=await queue.prepareMerge(2);assert.ok(f.intents.pending().some(intent=>intent.id===id),'prepare must be durable before Git acceptance');assert.ok(alarms.length)
 await queue.alarm();assert.equal(f.ref('main'),f.base);assert.equal(f.intents.needed(),true,'CI pending must retain a durable wake')
 f.edit(`.gild/merge-requests/${id}.json`,{id,number:2,headOid:f.head})
 queue=new RunQueue(state,env);await queue.init('acme','demo');queue.writable=async()=>true;f.allow()
 await Promise.all([queue.alarm(),queue.alarm(),queue.alarm()])
 assert.equal(f.meta('.gild/2/pr/pr.json').state,'merged','alarm must execute the production drain without Next context')
 assert.equal(f.pushes.length,1,'concurrent alarms must share one drain')
 assert.equal(f.intents.needed(),false,'only observed completed receipts retire durable work')
 delete (globalThis as any).__mergeRuntime
})
test('concurrent drains create one Git merge and one merged metadata event',async t=>{
 const f=await fixture(t);f.allow()
 let arrived=0,release!:()=>void
 const both=new Promise<void>(resolve=>{release=resolve})
 ;(f.runtime as any).pushed=async()=>{if(++arrived===2)release();await both}
 await Promise.all([f.drain(),f.drain()])
 assert.equal(f.meta('.gild/2/pr/pr.json').state,'merged')
 const paths=f.run('--git-dir='+f.run('rev-parse','--show-toplevel')+'/../repo.git','ls-tree','-r','--name-only','_meta').split('\n').filter(path=>path.startsWith('.gild/2/log/'))
 assert.equal(paths.filter(path=>f.meta(path).kind==='merged').length,1,'concurrent drains must not duplicate merged metadata events')
})
test('queue selection cannot silently move to another base branch',async t=>{
 const f=await fixture(t);f.allow();f.run('branch','alternate-base','main');f.run('push','../repo.git','alternate-base')
 f.edit('.gild/2/pr/pr.json',{...f.pull,base:'alternate-base'})
 assert.equal((await f.drain()).queued,true);assert.equal(f.ref('alternate-base'),f.base,'selected base requires a fresh explicit queue request')
})
test('review changes after the first CI check block the final code push',async t=>{
 const f=await fixture(t);let first=true
 ;(f.runtime as any).gate=()=>{if(first){first=false;f.edit('.gild/2/pr/r-2-changes.json',{id:'changes',author:'reviewer',verdict:'changes',headOid:f.head})}return{ok:true}}
 assert.equal((await f.drain()).queued,true);assert.equal(f.ref('main'),f.base,'latest review must be rechecked immediately before push')
 assert.equal(f.intents.planned('intent-one').length,0,'unaccepted permission cannot become a recovery attestation')
})
test('merge preparation preserves an earlier Actions alarm',async()=>{
 const db=new DatabaseSync(':memory:')
 const sql:any={exec(q:string,...args:any[]){if(!args.length&&q.includes(';')){db.exec(q);return []}const st=db.prepare(q);if(st.columns().length)return st.all(...args);st.run(...args);return []}}
 let at=Date.now()+100
 const state:any={storage:{sql,getAlarm:async()=>at,setAlarm:async(next:number)=>{at=next}}}
 const q=new RunQueue(state,{DB:{}});const earlier=at
 await q.prepareMerge(2);await q.requestMergeScan()
 assert.equal(at,earlier,'durable merge wake must not postpone earlier workflow work');db.close()
})
test('new changes-requested review blocks an already queued merge',async t=>{
 const f=await fixture(t);f.allow();f.edit('.gild/2/pr/r-2-changes.json',{id:'changes',author:'reviewer',verdict:'changes',headOid:f.head})
 assert.equal((await f.drain()).queued,true);assert.equal(f.ref('main'),f.base,'latest blocking review must be rechecked after enqueue')
})
test('closed queued PR is removed without a code push; uncommitted preparations stay pending',async t=>{
 const f=await fixture(t);f.allow();f.edit('.gild/2/pr/pr.json',{...f.pull,state:'closed'});f.intents.prepare(3,'uncommitted')
 const result=await f.drain();assert.equal(result.queued,false);assert.deepEqual(result.completed,['intent-one']);assert.equal(f.ref('main'),f.base)
 f.intents.retire(result.completed);assert.deepEqual(f.intents.pending(),[{id:'uncommitted',number:3}],'missing Git receipt must retain durable preparation')
})
