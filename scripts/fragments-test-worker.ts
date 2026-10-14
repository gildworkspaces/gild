import { publicIslandsHTTP } from '../lib/fragments/islands'
export { ApiControl } from '../lib/api/control-do'
import { invalidatePublicReads } from '../lib/fragments/edge'
import { preparePush } from '../lib/git-push-budget'
import { ApiError } from '../lib/api/errors'
import { verifySessionCookie } from '../lib/session-cookie'
import { rendererShell } from '../lib/status-pages'
import { syncRendererVersion } from '../lib/fragments/version'
import { sweepFragments } from '../lib/fragments/sweep'
import { RepoIndex } from '../lib/repo-index-do'
import { describeBlob } from '../lib/repo-indexer'
import { fragmentHTTP, pointerHTTP, browseHTTP } from '../lib/fragments/http'
import { fragmentReads } from '../lib/fragments/production'
import { d1Store } from '../lib/drivers/d1'
import core from '../cqx/core.wasm'
import type { RenderJob } from '../lib/fragments/types'
globalThis.__cqxWasm = core

export class FragmentIndex extends RepoIndex {
  async pageViewProbe(build = false) {
    await this.seed(1)
    let pending = false
    try { await this.pageChange('commit', '1'.repeat(40)) }
    catch(error) { pending = error instanceof ApiError && error.status === 503 }
    const cold = this.index.view('page-change:v1:commit:parent:' + '1'.repeat(40))
    if (build) await this.preparePageChanges()
    const warm = build ? await this.pageChange('commit', '1'.repeat(40)) : null
    return { pending, cold, warm }
  }
  async reviewRefs(mode: string) {
    this.index.setting('fixture:projection-retry','1')
    if (mode === 'start') {
      await this.seed(1)
      this.index.publish([{name:'main',kind:'branch',hash:'1'.repeat(40)},{name:'flaky',kind:'branch',hash:'1'.repeat(40)}],'main',this.index.setting('meta'))
      await this.renderWork()
      await this.seed(2,false,false)
      this.index.putCommit({hash:'8'.repeat(40),tree:'7'.repeat(40),parents:[],author_name:'Fixture',author_email:'fixture@example.test',time:0,message:'missing snapshot'})
      this.index.publish([{name:'main',kind:'branch',hash:'2'.repeat(40)},{name:'flaky',kind:'branch',hash:'2'.repeat(40)},{name:'missing',kind:'branch',hash:'8'.repeat(40)}],'main',this.index.setting('meta'))
      this.index.setting('fixture:flaky','1')
    } else {
      this.index.setting('fixture:flaky','')
      this.index.publish([{name:'main',kind:'branch',hash:'2'.repeat(40)},{name:'flaky',kind:'branch',hash:'2'.repeat(40)}],'main',this.index.setting('meta'))
    }
    const complete = mode === 'start' ? await this.renderWork() : false
    return {complete,alarm:await this.ctx.storage.getAlarm()}
  }
  /** A pending hydration wake (+250ms) must survive an incomplete render's backoff (>=1s). */
  async hydrationWake() {
    const soon = Date.now() + 250
    await this.ctx.storage.setAlarm(soon)
    const complete = await this.renderWork()
    return {complete,soon,alarm:await this.ctx.storage.getAlarm()}
  }
  async fragmentPointer(...args: Parameters<RepoIndex['fragmentPointer']>) {
    if (args[0] === 'flaky' && this.index.setting('fixture:flaky')) throw new ApiError(503,'Metadata is indexing')
    return super.fragmentPointer(...args)
  }
  async pauseRenderAlarm() { this.index.setting('fixture:hold-alarm','1'); await this.ctx.storage.deleteAlarm() }
  async alarm() {
    if (this.index.setting('fixture:hold-alarm')) return
    if (this.index.setting('fixture:projection-retry')) { await this.renderWork(); return }
    return super.alarm()
  }
  async seedLua(source: string, owner = 'avatest', repo = 'lua', project = true) {
    this.address(owner,repo)
    const tip = (project ? 'a' : 'f').repeat(40), tree = (project ? 'b' : 'e').repeat(40), blob = (project ? 'c' : 'd').repeat(40)
    this.index.putBlob(describeBlob(blob, new TextEncoder().encode(source), 'lvm.c'))
    this.index.putTree(tree, [{ name: 'lvm.c', type: 'blob', child: blob, mode: '100644' }])
    this.index.putCommit({ hash: tip, tree, parents: [], author_name: 'Lua', author_email: 'fixture@example.test',
      committer_name: 'Lua', committer_email: 'fixture@example.test', time: 1791392400, committer_time: 1791392400, message: 'Lua benchmark' })
    this.index.publish([{ name: 'main', kind: 'branch', hash: tip }], 'main', null)
    await d1Store(this.env.DB).publishRepoAccess(`${owner}/${repo}`, null, {})
    if (project) await this.renderWork()
    return project ? this.fragmentPointer() : null
  }
  async seed(version: number, privateRepo = false, project = true) {
    this.address('acme', 'demo')
    const tip = String(version).repeat(40),
      tree = String(version + 3).repeat(40),
      sub = String(version + 6).repeat(40),
      meta = String(version + (privateRepo ? 30 : 10))
        .padStart(40, 'a')
        .slice(-40)
    const files = Array.from({ length: 20 }, (_, i) => ({
      hash: (i === 0 ? String(version) : 'b') + String(i).padStart(39, '0'),
      name: `file${i}.ts`,
      text:
        `export const value${i} = ${i === 0 ? version : i}\n` +
        (i === 19
          ? 'export const template = "__GILD_REF__ __GILD_PATH__ __GILD_DIR__ __GILD_REF_LABEL__"\n'
          : ''),
    }))
    for (const file of files)
      this.index.putBlob(
        describeBlob(file.hash, new TextEncoder().encode(file.text), file.name),
      )
    const readme = 'c'.repeat(40)
    this.index.putBlob(
      describeBlob(
        readme,
        new TextEncoder().encode(
          '# Fixture\nA repository README with [a link](?path=src%2Ffile0.ts).\n',
        ),
        'README.md',
      ),
    )
    this.index.putTree(
      sub,
      files.map((f) => ({
        name: f.name,
        type: 'blob',
        child: f.hash,
        mode: '100644',
      })),
    )
    this.index.putBlob(
      describeBlob('9'.repeat(40), new Uint8Array([0, 1, 2, 255]), 'image.bin'),
    )
    this.index.putTree(tree, [
      { name: 'src', type: 'tree', child: sub, mode: '040000' },
      { name: 'README.md', type: 'blob', child: readme, mode: '100644' },
      {
        name: 'image.bin',
        type: 'blob',
        child: '9'.repeat(40),
        mode: '100644',
      },
    ])
    const acl = 'd'.repeat(38) + (privateRepo ? 'a' : 'b') + version,
      indexFile = 'e'.repeat(39) + version,
      metaTree = 'f'.repeat(38) + (privateRepo ? 'a' : 'b') + version,
      gildTree = 'a'.repeat(38) + (privateRepo ? 'a' : 'b') + version
    this.index.putBlob(
      describeBlob(
        acl,
        new TextEncoder().encode(
          JSON.stringify({ private: privateRepo, read: ['@reader'] }),
        ),
        'acl.json',
      ),
    )
    this.index.putBlob(
      describeBlob(
        indexFile,
        new TextEncoder().encode('{"issues":[],"pulls":[]}'),
        'index.json',
      ),
    )
    this.index.putTree(gildTree, [
      { name: 'acl.json', type: 'blob', child: acl, mode: '100644' },
      { name: 'index.json', type: 'blob', child: indexFile, mode: '100644' },
    ])
    this.index.putTree(metaTree, [
      { name: '.gild', type: 'tree', child: gildTree, mode: '040000' },
    ])
    this.index.putCommit({
      hash: meta,
      tree: metaTree,
      parents: [],
      author_name: 'Fixture',
      author_email: 'fixture@example.test',
      time: 1791392400,
      message: 'Metadata',
      committer_name: 'Fixture',
      committer_email: 'fixture@example.test',
      committer_time: 1791392400,
    })
    const parent = version > 1 ? String(version - 1).repeat(40) : null
    this.index.putCommit({
      hash: tip,
      tree,
      parents: parent ? [parent] : [],
      author_name: 'Fixture',
      author_email: 'fixture@example.test',
      time: 1791392400,
      message: `Fixture commit ${version}`,
      committer_name: 'Fixture',
      committer_email: 'fixture@example.test',
      committer_time: 1791392400,
    })
    await d1Store(this.env.DB).fenceRepoAccess('acme/demo',meta)
    this.index.publish(
      [{ name: 'main', kind: 'branch', hash: tip }],
      'main',
      meta,
    )
    this.index.setting('repo-list:acl', '')
    this.index.setting('fragments:pending-refs', '{}')
    // The actual index completion publication, including its real Queue send.
    if (project) await this.renderWork()
    return project ? this.fragmentPointer() : null
  }
  async seedEmpty() {
    this.address('acme', 'demo')
    await d1Store(this.env.DB).fenceRepoAccess('acme/demo',null)
    this.index.publish([], 'main', null)
    await d1Store(this.env.DB).publishRepoAccess('acme/demo',null,{})
    this.index.setting('repo-list:acl', '')
    this.index.setting('fragments:pending-refs', '{}')
    await this.renderWork()
    return this.fragmentPointer()
  }
  pendingPush(sha: string) {
    return this.recordPush(
      'fixture-push',
      [{ ref: 'refs/heads/main', before: '1'.repeat(40), sha }],
      'fixture',
    )
  }
  async tagOldTip() {
    this.index.publish([
      { name: 'main', kind: 'branch', hash: '2'.repeat(40) },
      { name: 'stable', kind: 'tag', hash: '1'.repeat(40) },
      { name: 'main', kind: 'tag', hash: '1'.repeat(40) },
    ], 'main', this.index.setting('meta'))
    await this.renderWork()
    return this.fragmentPointer('stable', 'src/file0.ts')
  }
  async pendingAcl() {
    await d1Store(this.env.DB).fenceRepoAccess('acme/demo','new-meta')
    await this.listingAcl('new-meta', { private: true })
  }
  protected connection() {
    return Promise.reject(new Error('Fragment reads must never call git'))
  }
}
const heldRenders: RenderJob[] = []
export default {
  async fetch(
    request: Request,
    env: Record<string, unknown>,
    ctx: { waitUntil(work: Promise<unknown>): void },
  ) {
    const url = new URL(request.url),
      ns = env.REPO_INDEX as {
        idFromName(s: string): unknown
        get(id: unknown): FragmentIndex
      },
      index = ns.get(ns.idFromName('acme/demo'))
    if (url.pathname === '/__release-render') {
      const jobs = heldRenders.splice(0)
      for (const job of jobs) await (env.RENDER_QUEUE as { send(job: RenderJob): Promise<void> }).send(job)
      return new Response('ok')
    }
    if (url.pathname === '/__page-view-probe') return Response.json(await index.pageViewProbe(url.searchParams.has('build')))
    if (url.pathname === '/__exhaust-history') {
      const ns = env.API_CONTROL as any, limiter = ns.get(ns.idFromName('history-render:acme/demo:ip:192.0.2.199'))
      for(let i=0;i<120;i++) await limiter.rate(Date.now(),120)
      return new Response('ok')
    }
    if (url.pathname === '/__hydration-wake') return Response.json(await index.hydrationWake())
    if (url.pathname === '/__review-refs') return Response.json(await index.reviewRefs(url.searchParams.get('mode') ?? 'start'))
    if (url.pathname === '/__pause-render-alarm') {await index.pauseRenderAlarm();return new Response('ok')}
    if (url.pathname === '/__pack') {
      let staged: Awaited<ReturnType<typeof preparePush>> | undefined
      try {
        staged = await preparePush(env.FRAGMENTS as never,request.body!,async () => {throw new Error('Unexpected thin base')})
        const object = await (env.FRAGMENTS as any).get(staged.key)
        const replay = await new Response(object.body).arrayBuffer()
        return Response.json({objects:staged.objects,bytes:replay.byteLength})
      } catch(error) {return new Response(String(error),{status:(error as any).status ?? 500})}
      finally {await staged?.cleanup()}
    }
    if (url.pathname === '/__seed') {
      await invalidatePublicReads(url.origin)
      const st = d1Store(env.DB as never)
      // D1 stable identity lookup is the production one, not a stub catalog.
      await st.settings.state('acme/demo')
      return Response.json(
        await index.seed(
          Number(url.searchParams.get('version') ?? 1),
          url.searchParams.has('private'),
        ),
      )
    }
    if (url.pathname === '/__empty')
      return Response.json(await index.seedEmpty())
    if (url.pathname === '/__legacy') return Response.json(await ns.get(ns.idFromName('legacy/repo')).seedLua('export const legacy = true','legacy','repo',false))
    if (url.pathname === '/__lua') return Response.json(await ns.get(ns.idFromName('avatest/lua')).seedLua(String(env.LUA_SOURCE)))
    if (url.pathname === '/__pending') {
      await index.pendingPush('9'.repeat(40))
      return Response.json({ ok: true })
    }
    if (url.pathname === '/__pending-pointer') {
      try { return Response.json(await index.fragmentPointer()) } catch { return new Response('New tip is indexing', { status: 503 }) }
    }
    if (url.pathname === '/__tag') return Response.json(await index.tagOldTip())
    if (url.pathname === '/__acl') {
      await invalidatePublicReads(url.origin)
      await index.pendingAcl()
      return Response.json({ ok: true })
    }
    if (url.pathname === '/__status-shell') return new Response(await rendererShell(env as never))
    if (url.pathname === '/__health') return new Response('ok')
    if (url.pathname === '/__sync') { await syncRendererVersion(env as never); return new Response('ok') }
    if (url.pathname === '/__sweep') return Response.json(await sweepFragments(env as never,
      url.origin, Number(url.searchParams.get('now')) || Date.now()))
    if (url.pathname === '/api/repos/acme/demo/islands' && !url.searchParams.has('lease'))
      return Response.json({
        name:
          (
            await verifySessionCookie(
              request.headers.get('cookie')?.match(/gild_session=([^;]+)/)?.[1],
              env.SESSION_SECRET as string,
            )
          )?.name ?? null,
        count: 0,
        starred: false,
        write: false,
      })
    if (url.pathname.startsWith('/gild-fragments/')) {
      url.pathname = url.pathname === '/gild-fragments/manifest.json' ? '/asset-manifest' : '/assets' + url.pathname.slice('/gild-fragments'.length)
      return (
        env.GILD_RENDER as { fetch(r: Request): Promise<Response> }
      ).fetch(new Request(url, request))
    }
    const counts = { do: 0, d1: 0, r2: 0, render: 0 }
    const wrapped = {
      ...env,
      DB: new Proxy(env.DB as object, {
        get(target, key) {
          const v = Reflect.get(target, key)
          if (key === 'prepare')
            return (...args: unknown[]) => {
              counts.d1++
              return Reflect.apply(v, target, args)
            }
          return typeof v === 'function' ? v.bind(target) : v
        },
      }),
      REPO_INDEX: {
        idFromName: (s: string) => ns.idFromName(s),
        get: (id: unknown) =>
          new Proxy(ns.get(id), {
            get(target, key) {
              const v = Reflect.get(target, key)
              return typeof v === 'function'
                ? (...args: unknown[]) => {
                    counts.do++
                    return Reflect.apply(v, target, args)
                  }
                : v
            },
          }),
      },
      FRAGMENTS: new Proxy(env.FRAGMENTS as object, {
        get(target, key) {
          const v = Reflect.get(target, key)
          return typeof v === 'function'
            ? (...args: unknown[]) => {
                if (['get','head','put','delete','list'].includes(String(key))) counts.r2++
                return Reflect.apply(v, target, args)
              }
            : v
        },
      }),
      RENDER_QUEUE: { send: async (job: RenderJob) => {
        if (request.headers.has('x-fixture-hold-render')) { heldRenders.push(job); return }
        await (env.RENDER_QUEUE as { send(job: RenderJob): Promise<void> }).send(job)
      } },
      GILD_RENDER: {
        fetch: (...args: unknown[]) => {
          if (new URL(String(args[0])).pathname === '/pointer') counts.do++
          else counts.render++
          if (new URL(String(args[0])).pathname === '/render') {
            if (request.headers.get('x-fixture-render') === 'fail')
              return Promise.resolve(new Response('retry shortly', { status: 503 }))
            if (request.headers.get('x-fixture-render') === 'late') {
              ctx.waitUntil(new Promise(resolve => setTimeout(resolve, 100)).then(() =>
                Reflect.apply((env.GILD_RENDER as { fetch: Function }).fetch, env.GILD_RENDER, args)))
              return Promise.resolve(new Response('retry shortly', { status: 503 }))
            }
          }
          return Reflect.apply(
            (env.GILD_RENDER as { fetch: Function }).fetch,
            env.GILD_RENDER,
            args,
          )
        },
      },
    }
    const started = performance.now()
    try {
      const reads = fragmentReads(wrapped as never, url.searchParams.has('lease') ? ctx : undefined, () => request.headers.has('x-fixture-now') ? Number(request.headers.get('x-fixture-now')) : Date.now())
      const response =
        (await publicIslandsHTTP(request, reads, ctx, async () => Response.json({ name: null,
          count: await d1Store(wrapped.DB as never).starCount('acme/demo'), starred: false, write: false }),
          () => request.headers.has('x-fixture-now') ? Number(request.headers.get('x-fixture-now')) : Date.now())) ??
        (await fragmentHTTP(
          request,
          wrapped as never,
          reads,
          url.searchParams.has('edge') ? ctx : undefined,
        )) ??
        (await pointerHTTP(request, reads)) ??
        (await browseHTTP(request, wrapped as never, reads, ctx, true)) ??
        (await browseHTTP(request, wrapped as never, reads, ctx)) ??
        new Response('Not found', { status: 404 })
      const out = new Response(response.body, {
        status: response.status,
        headers: response.headers,
        ...{ encodeBody: 'manual' },
      })
      out.headers.set('x-fixture-calls', JSON.stringify(counts))
      out.headers.set('x-fixture-worker-invocations', '1')
      out.headers.set('x-fixture-ms', String(performance.now() - started))
      return out
    } catch (error) {
      return new Response(
        error instanceof Error ? error.message : String(error),
        { status: 503, headers: { 'x-fixture-calls': JSON.stringify(counts) } },
      )
    }
  },
}
