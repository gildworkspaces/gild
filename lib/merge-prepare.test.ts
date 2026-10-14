import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {mkdirSync} from 'node:fs'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
mkdirSync('.tmp',{recursive:true})
const mocks:Record<string,string>={
 meta:`export const DIR='/meta';export const newId=()=>'';export const stamp=()=>'';export const authFor=()=>()=>({});export const nextNumber=()=>1;export const readIndex=()=>({pulls:[],queue:[]});
 export const cloneBranch=async()=>({mkdir:async()=>{}});export const readJson=async(_fs,path)=>{const raw=globalThis.__mergePreparation.files.get(path);return raw?JSON.parse(raw):null};export const writeJson=async(_fs,path,value)=>{globalThis.__mergePreparation.files.set(path,JSON.stringify(value))};
 export const readAll=async(_fs,_dir,prefix)=>prefix==='r-'?[globalThis.__mergePreparation.review]:[];export const logEvent=async()=>{globalThis.__mergePreparation.events++};export const writeMeta=async(_o,_r,_m,_a,change)=>globalThis.__mergePreparation.write(change);`,
 queue:`export const runQueue=async()=>globalThis.__mergePreparation.queue;export const scheduleActions=()=>{};export const triggerPull=()=>{};export const triggerPush=()=>{};`,
 index:`export const pageIndex=async()=>({metaItem:async n=>{const f=globalThis.__mergePreparation;return {item:JSON.parse(f.files.get('/meta/.gild/'+n+'/pr/pr.json')),comments:[],reviews:[f.review],log:[],queue:[]}}});export const readyIndex=async()=>null;export const repoIndex=async()=>null;export const scheduleIndex=async()=>{};`,
 repo:`export const repoRefs=async()=>({branches:[{name:'feature',oid:'${'a'.repeat(40)}'}]});`,
}
const outfile=resolve('.tmp/merge-prepare-test.mjs')
await build({stdin:{contents:"export {enqueuePull} from './lib/pulls.ts'",resolveDir:resolve('.')},outfile,bundle:true,platform:'node',format:'esm',packages:'external',plugins:[{name:'write-retry-ports',setup(b){
 for(const [pattern,path]of [[/\/metastore$/,'meta'],[/\/actions\/service$/,'queue'],[/\/repo-index$/,'index'],[/\/repo$/,'repo']]as const)b.onResolve({filter:pattern},()=>({path,namespace:'fixture'}))
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:mocks[a.path],loader:'js'}))
}}]})
const {enqueuePull}=await import(pathToFileURL(outfile).href)
function fixture(mode:'receipt'|'later-rejection'|'first-rejection'){
 const head='a'.repeat(40),id='prepared-request'
 const files=new Map<string,string>([['/meta/.gild/2/pr/pr.json',JSON.stringify({schema:1,number:2,title:'PR',body:'',author:'writer',createdAt:'2026-10-11T20:00:00Z',head:'feature',base:'main',state:'open'})],['/meta/.gild/queue.json','[]']])
 const initial=new Map(files),prepared=new Set<string>(),trace:string[]=[]
 const f:any={files,events:0,rejected:0,review:{id:'one',author:'reviewer',verdict:mode==='first-rejection'?'changes':'approve',headOid:head},
  queue:{prepareMerge:async()=>{trace.push('prepared');prepared.add(id);return id},rejectMerge:async()=>{f.rejected++;prepared.delete(id)}}}
 f.write=async(change:any)=>{
  trace.push('write');assert.equal(prepared.has(id),true,'Git write must follow durable preparation')
  await change({mkdir:async()=>{}})
  if(mode==='later-rejection')f.files=new Map(initial)
  f.review={...f.review,verdict:'changes'}
  return change({mkdir:async()=>{}})
 }
 ;(globalThis as any).__mergePreparation=f
 return{f,prepared,trace}
}
test('same queue receipt reconciles an interrupted write before changed-review rejection without another commit',async()=>{
 const {f,prepared,trace}=fixture('receipt')
 assert.equal(await enqueuePull('acme','demo',2,'owner'),true)
 assert.deepEqual(trace,['prepared','write']);assert.equal(f.events,1,'same accepted queue operation must not run its event/mutation twice')
 assert.equal(f.rejected,0);assert.equal(prepared.size,1,'accepted intent must remain durable for the alarm')
})
test('a later retry rejection cannot discard an earlier uncertain queue application',async()=>{
 const {f,prepared}=fixture('later-rejection')
 await assert.rejects(enqueuePull('acme','demo',2,'owner'),/approval|changes/)
 assert.equal(f.rejected,0,'uncertain earlier application must not release its durable merge intent')
 assert.equal(prepared.size,1)
})
test('known first callback validation rejection retires only its uncommitted preparation',async()=>{
 const {f,prepared}=fixture('first-rejection')
 await assert.rejects(enqueuePull('acme','demo',2,'owner'),/approval|changes/)
 assert.equal(f.events,0);assert.equal(f.rejected,1);assert.equal(prepared.size,0)
})
