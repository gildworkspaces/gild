import { test } from 'node:test'
import assert from 'node:assert/strict'
import { purgeV1 } from '../scripts/purge-v1.mjs'
test('operator purge lists only v1 public keys, batches URL purges, and follows cursors',async()=>{
  const calls: { url: string; init: RequestInit }[] = []
  let page=0
  const result=await purgeV1({token:'fixture-secret',account:'fixture',zone:'zone',fetcher:async(url:string,init:RequestInit)=>{
    calls.push({url,init})
    if(url.includes('/objects?'))return Response.json({success:true,result:Array.from({length:page++ ? 1 : 101},(_,i)=>({key:'f/v1/blob/'+i})),result_info:{cursor:page===1?'next':''}})
    return Response.json({success:true})
  }})
  assert.equal(result,102)
  assert.equal(calls.filter(c=>c.url.includes('purge_cache')).length,3)
  assert.ok(calls[3].url.includes('cursor=next'))
  for(const c of calls.filter(c=>c.url.includes('purge_cache')))assert.ok(JSON.parse(c.init.body as string).files.every((s:string)=>s.startsWith('https://gild.gg/f/v1/')))
  await assert.rejects(purgeV1({token:'fixture-secret',account:'fixture',zone:'zone',fetcher:async()=>Response.json({success:false},{status:403})}),/R2 listing failed/)
})
