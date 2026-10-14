import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { RunStore } from './actions/store.ts'
import { parseWorkflow } from './actions/workflow.ts'
import { actionHandler } from './api/actions.ts'
import { routes } from './api/contract.ts'
import type { Context } from './api/dispatch.ts'

test('v1 modal Actions log paging reads output past chunk 128 and fences other jobs',async()=>{
  const db=new DatabaseSync(':memory:')
  const sql={exec:(q:string,...a:any[])=>{if(!a.length&&q.includes(';')){db.exec(q);return []}return db.prepare(q).all(...a) as any}}
  const store=new RunStore(sql)
  try {
    const workflow=parseWorkflow('ci.yml','name: CI\non: [push]\njobs:\n  test:\n    runs-on: self-hosted\n    steps:\n      - run: echo output\n')
    const run=store.enqueue(workflow,{name:'push',sha:'a'.repeat(40),ref:'refs/heads/main',actor:'acme',title:'Run',repository:'acme/demo',paths:[],key:'logs'},1000)
    store.register({id:'runner',name:'runner',owner:'acme',os:'linux',arch:'x64',labels:[]},'hash',1000)
    const runner=store.authenticate('hash')!,job=store.claim(runner,1001)!.job
    for(let n=0;n<130;n++)store.append(runner.id,job.id,job.lease!,0,n,['output-'+n],[],1002)
    const q={overview:async()=>({runs:[],runners:[]}),detail:async(id:number)=>store.detail(id),logs:async(j:number,s:number,a:number)=>store.logs(j,s,a)}
    const handler=actionHandler({runQueue:async()=>q as never,dispatch:async()=>0,mayWrite:async()=>true})
    const route=routes.find(r=>r.id==='actionLogs')!
    const context=(query:unknown):Context=>({route,params:{owner:'acme',repo:'demo',run:String(run)},query:route.query.parse(query),body:{},principal:{id:'owner',name:'acme',publicKey:'fixture',scopes:null,repos:null},request:new Request('https://gild.gg/api/v1/repos/acme/demo/actions/runs/'+run+'/logs')})
    const first=route.output.parse((await handler(context({job:job.id,step:0}))).data)
    assert.equal(first.logs.length,128)
    const next=route.output.parse((await handler(context({job:job.id,step:0,after:first.logs.at(-1)!.seq}))).data)
    assert.deepEqual(next.logs.map(c=>c.text),['output-128\n','output-129\n'])
    await assert.rejects(handler(context({job:job.id+1,step:0})),e=>(e as {status:number}).status===404)
    await assert.rejects(handler(context({job:job.id,step:1})),e=>(e as {status:number}).status===404)
  } finally {db.close()}
})
