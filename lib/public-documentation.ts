import type { D1Database, Fetcher } from '@cloudflare/workers-types'
import deployment from '../.render/next-assets.json' with { type: 'json' }
import { documentationAsset, documentationRoutes } from './documentation-routes.ts'
import { defaultEdge, type EdgeContext } from './fragments/edge.ts'
import { withIslands, type FragmentIslands } from './fragments/viewer-islands.ts'
import { d1ViewerReads } from './page-reads.ts'
import { identityForPage } from './page-identity.ts'
import { SESSION_COOKIE, verifySessionCookie } from './session-cookie.ts'
import { preparingPage, rendererShell } from './status-pages.ts'
import { viewerShell } from '../packages/presentation/viewer-shell.ts'

type DocumentEnv = Parameters<typeof rendererShell>[0] & { DB: D1Database; ASSETS: Pick<Fetcher, 'fetch'>; SESSION_SECRET?: string }

/** Read build-produced HTML. A missing artifact stays Pending; no Next fallback or build-on-read. */
export async function publicDocumentationHTTP(request: Request, env: DocumentEnv, ctx: EdgeContext): Promise<Response | null> {
  const url = new URL(request.url), document = documentationRoutes.find(d => d.path === url.pathname)
  // Next's client treats a text/html response as a full document navigation;
  // old RSC callers must not force this build-owned route back into Next.
  if (!document || !['GET', 'HEAD'].includes(request.method)) return null
  const raw = (request.headers.get('cookie') ?? '').split(';').map(p => p.trim()).find(p => p.startsWith(SESSION_COOKIE + '='))?.slice(SESSION_COOKIE.length + 1)
  const identity = (async () => {
    const session = await verifySessionCookie(raw, env.SESSION_SECRET)
    return identityForPage(await d1ViewerReads(env.DB, session), session)
  })()
  const body = (async () => {
    const edge = defaultEdge(), key = new Request(new URL(`/__gild-documents/${deployment.build}/${document.id}`, request.url))
    const hit = await edge?.match(key)
    if (hit) return hit.text()
    // Direct static-asset binding, with no viewer headers. Only neutral HTML is cached.
    const response = await env.ASSETS.fetch('https://gild.gg' + documentationAsset(deployment.build, document.id))
    if (response.status === 404) return null
    if (!response.ok || response.headers.has('set-cookie')) throw new Error('Prepared documentation asset unavailable')
    const html = await response.text()
    if (!html.includes(`data-prepared-document="${document.path}"`) || !html.includes('</html>')) throw new Error('Invalid prepared documentation asset')
    if (edge) ctx.waitUntil(edge.put(key, new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' } })).catch(() => {}))
    return html
  })()
  const [html, account] = await Promise.all([body, identity])
  const islands: FragmentIslands = { repository: '', name: account?.name ?? null, claimed: account?.claimed, picture: account?.picture ?? null, count: 0, starred: false, write: false, contributor: false }
  const response = html === null ? await preparingPage(request, () => rendererShell(env)) : new Response(request.method === 'HEAD' ? null : viewerShell(html, url, !!account), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
  })
  const personalized = withIslands(response, Promise.resolve(islands))
  return new Response(request.method === 'HEAD' ? null : await personalized.text(), { status: personalized.status, headers: personalized.headers })
}
