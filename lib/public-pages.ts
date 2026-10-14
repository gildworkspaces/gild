import { contributorPath } from './privacy-http.ts'
import { repoTabDocument } from './repo-tab-document'
import {ensurePreparedOwnerCatalogue} from './prepared-catalogue-source'
import { channelFrom, type ChannelBindings } from './channel/binding'
import siteVersion from '../.render/site-version.json'
import deployment from '../.render/next-assets.json'
import type { D1Database, R2Bucket, Queue } from '@cloudflare/workers-types'
import { PUBLIC_GRANT } from './fragments/catalog'
import { publicLeases, defaultEdge, type EdgeContext, type EdgeCache } from './fragments/edge'
import { digest, PUBLIC_CACHE, PUBLIC_EDGE_CACHE } from '../packages/render/address'
import { timed } from './fragments/http'

export interface PublicPage { hash: string; dependencies: string; owner: string | null }
export interface PublicPageEnv extends ChannelBindings { DB: D1Database; FRAGMENTS: R2Bucket; ARTIFACTS_TOKEN?:string }
export { publicPageRoute } from './public-page-route'
import { publicPageRoute } from './public-page-route'

/** A single primary query validates ALL dependencies, including aggregate
 * listings, deletion, rename and imports. No replication lag in a grant. */
export async function publishedPublicPage(db: D1Database, route: string): Promise<PublicPage | null> {
  return db.prepare(`SELECT p.hash,p.dependencies,p.owner FROM public_pages p
    LEFT JOIN settings_entities owner ON owner.key=p.owner
    WHERE p.route=? AND owner.deleted_at IS NULL AND coalesce(owner.moving,0)=0
    AND NOT EXISTS(SELECT 1 FROM settings_aliases WHERE name=p.owner)
    AND NOT EXISTS(SELECT 1 FROM json_each(p.dependencies) dep
      LEFT JOIN repo_access a ON a.id=json_extract(dep.value,'$.id')
      LEFT JOIN settings_entities e ON e.id=a.id
      LEFT JOIN settings_entities org ON org.key=substr(coalesce(e.key,a.id),1,instr(coalesce(e.key,a.id),'/')-1)
      WHERE a.id IS NULL OR NOT (${PUBLIC_GRANT})
      OR coalesce(e.key,a.id)<>json_extract(dep.value,'$.address'))`)
    .bind(route).first<PublicPage>()
}

export async function publicPageHTTP(request: Request, env: PublicPageEnv, ctx: EdgeContext,
  read = (route: string) => publishedPublicPage(env.DB, route), edge: EdgeCache | undefined = defaultEdge(), now = Date.now) {
  const address = publicPageRoute(new URL(request.url))
  if (!address || !['GET','HEAD'].includes(request.method)) return null
  const start = performance.now()
  const page = await publicLeases(request, ctx, edge, now)('page:' + address.route, () => read(address.route), Boolean)
  if (!page) return null
  const noStore=(JSON.parse(page.dependencies) as PublicDependency[]).some(d=>d.readCache==='no-store')
  if (request.headers.has('rsc')) return new Response(null, { status: 409, headers: {
    'x-gild-location': address.route, 'cache-control': 'private, no-store',
  } })
  // The grant above is compulsory even for an immutable HTML hit.
  const key = new Request(new URL('/__gild-html/' + page.hash, request.url))
  let response = noStore?undefined:await edge?.match(key)
  const hit = !!response
  if (!response) {
    const object = await env.FRAGMENTS.get('pages/' + page.hash)
    if (!object) return null
    response = new Response(object.body as unknown as ReadableStream, { headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': PUBLIC_EDGE_CACHE,
      'x-content-type-options': 'nosniff', etag: '"' + page.hash + '"',
    } })
    if (edge&&!noStore) ctx.waitUntil(edge.put(key, response.clone()).catch(() => {}))
  }
  return timed(new Response(request.method === 'HEAD' ? null : response.body, { headers: {
    ...Object.fromEntries(response.headers), 'cache-control': noStore?'no-store':PUBLIC_CACHE,
  } }), start, `page;desc="published HTML", r2;dur=${hit ? '0' : (performance.now()-start).toFixed(2)}, render;dur=0`)
}
export interface PublicDependency { id: string; address: string;readCache?:'no-store' }
export async function publicCatalog(db: D1Database): Promise<PublicDependency[]> {
  return (await db.prepare(`SELECT a.id,coalesce(e.key,a.id) AS address FROM repo_access a
    LEFT JOIN settings_entities e ON e.id=a.id
    LEFT JOIN settings_entities org ON org.key=substr(coalesce(e.key,a.id),1,instr(coalesce(e.key,a.id),'/')-1)
    WHERE ${PUBLIC_GRANT} ORDER BY a.id`).all<PublicDependency>()).results
}

async function publicationInput(env: PublicPageEnv, route: string) {
  const catalog = await publicCatalog(env.DB)
  const facts = await env.DB.batch([
    env.DB.prepare('SELECT id,revision,data FROM repo_listing ORDER BY id'),
    env.DB.prepare('SELECT key,id,archived,deleted_at,moving,description,default_branch FROM settings_entities ORDER BY key'),
    env.DB.prepare('SELECT name,data FROM profiles ORDER BY name'),
    env.DB.prepare('SELECT name,email FROM claims ORDER BY name'),
    env.DB.prepare('SELECT * FROM orgs ORDER BY name'),
    env.DB.prepare('SELECT * FROM org_members ORDER BY org,member'),
    env.DB.prepare('SELECT name,revoked_at FROM agents ORDER BY name'),
    env.DB.prepare('SELECT repo,count(*) AS stars FROM stars GROUP BY repo ORDER BY repo'),
    env.DB.prepare('SELECT id,meta,acl,pending FROM repo_access ORDER BY id'),
    env.DB.prepare('SELECT revision FROM channel_revision WHERE id=1'),
    // Producer input, not a request-time cache workaround. Partial→complete
    // recovery changes the read model and must produce a new SSR document.
    env.DB.prepare('SELECT id,cache_key,data,complete FROM prepared_repository_health ORDER BY id,cache_key'),
  ])
  // Action runs and runner availability move without a Git tip. Their initial
  // view is a cron snapshot; the existing live island supplies subsequent state.
  const address=publicPageRoute(new URL(route,'https://gild.gg'))!
  const orgs=facts[4].results as {name:string}[]
  const liveBucket = /\/actions(?:\/|$)/.test(route) || (!!address.owner && !address.repository && !route.includes('?tab=') && orgs.some(o=>o.name===address.owner)) ? Math.floor(Date.now()/60000) : null
  const states=facts[1].results as {key:string;archived:number}[]
  const banner=states.find(s=>s.key===address.owner)?.archived ? 'This organization is archived. Its repositories are read-only.' : states.find(s=>s.key===address.repository)?.archived ? 'This repository is archived and read-only.' : null
  // Channel publications are immutable at a log cursor + participant generation,
  // not merely a Git tip. Cron/writers resolve those moving inputs before caching.
  let channelInput:unknown=null
  if(address.repository && /\/agents$/.test(address.route) && env.REPO_CHANNEL) {
    const dependency=catalog.find(d=>d.address===address.repository)
    const access=(facts[8].results as {id:string;acl:string}[]).find(a=>a.id===dependency?.id)
    if(dependency && access) {
      const snapshot=await channelFrom(env,dependency.id).snapshot(address.repository,JSON.parse(access.acl))
      // The resolved participants are the page's input. The site-wide
      // channel_revision moves with any token use anywhere, so including it
      // meant a rendered Agents tab was almost never publishable.
      channelInput=[snapshot.page.cursor,snapshot.participants.map(({online,...p})=>p)]
    }
  }
  // A repository page depends on its own prepared health, not every other
  // repository's: background preparation elsewhere must not keep changing
  // this page's input mid-render (the Agents tab never converged).
  const own=address.repository ? catalog.find(d=>d.address===address.repository)?.id : undefined
  const health=(facts[10].results as {id:string}[]).filter(h=>!address.repository || h.id===own)
  const dataInput=await digest(JSON.stringify([siteVersion.hash,catalog,facts.slice(0,9).map(f=>f.results),health,channelInput]))
  return {catalog,banner,dataInput,partsRaw:[catalog,...facts.slice(0,9).map(f=>f.results),health,channelInput,liveBucket],input:await digest(JSON.stringify([deployment.build,route,dataInput,liveBucket]))}
}

/** Producer has no HTTP entry point. It is called only after a write or by
 * cron with an anonymous request and the current server build. */
/** A refused publication says why, so a page stuck Pending can be diagnosed. */
function refused(route: string, reason: string) { console.warn('Public page not published', route, reason); return false }
export async function publishPublicPage(env: PublicPageEnv, route: string,
  render: (request: Request) => Promise<Response>, origin = 'https://gild.gg') {
  const address = publicPageRoute(new URL(route, origin))
  if (!address) return false
  if (contributorPath(new URL(route, origin))) return refused(route, 'contributors only')
  if(address.owner)await ensurePreparedOwnerCatalogue(env.DB,address.owner,Date.now(),env.ARTIFACTS_TOKEN,address.repository?.split('/')[1])
  const { catalog, input, banner, dataInput, partsRaw } = await publicationInput(env,address.route)
  const dependencies = catalog.filter(d => address.repository ? d.address === address.repository
    : !address.owner || d.address.startsWith(address.owner + '/'))
  if (address.repository && !dependencies.length) return refused(route, 'not in the public catalogue')
  const artifact = await env.DB.prepare('SELECT hash FROM public_page_artifacts WHERE input=?').bind(input).first<{hash:string}>()
  let hash = artifact?.hash
  let noStore=hash?(await env.FRAGMENTS.head('pages/'+hash))?.customMetadata?.readCache==='no-store':false
  if (!hash) {
  const response = await render(new Request(new URL(address.route, origin), {
    headers: { 'x-gild-publishing': '1', 'x-gild-publication-input':dataInput, ...(banner?{'x-gild-archive':banner}:{}) },
  }))
  if (response.status !== 200 || response.headers.has('set-cookie')) return refused(route, `render ${response.status}${response.headers.has('set-cookie') ? ' set-cookie' : ''}`)
  const html = await repoTabDocument(await response.text(), new URL(address.route,origin))
  if (html.includes('data-artifact-pending')) return refused(route, 'render still pending')
  if (!html.includes('</html>') || html.includes('id="__next_error__"') || html.includes('<template data-dgst=')) return refused(route, 'incomplete or errored render')
  // Explicit SSR cache intent comes from the shared typed read result, not
  // inferred note text or a second partial score cache.
  noStore=html.includes('name="gild-read-cache" content="no-store"')
  hash = await digest(html)
  // Re-read the primary before publishing: a revoke/rename racing a render
  // must not produce a grant for a page rendered under its old public state.
  const current = await publicationInput(env,address.route)
  if (input !== current.input) {
    const before=partsRaw.map(p=>JSON.stringify(p)), after=current.partsRaw.map(p=>JSON.stringify(p))
    const names=['catalog','repo_listing','settings_entities','profiles','claims','orgs','org_members','agents','stars','repo_access','health','channel','liveBucket']
    const changed=names.filter((_,i)=>before[i]!==after[i])
    return refused(route, 'input changed during render: '+changed.join(', '))
  }
  await env.FRAGMENTS.put('pages/' + hash, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' },customMetadata:noStore?{readCache:'no-store'}:{} })
  await env.DB.prepare('INSERT OR IGNORE INTO public_page_artifacts VALUES (?,?)').bind(input,hash).run()
  // Discover finite query views (PR files/Glance categories and agent dirs)
  // on the producer, never as a side effect of a public read.
  const links = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1].replaceAll('&amp;', '&'))
  const jobs = new Set<string>()
  for (const link of links) {
    const url = new URL(link, origin)
    const next = url.origin === origin && publicPageRoute(url)
    if (next && next.route !== address.route && (next.repository === address.repository && next.owner === address.owner)) jobs.add(next.route)
  }
  if (jobs.size) await env.DB.batch([...jobs].map(route => env.DB.prepare('INSERT OR IGNORE INTO public_page_jobs(route,owner) VALUES (?,?)').bind(route,address.owner)))
  }
  await env.DB.prepare('INSERT INTO public_pages VALUES (?,?,?,?,?,?) ON CONFLICT(route) DO UPDATE SET hash=excluded.hash,input=excluded.input,dependencies=excluded.dependencies,owner=excluded.owner,created_at=excluded.created_at')
    .bind(address.route, hash, input, JSON.stringify(dependencies.map(d=>noStore?{...d,readCache:'no-store'}:d)), address.owner, Date.now()).run()
  return true
}
export async function queuePublicPages(env: PublicPageEnv, repository?: string) {
  const catalog = await publicCatalog(env.DB)
  const routes = new Set(['/', '/explore', '/search', '/new', '/new/org', '/import'])
  const owners = (await env.DB.prepare('SELECT name FROM claims UNION SELECT name FROM orgs').all<{name:string}>()).results.map(o => o.name)
  for (const owner of owners) if (!repository || repository.startsWith(owner + '/'))
    for (const tab of ['', '?tab=repositories', '?tab=people']) routes.add('/' + owner + tab)
  for (const d of catalog) {
    if (repository && repository !== d.address) continue
    const base = '/' + d.address
    // Actions and Agents are contributors-only: never published for anonymous reads.
    for (const tab of ['issues/new','pulls/new','issues','issues?state=closed','issues?claim=none&state=open','pulls','pulls?state=merged','pulls?state=closed','search','import']) routes.add(base + '/' + tab)
  }
  if (repository) await env.DB.prepare('UPDATE public_page_jobs SET updated_at=0 WHERE route LIKE ?').bind('/' + repository + '/%').run()
  await env.DB.batch([...routes].map(route => {
    const address = publicPageRoute(new URL(route,'https://gild.gg'))!
    return env.DB.prepare(repository ? 'INSERT INTO public_page_jobs(route,owner) VALUES (?,?) ON CONFLICT(route) DO UPDATE SET updated_at=0' : 'INSERT OR IGNORE INTO public_page_jobs(route,owner) VALUES (?,?)').bind(address.route,address.owner)
  }))
}
export async function refreshPublicPages(env: PublicPageEnv, render: (request: Request) => Promise<Response>, origin?: string, limit = 20) {
  const rows = (await env.DB.prepare('SELECT route FROM public_page_jobs ORDER BY updated_at,attempts,route LIMIT ?').bind(limit).all<{route:string}>()).results
  for (const { route } of rows) {
    try { await publishPublicPage(env,route,render,origin) }
    catch (error) { console.error('Public page publication failed', route, error) }
    await env.DB.prepare('UPDATE public_page_jobs SET updated_at=?,attempts=attempts+1 WHERE route=?').bind(Date.now(),route).run()
  }
}

export interface PublicPageJob { route:string; origin:string }
export interface PublicPageBindings { PUBLIC_PAGES: Pick<Queue<PublicPageJob>, 'sendBatch'> }
/** Each HTML projection gets its own queue invocation/CPU budget. The cron
 * enumerates durable jobs, rather than rendering a whole forge in one request. */
export async function enqueuePublicPages(env:PublicPageEnv & PublicPageBindings,origin='https://gild.gg',now=Date.now()) {
  const jobs=(await env.DB.prepare('SELECT route FROM public_page_jobs WHERE updated_at<? ORDER BY updated_at,attempts,route LIMIT 100').bind(now-60000).all<{route:string}>()).results
  if(!jobs.length)return
  await env.PUBLIC_PAGES.sendBatch(jobs.map(j=>({body:{route:j.route,origin}})))
  await env.DB.batch(jobs.map(j=>env.DB.prepare('UPDATE public_page_jobs SET updated_at=? WHERE route=?').bind(now,j.route)))
}
