import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publicStaticHTML } from './public-static-html.ts'
import type { EdgeCache } from './fragments/edge.ts'

test('built auth documents are stored once, with viewer credentials excluded from HTML', async () => {
  const entries=new Map<string,Response>(),pending:Promise<unknown>[]=[]
  const edge:EdgeCache={async match(r){return entries.get(r.url)?.clone()},async put(r,value){entries.set(r.url,value)}}
  const ctx={waitUntil(p:Promise<unknown>){pending.push(p)}}
  let calls=0
  const forward=async (r:Request)=>{
    calls++; assert.equal(r.headers.get('cookie'),null);assert.equal(r.headers.get('authorization'),null)
    return new Response('<html>built document</html>',{headers:{'content-type':'text/html'}})
  }
  for(const path of ['/auth/device','/auth/claim']) {
    const request=new Request('https://gild.test'+path,{headers:{cookie:'gild_session=first',authorization:'Bearer first'}})
    assert.equal(await (await publicStaticHTML(request,ctx,forward,edge))?.text(),'<html>built document</html>')
    await Promise.all(pending.splice(0))
    const previous=calls
    const warm=await publicStaticHTML(new Request(request.url,{headers:{cookie:'gild_session=second'}}),ctx,forward,edge)
    assert.equal(await warm?.text(),'<html>built document</html>')
    assert.equal(calls,previous,'warm built document must not invoke the server adapter')
    const head=await publicStaticHTML(new Request(request.url,{method:'HEAD'}),ctx,forward,edge)
    assert.equal(await head?.text(),'');assert.equal(calls,previous)
    assert.equal(warm?.headers.get('cache-control'),'public, max-age=0, must-revalidate')
  }
  assert.equal(calls,2)
  assert.equal(await publicStaticHTML(new Request('https://gild.test/settings/profile'),ctx,forward,edge),null)
  assert.equal(await publicStaticHTML(new Request('https://gild.test/docs/api',{headers:{rsc:'1'}}),ctx,forward,edge),null)
})
test('build document failures and cookie-bearing responses never become artifacts', async () => {
  let stores=0
  const edge:EdgeCache={async match(){return undefined},async put(){stores++}}
  for(const response of [new Response('failure',{status:503}),new Response('identity',{headers:{'set-cookie':'session=bad','content-type':'text/html'}})]) {
    const result=await publicStaticHTML(new Request('https://gild.test/auth/device'),{waitUntil(){}},async()=>response,edge)
    assert.equal(result,response)
  }
  assert.equal(stores,0)
})
