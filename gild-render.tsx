import { renderToString } from 'react-dom/server'
import type { R2Bucket, MessageBatch, Queue } from '@cloudflare/workers-types'
import type { RepoIndex } from './lib/repo-index-do'
import type { RenderJob, RenderItem, RenderData } from './lib/fragments/types'
import {
  fragmentKey,
  digest,
  RENDER_VERSION,
  BROWSER_ASSETS,
  PUBLIC_CACHE,
  ASSET_CACHE,
} from './packages/render/address'
import { BlobView, Tree, Home } from './packages/render/Code'
import { Commit, Score, ChangeGlance } from './packages/render/Commit'
import { Shell, HomeFragment } from './packages/render/Shell'
import { highlight, minified } from './packages/render/highlight'
import { escapeHTML } from './packages/render/context'
import { renderMarkdown } from './lib/markdown'
import assets from 'gild:browser-assets'
import assetManifest from 'gild:asset-manifest'
let shellHTML: string | undefined, shellAddressPromise: Promise<string> | undefined
function shellAddress() {
  shellHTML ??= '<!doctype html>' + renderToString(<Shell version={RENDER_VERSION} />)
  return shellAddressPromise ??= digest(shellHTML).then(hash => RENDER_VERSION + '.' + hash)
}

type RenderIndex = {
  [
    K in
      | 'renderPlan'
      | 'renderData'
      | 'registerFragment'
      | 'fragmentAccess'
      | 'rendererVersion'
      | 'fragmentPointer'
      | 'renderProjection'
      | 'refs'
  ]: (
    ...args: Parameters<RepoIndex[K]>
  ) => Promise<Awaited<ReturnType<RepoIndex[K]>>>
}
export interface RenderEnv {
  FRAGMENTS: R2Bucket
  RENDER_QUEUE: Queue<RenderJob & { cursor?: number }>
  REPO_INDEX: { idFromName(id: string): unknown; get(id: unknown): RenderIndex }
}
async function compressed(content: string | Uint8Array) {
  const bytes =
    typeof content === 'string' ? new TextEncoder().encode(content) : content
  return new Response(
    new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer()
}
export async function fragmentHTML(
  data: Exclude<RenderData, { kind: 'bundle' | 'source' | 'manifest' }>,
  plain = false,
) {
  if (data.kind === 'blob') {
    if (data.text === null)
      return renderToString(
        <BlobView
          note={
            data.binary
              ? 'This is a binary file.'
              : 'This file is too large or minified to highlight.'
          }
        />,
      )
    if (plain || data.bytes > 128 * 1024 || minified(data.text))
      return renderToString(<BlobView html={`<pre class="gild-plain"><code>${escapeHTML(data.text)}</code></pre>`} />)
    if (data.markdown)
      return `<article class="gild-readme">${renderMarkdown(data.text)}</article>`
    return renderToString(
      <BlobView html={await highlight(data.text, data.language)} />,
    )
  }
  if (data.kind === 'tree')
    return renderToString(<Tree entries={data.entries} />)
  if (data.kind === 'home')
    return renderToString(
      <HomeFragment home={data.home} body={<Home home={data.home} />} />,
    )
  if (data.kind === 'score') return renderToString(<Score {...data} />)
  if (data.kind === 'glance')
    return renderToString(<ChangeGlance change={data.change} />)
  return renderToString(<Commit {...data} />)
}
export async function renderItem(
  env: RenderEnv,
  entity: string,
  item: RenderItem,
  validateExisting = false,
) {
  const index = env.REPO_INDEX.get(
      env.REPO_INDEX.idFromName(
        entity.includes('/') ? entity.toLowerCase() : entity,
      ),
    ),
    access = await index.fragmentAccess(),
    key = fragmentKey(item.fragment, access.scope)
  if (await env.FRAGMENTS.head(key)) {
    // Cold legacy reads enqueue this validation rather than doing it while
    // serving the page. Existing bytes alone are not proof of membership.
    if (validateExisting) await index.renderData(item)
    await index.registerFragment(item.fragment)
    return key
  }
  const result = await index.renderData(item)
  // Jobs may cross a committed ACL change. Re-check immediately before put;
  // private data is never published under a public content-hash address.
  if (result.scope !== access.scope)
    throw new Error('Render scope changed; retry')
  const data = result.data
  let body: ArrayBuffer | undefined,
    content: string | Uint8Array = '',
    contentType = 'text/html; charset=utf-8'
  if (data.kind === 'manifest') {
    const treeHTML: Record<string, string> = {}
    if (data.manifest.bundle)
      for (const tree of data.manifest.trees) {
        const key = await renderItem(env, entity, {
            fragment: { kind: 'tree', hash: tree.hash },
            sha: item.sha,
            path: tree.path,
          }),
          object = await env.FRAGMENTS.get(key)
        if (!object) throw new Error('Rendered tree missing')
        treeHTML[tree.hash] = await new Response(
          (object.body as unknown as ReadableStream).pipeThrough(
            new DecompressionStream('gzip'),
          ),
        ).text()
      }
    content = JSON.stringify({ ...data.manifest, treeHTML })
    contentType = 'application/json'
  } else if (data.kind === 'source') {
    content = Buffer.from(data.content, 'base64')
    contentType = data.binary
      ? 'application/octet-stream'
      : 'text/plain; charset=utf-8'
  } else if (data.kind === 'bundle') {
    // Emit one file at a time. Syntax HTML can be much larger than its input;
    // never retain a whole highlighted tip plus its JSON and gzip copies.
    const manifest = data.manifest,
      byBlob = new Map(data.files.map((f) => [f.blob, f.content]))
    async function* chunks() {
      yield '{"manifest":' + JSON.stringify(manifest) + ',"files":['
      let first = true
      for (const file of manifest.files) {
        const source = byBlob.get(file.blob)
        if (source === undefined) continue
        const blobKey = await renderItem(env, entity, {
            fragment: file.fragment,
            path: file.path,
            sha: item.sha,
          }),
          object = await env.FRAGMENTS.get(blobKey)
        if (!object) throw new Error('Rendered blob missing')
        const html = await new Response(
          (object.body as unknown as ReadableStream).pipeThrough(
            new DecompressionStream('gzip'),
          ),
        ).text()
        let readmeHTML: string | undefined
        if (file.readme) {
          const readmeKey = await renderItem(env, entity, {
              fragment: file.readme,
              path: file.path,
              sha: item.sha,
            }),
            readme = await env.FRAGMENTS.get(readmeKey)
          if (!readme) throw new Error('Rendered README missing')
          readmeHTML = await new Response(
            (readme.body as unknown as ReadableStream).pipeThrough(
              new DecompressionStream('gzip'),
            ),
          ).text()
        }
        yield (first ? '' : ',') +
          JSON.stringify({
            path: file.path,
            blob: file.blob,
            content: source,
            html,
            readmeHTML,
          })
        first = false
      }
      yield ']}'
    }
    const iterator = chunks(),
      encoder = new TextEncoder(),
      stream = new ReadableStream<BufferSource>({
        async pull(controller) {
          try {
            const next = await iterator.next()
            if (next.done) controller.close()
            else controller.enqueue(encoder.encode(next.value))
          } catch (error) {
            controller.error(error)
          }
        },
        async cancel() {
          await iterator.return(undefined)
        },
      }).pipeThrough(new CompressionStream('gzip')),
      reader = stream.getReader(),
      parts: Uint8Array[] = []
    let bytes = 0,
      oversized = false
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > 10 * 1024 * 1024) {
        oversized = true
        await reader.cancel()
        break
      }
      parts.push(next.value)
    }
    body = oversized
      ? await compressed(
          JSON.stringify({
            manifest: data.manifest,
            files: [],
            oversized: true,
          }),
        )
      : await new Blob(parts as BlobPart[]).arrayBuffer()
    contentType = 'application/json'
  } else content = await fragmentHTML(data)
  body ??= await compressed(content)
  if ((await index.fragmentAccess()).scope !== access.scope)
    throw new Error('Render scope changed; retry')
  await env.FRAGMENTS.put(key, body, {
    httpMetadata: {
      contentType,
      contentEncoding: 'gzip',
      ...(data.kind === 'source' && data.binary
        ? { contentDisposition: 'attachment' }
        : {}),
    },
  })
  await index.registerFragment(item.fragment)
  return key
}
async function storeAsset(
  env: Pick<RenderEnv, 'FRAGMENTS'>,
  version: string,
  name: string,
) {
  const hashed = /^[a-f0-9]{64}$/.test(version)
  const key = `assets/${version}/${name}`
  if (await env.FRAGMENTS.head(key)) return
  if ((!hashed || assetManifest.urls[name] !== `/gild-fragments/${version}/${name}`) || !assets[name])
    throw new Error('Versioned asset unavailable')
  await env.FRAGMENTS.put(key, assets[name], {
    httpMetadata: {
      contentType: name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.woff2')
        ? 'font/woff2'
        : 'text/javascript; charset=utf-8',
    },
  })
}
export async function renderShell(env: Pick<RenderEnv, 'FRAGMENTS'>, alias?: string) {
  // Compiled asset bytes are part of this deployment. Persist them beside
  // the shell, so Queue jobs need no HTTP assets service and old versions live on.
  for (const name of BROWSER_ASSETS) await storeAsset(env, assetManifest.urls[name].split('/')[2], name)
  const key = fragmentKey({ kind: 'shell', hash: alias ?? await shellAddress() })
  if (!(await env.FRAGMENTS.head(key)))
    await env.FRAGMENTS.put(
      key,
      await compressed(
        shellHTML ?? '<!doctype html>' + renderToString(<Shell version={RENDER_VERSION} />),
      ),
      {
        httpMetadata: {
          contentType: 'text/html; charset=utf-8',
          contentEncoding: 'gzip',
        },
      },
    )
  return key
}
export default {
  async fetch(request: Request, env: RenderEnv) {
    const url = new URL(request.url)
    if (url.pathname === '/asset-manifest' && request.method === 'GET') return Response.json(assetManifest.urls, { headers: { 'cache-control': 'public, max-age=0, must-revalidate' } })
    if (url.pathname.startsWith('/assets/')) {
      const match = url.pathname.match(/^\/assets\/([a-f0-9]{64}|v[1-9][0-9]*)\/([^/]+)$/)
      if (
        !match ||
        !(BROWSER_ASSETS as readonly string[]).includes(match[2]) ||
        !['GET', 'HEAD'].includes(request.method)
      )
        return new Response('Not found', { status: 404 })
      const [, version, name] = match,
        key = `assets/${version}/${name}`
      let object = await env.FRAGMENTS.get(key)
      if (!object && /^[a-f0-9]{64}$/.test(version)) {
        try {
          await storeAsset(env, version, name)
          object = await env.FRAGMENTS.get(key)
        } catch {}
      }
      if (!object) return new Response('Not found', { status: 404 })
      const unchanged = request.headers.get('if-none-match') === object.httpEtag
      return new Response(
        unchanged || request.method === 'HEAD'
          ? null
          : (object.body as unknown as ReadableStream),
        {
          status: unchanged ? 304 : 200,
          headers: {
            'content-type':
              object.httpMetadata?.contentType ?? 'application/octet-stream',
            'cache-control': /^[a-f0-9]{64}$/.test(version) ? ASSET_CACHE : 'public, max-age=3600',
            etag: object.httpEtag,
            'x-content-type-options': 'nosniff',
            'server-timing':
              'assets;desc="stored versioned asset", render;dur=0',
          },
        },
      )
    }
    if (request.method !== 'POST')
      return new Response('Not found', { status: 404 })
    if (url.pathname === '/version') {
      // The minute cron asks for this before moving repositories to a new
      // shell. Store that shell first: a shell-only deploy enqueues no
      // publication, so nothing else would render it and every page would
      // wait on it (Pending).
      const shell = await shellAddress()
      if (!(await env.FRAGMENTS.head(fragmentKey({ kind: 'shell', hash: shell })))) await renderShell(env)
      return Response.json({ version: RENDER_VERSION, shell })
    }
    const body = (await request.json()) as {
      entity: string
      item?: RenderItem
      ref?: string
      path?: string
      page?: string
      sha?: string
      shell?: string
      repository?: string
      jobs?: RenderJob[]
      tip?: number
      cursor?: number
    }
    const { entity, item } = body
    if (url.pathname === '/render' && !item)
      return Response.json({ key: await renderShell(env, body.shell === RENDER_VERSION ? RENDER_VERSION : undefined) }, { headers: { 'cache-control': 'no-store' } })
    const index = env.REPO_INDEX.get(
      env.REPO_INDEX.idFromName(
        entity.includes('/') ? entity.toLowerCase() : entity,
      ),
    )
    if (url.pathname === '/publish' && body.repository) {
      try {
        let jobs = body.jobs
        if (!jobs) {
          await renderShell(env)
          await index.rendererVersion(RENDER_VERSION, false, await shellAddress())
          await index.renderProjection()
          // Verify all current content is stored, including a new renderer
          // version. Immutable hits skip renderData and syntax work.
          const refs = await index.refs()
          const tips = new Set(refs.refs.filter(ref => ref.name !== '_meta').map(ref => ref.hash))
          if (!tips.size) tips.add('empty')
          jobs = [...tips].map(newTip => ({ entity, repository: body.repository!, newTip,
            oldTip: null, meta: refs.meta }))
        }
        const tip = body.tip ?? 0
        const plan = await index.renderPlan(jobs[tip], body.cursor ?? 0)
        // Source bundles are background work, never a Git acknowledgement or
        // first-paint dependency. Each call bounds foreground rendering work.
        for (const item of plan.items)
          if (item.fragment.kind !== 'bundle') await renderItem(env, entity, item)
        const nextTip = plan.cursor === null ? tip + 1 : tip
        if (nextTip < jobs.length)
          return Response.json({ jobs, tip: nextTip, cursor: plan.cursor ?? 0 })
        await index.renderProjection()
        return new Response(null, { status: 204 })
      } catch {
        return new Response('Publication pending', { status: 503 })
      }
    }
    if (url.pathname === '/pointer') {
      // Read the published version. The cron/queue advances it and prepares
      // its projection; a page read must never backfill or score a repository.
      return Response.json(
        await index.fragmentPointer(
          body.ref,
          body.path,
          body.page,
          body.sha,
        ),
      )
    }
    if ((url.pathname === '/plain' || url.pathname === '/validate') && item) {
      try {
        const { data } = await index.renderData(item)
        await index.registerFragment(item.fragment)
        if (url.pathname === '/validate') return new Response(null, { status: 204 })
        if (['bundle', 'source', 'manifest'].includes(data.kind))
          return new Response('Not a presentation fragment', { status: 404 })
        return new Response(await fragmentHTML(data as Exclude<RenderData, { kind: 'bundle' | 'source' | 'manifest' }>, true), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        })
      } catch (error) {
        return new Response(error instanceof Error ? error.message : 'Unavailable', { status: 503 })
      }
    }
    if (
      item &&
      item.fragment.version &&
      item.fragment.version !== RENDER_VERSION
    )
      return new Response('Render version no longer available', { status: 409 })
    try {
      const key = item
        ? await renderItem(env, entity, item)
        : await renderShell(env, body.shell === RENDER_VERSION ? RENDER_VERSION : undefined)
      return Response.json(
        { key },
        {
          headers: {
            'cache-control': 'no-store',
            'server-timing': 'render;desc="gild-render miss"',
          },
        },
      )
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : 'Render failed' },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      )
    }
  },
  async queue(
    batch: MessageBatch<RenderJob & { cursor?: number }>,
    env: RenderEnv,
  ) {
    try {
      await renderShell(env)
    } catch (error) {
      console.error(
        'gild-render shell preparation failed',
        error instanceof Error ? error.message : String(error),
      )
      throw error
    }
    for (const message of batch.messages) {
      try {
        const job = message.body,
          index = env.REPO_INDEX.get(
            env.REPO_INDEX.idFromName(
              job.entity.includes('/') ? job.entity.toLowerCase() : job.entity,
            ),
          ),
          version = await index.rendererVersion(RENDER_VERSION, false, await shellAddress()),
          plan = job.item ? { items: [job.item], cursor: null } : await index.renderPlan(job, job.cursor ?? 0)
        void version
        let failure = false
        for (const item of plan.items)
          try {
            await renderItem(env, job.entity, item, !!job.item)
          } catch (error) {
            console.error(
              'gild-render fragment retry',
              item.fragment.kind,
              item.fragment.hash,
              error instanceof Error ? error.message : 'Render failed',
            )
            failure = true
          }
        const complete = await index.renderProjection()
        if (failure || !complete) {
          message.retry({ delaySeconds: 30 })
          continue
        }
        if (plan.cursor !== null)
          await env.RENDER_QUEUE.send({ ...job, cursor: plan.cursor })
        message.ack()
      } catch {
        console.error(
          'gild-render job retry',
          message.body.repository,
          message.body.newTip,
          message.body.cursor ?? 0,
        )
        // Successful immutable puts survive retries. Never ack partial batches.
        message.retry({ delaySeconds: 30 })
      }
    }
  },
}
