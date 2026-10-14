import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'

// Exercise the canonical client exactly as the CLI generator bundles it.
const compiled=await build({entryPoints:['lib/api/client.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {ApiRequestError,GildClient}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].contents).toString('base64'))

test('structured API codes retain old constructor and freeze a copied array',()=>{
  const legacy=new ApiRequestError(403,'Denied')
  assert.equal(legacy.status,403);assert.equal(legacy.message,'Denied')
  assert.deepEqual(legacy.codes,[]);assert.equal(legacy.code,undefined)
  const input=['PREPARATION_PENDING','SECOND'],error=new ApiRequestError(503,'Pending',input)
  input[0]='changed';input.push('extra')
  assert.deepEqual(error.codes,['PREPARATION_PENDING','SECOND']);assert.equal(error.code,'PREPARATION_PENDING')
  assert.equal(Object.isFrozen(error.codes),true)
  assert.throws(()=>error.codes.push('changed'),TypeError)
})
test('real client extracts only string codes and makes exactly one HTTP call',async()=>{
  let calls=0
  const client=new GildClient('https://gild.test/api/v1','gf_fixture',async()=>{
    calls++
    return Response.json({message:'Pending',errors:[null,{code:42},{message:'ignored'},{code:'PREPARATION_PENDING'},{code:'SECOND'}]},{status:503})
  })
  await assert.rejects(client.request('ownerRepoCards',{owner:'acme'}),error=>{
    assert.ok(error instanceof ApiRequestError);assert.equal(error.status,503)
    assert.equal(error.code,'PREPARATION_PENDING');assert.deepEqual(error.codes,['PREPARATION_PENDING','SECOND'])
    return true
  })
  assert.equal(calls,1,'typed Pending must not trigger client retries')
})
test('legacy errors and non-JSON responses retain status/message without invented codes',async()=>{
  for(const response of [Response.json({message:'Denied'},{status:403}),new Response('no json',{status:404})]){
    const client=new GildClient('https://gild.test/api/v1','gf_fixture',async()=>response)
    await assert.rejects(client.request('ownerRepoCards',{owner:'acme'}),error=>{
      assert.equal(error.status,response.status);assert.deepEqual(error.codes,[]);assert.equal(error.code,undefined)
      assert.equal(error.message,response.status===403?'Denied':'HTTP 404');return true
    })
  }
})
