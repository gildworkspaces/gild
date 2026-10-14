import siteVersion from '../.render/site-version.json'
import deployment from '../.render/next-assets.json'
import type { D1Database,R2Bucket } from '@cloudflare/workers-types'
import { PUBLIC_GRANT } from './fragments/catalog'
import { publicLeases,defaultEdge,type EdgeContext,type EdgeCache } from './fragments/edge'
import { digest,PUBLIC_CACHE,PUBLIC_EDGE_CACHE } from '../packages/render/address'
/** Search HTML is a stored shell. Query results are also immutable once their
 * current public ref/ACL graph is resolved; only the graph uses a short lease. */
export async function publicSearchHTTP(request:Request,env:{DB:D1Database;FRAGMENTS:R2Bucket},ctx:EdgeContext,
 forward:(request:Request)=>Promise<Response>,edge:EdgeCache|undefined=defaultEdge(),now=Date.now) {
 const url=new URL(request.url),scope=url.pathname.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/search$/)
 if(url.pathname!=='/api/search'&&!scope)return null
 if(request.method!=='GET'||request.headers.has('authorization')||/(?:^|;\s*)gild_session=/.test(request.headers.get('cookie')??''))return null
 const q=url.searchParams.get('q')??'',page=Math.min(10000,Math.max(1,Number(url.searchParams.get('page'))||1))
 if(q.length>2048)return null
 const readCatalogue=async()=>{
  const rows=(await env.DB.prepare(`SELECT h.pointer FROM fragment_heads h JOIN repo_access a ON a.id=h.id
    LEFT JOIN settings_entities e ON e.id=h.id
    LEFT JOIN settings_entities org ON org.key=substr(coalesce(e.key,h.id),1,instr(coalesce(e.key,h.id),'/')-1)
    WHERE ${PUBLIC_GRANT} AND json_extract(h.pointer,'$.meta') IS a.meta
    AND (? IS NULL OR json_extract(h.pointer,'$.repository')=?) ORDER BY h.id,h.ref`)
   .bind(scope?scope[1]+'/'+scope[2]:null,scope?scope[1]+'/'+scope[2]:null).all<{pointer:string}>()).results
  return rows.map(r=>JSON.parse(r.pointer))
 }
 const catalogue=await publicLeases(request,ctx,edge,now)('search-catalogue:'+JSON.stringify(scope?.slice(1)??[]),readCatalogue,value=>!!value.length)
 if(!catalogue.length)return null
 const hash=await digest(JSON.stringify([siteVersion.hash,deployment.build,catalogue,q,page,url.searchParams.get('mode')??'code']))
 const key=new Request(url.origin+'/__gild-search/'+hash)
 const cached=await edge?.match(key)
 if(cached)return new Response(cached.body,{headers:{'content-type':'application/json','cache-control':PUBLIC_CACHE}})
 const object=await env.FRAGMENTS.get('search/'+hash)
 let response:Response
 if(object)response=new Response(object.body as unknown as ReadableStream,{headers:{'content-type':'application/json'}})
 else {
  const headers=new Headers(request.headers);headers.delete('cookie');headers.delete('authorization')
  headers.set('x-gild-public-repos',JSON.stringify([...new Set(catalogue.map(p=>p.repository))]))
  headers.set('x-gild-search-snapshot',JSON.stringify(catalogue))
  response=await forward(new Request(request,{headers}))
  if(!response.ok)return response
  const bytes=await response.arrayBuffer()
  const result=JSON.parse(new TextDecoder().decode(bytes)) as {indexing?:boolean;partial?:boolean}
  if(result.indexing || result.partial || JSON.stringify(await readCatalogue())!==JSON.stringify(catalogue))
    return new Response(bytes,{headers:{'content-type':'application/json','cache-control':'private, no-store'}})
  await env.FRAGMENTS.put('search/'+hash,bytes,{httpMetadata:{contentType:'application/json'}})
  response=new Response(bytes,{headers:{'content-type':'application/json'}})
 }
 if(edge){const stored=response.clone();stored.headers.set('cache-control',PUBLIC_EDGE_CACHE);ctx.waitUntil(edge.put(key,stored).catch(()=>{}))}
 return new Response(response.body,{headers:{'content-type':'application/json','cache-control':PUBLIC_CACHE}})
}
