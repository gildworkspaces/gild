import deployment from '../.render/next-assets.json' with { type:'json' }
import { defaultEdge, type EdgeCache, type EdgeContext } from './fragments/edge.ts'

import { builtPublicPages } from './public-page-route.ts'
import { documentationRoutes } from './documentation-routes.ts'
const builtPages = new Set(builtPublicPages.filter(path => !documentationRoutes.some(d => d.path === path)))
/** Next already builds these documents. Retain the complete anonymous HTML at
 * the edge under its immutable build instead of decoding the adapter each time. */
export async function publicStaticHTML(request: Request, ctx: EdgeContext,
  forward: (request: Request) => Promise<Response>, edge: EdgeCache | undefined = defaultEdge()) {
  const url = new URL(request.url)
  if (!builtPages.has(url.pathname) || !['GET','HEAD'].includes(request.method) || request.headers.has('rsc') || !edge) return null
  const key = new Request(new URL('/__gild-static-html/' + deployment.build + url.pathname, request.url))
  let response = await edge.match(key)
  if (!response) {
    const headers = new Headers(request.headers)
    headers.delete('cookie'); headers.delete('authorization')
    const rendered = await forward(new Request(request.url,{method:'GET',headers}))
    if (rendered.status !== 200 || rendered.headers.has('set-cookie') || !rendered.headers.get('content-type')?.includes('text/html')) return rendered
    const storedHeaders = new Headers(rendered.headers)
    storedHeaders.set('cache-control','public, max-age=31536000, immutable')
    response = new Response(rendered.body,{headers:storedHeaders,...{encodeBody:'manual'}})
    ctx.waitUntil(edge.put(key,response.clone()).catch(()=>{}))
  }
  const headers = new Headers(response.headers)
  headers.set('cache-control','public, max-age=0, must-revalidate')
  return new Response(request.method==='HEAD'?null:response.body,{headers,...{encodeBody:'manual'}})
}
