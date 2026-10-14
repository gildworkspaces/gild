import { publicSearchHTTP } from '../lib/public-search'
import { retainedAssetHTTP } from '../lib/public-assets'
import { publicPageHTTP, publishPublicPage, publishedPublicPage, publicCatalog } from '../lib/public-pages'
import { invalidatePublicReads } from '../lib/fragments/edge'
import type { D1Database,R2Bucket } from '@cloudflare/workers-types'
export default { async fetch(request:Request,env:{DB:D1Database;FRAGMENTS:R2Bucket},ctx:{waitUntil(p:Promise<unknown>):void}) {
  const url=new URL(request.url)
  if (url.pathname==='/fixture/publish') {
    let renders=0
    const result = await publishPublicPage(env,url.searchParams.get('route')!,async r=>{
      renders++
      if(r.headers.has('cookie')||r.headers.has('authorization'))throw Error('Producer received viewer credentials')
      if(url.searchParams.has('race')) await env.DB.prepare("UPDATE repo_access SET acl='{\"private\":true}' WHERE id='acme/demo'").run()
      return new Response('<!doctype html><html><body>public stored page<a href="/acme/demo/issues/1">issue 1</a></body></html>')
    },url.origin)
    return Response.json({result,renders,catalog:await publicCatalog(env.DB)})
  }
  if (url.pathname==='/fixture/invalidate') {await invalidatePublicReads(url.origin);return new Response('ok')}
  const oldAsset=await retainedAssetHTTP(request,env as never)
  if(oldAsset)return oldAsset
  const calls={do:0,d1:0,r2:0,render:0}
  const db={prepare(sql:string){calls.d1++;return env.DB.prepare(sql)}} as D1Database
  const bucket={get(key:string){calls.r2++;return env.FRAGMENTS.get(key)},put(...args:Parameters<R2Bucket['put']>){calls.r2++;return env.FRAGMENTS.put(...args)}} as R2Bucket
  const response=await publicSearchHTTP(request,{DB:db,FRAGMENTS:bucket},ctx,async r=>{
    calls.do++
    if(r.headers.get('x-gild-public-repos')!=='["acme/demo"]')throw Error('cached search must restrict its immutable catalog')
    return Response.json({count:1,hits:[],languages:{},paths:{},suggestions:[],fallback:false,indexing:false})
  },undefined,()=>Number(request.headers.get('x-time')??Date.now())) ?? await publicPageHTTP(request,{DB:db,FRAGMENTS:bucket},ctx,r=>publishedPublicPage(db,r),undefined,()=>Number(request.headers.get('x-time')??Date.now()))
    ?? new Response('not public',{status:404})
  const headers=new Headers(response.headers);headers.set('x-fixture-calls',JSON.stringify(calls))
  return new Response(response.body,{status:response.status,headers})
} }
