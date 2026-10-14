import assets from '../.render/next-assets.json'
import type { D1Database,R2Bucket,Fetcher } from '@cloudflare/workers-types'
import { ASSET_CACHE } from '../packages/render/address'
export interface PublicAssetEnv { DB:D1Database;FRAGMENTS:R2Bucket;ASSETS:Pick<Fetcher,'fetch'> }
/** Copy the deployment's complete immutable chunk/font graph once, before
 * publishing HTML that references it. Old pages remain usable at a cold PoP. */
export async function retainPublicAssets(env:PublicAssetEnv) {
  if(await env.DB.prepare('SELECT 1 FROM public_asset_builds WHERE build=?').bind(assets.build).first())return
  for(const route of assets.routes) {
    const key='next-assets'+route
    if(await env.FRAGMENTS.head(key))continue
    const response=await env.ASSETS.fetch('https://gild.gg'+route)
    if(!response.ok)throw Error('Immutable deployment asset missing: '+route)
    await env.FRAGMENTS.put(key,await response.arrayBuffer(),{httpMetadata:{contentType:response.headers.get('content-type')??'application/octet-stream'}})
  }
  await env.DB.prepare('INSERT OR IGNORE INTO public_asset_builds VALUES (?)').bind(assets.build).run()
}
export async function retainedAssetHTTP(request:Request,env:PublicAssetEnv) {
  const url=new URL(request.url)
  if(!url.pathname.startsWith('/_next/static/') || !['GET','HEAD'].includes(request.method))return null
  // Current deployment assets normally bypass the Worker via ASSETS. This
  // fallback is for a retained page's old deployment at an otherwise cold PoP.
  const object=await env.FRAGMENTS.get('next-assets'+url.pathname)
  if(!object)return null
  return new Response(request.method==='HEAD'?null:object.body as unknown as ReadableStream,{headers:{
    'content-type':object.httpMetadata?.contentType??'application/octet-stream',
    'cache-control':ASSET_CACHE,etag:object.httpEtag,'x-content-type-options':'nosniff',
  }})
}
