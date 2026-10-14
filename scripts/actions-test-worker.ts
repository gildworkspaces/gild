import { dispatch as dispatchAPI } from '../lib/api/dispatch'
import { actionHandler } from '../lib/api/actions'
import { ApiControl } from '../lib/api/control-do'
export { ApiControl }
// Local-only entry. Same handler, token verifier, workflow loader, SQLite DO,
// masking/encryption and git archive as production; only Artifacts transport
// is replaced by the disposable local git server. Never shipped by worker.ts.
import type { D1Database } from '@cloudflare/workers-types'
import { RunQueue } from '../lib/actions/queue-do'
import { snapshotSource } from '../lib/repo-index-source'
import { actionsAPI } from '../lib/actions/handler'
import { verifyStoredToken, hashToken } from '../lib/token-verifier'
import { d1Store } from '../lib/drivers/d1'
import type { Event } from '../lib/actions/workflow'
export class TestRunQueue extends RunQueue {
  protected async connection() {
    return { url: this.runs.setting('fixture-url')!, token: '' }
  }
  protected async repositorySource(sha: string) {
    const c = await this.connection()
    return snapshotSource(c.url, sha)
  }
  protected async source(sha: string) {
    if (this.runs.setting('paused') === '1') throw new Error('fixture pause')
    return super.source(sha)
  }
  expireLogs(run: number) {
    this.ctx.storage.sql.exec(
      'DELETE FROM action_logs WHERE job IN (SELECT id FROM action_jobs WHERE run=?)',
      run,
    )
  }
  async pause(value: string) {
    this.runs.setting('paused', value)
  }
  fixtureSha(sha?: string) {
    return this.runs.setting('fixture-sha', sha)!
  }
  fixtureUrl() {
    return this.runs.setting('fixture-url')!
  }
  async fixture(url: string) {
    await this.init('acme', 'demo')
    this.runs.setting('fixture-url', url)
  }
  async drain() {
    await this.alarm()
    return this.overview()
  }
  async expired() {
    this.runs.sweep(Date.now() + 120_000)
    return this.overview()
  }
  async workflow(sha: string) {
    const { loadWorkflows } = await import('../lib/actions/source'),
      start = performance.now()
    const cache = this.cacheWorkflows(sha),
      workflows = cache ?? (await loadWorkflows(await this.source(sha), sha))
    if (!cache) this.cacheWorkflows(sha, workflows)
    return { workflows, cached: Boolean(cache), ms: performance.now() - start }
  }
}
type Stub = {
  [K in
    | 'expireLogs'
    | 'pause'
    | 'apiRuns'
    | 'apiJob'
    | 'commitRuns'
    | 'fixture'
    | 'fixtureSha'
    | 'enqueue'
    | 'fixtureUrl'
    | 'deliver'
    | 'overview'
    | 'drain'
    | 'expired'
    | 'workflow'
    | 'readRepo'
    | 'init'
    | 'register'
    | 'poll'
    | 'detail'
    | 'logs'
    | 'append'
    | 'step'
    | 'finish'
    | 'heartbeat'
    | 'remove'
    | 'cancel'
    | 'rerun'
    | 'required'
    | 'gate']: (
    ...args: Parameters<TestRunQueue[K]>
  ) => Promise<Awaited<ReturnType<TestRunQueue[K]>>>
}
interface Env {
  RUN_QUEUE: { idFromName(name: string): unknown; get(id: unknown): Stub }
  API_CONTROL: {idFromName(name:string):unknown;get(id:unknown):ApiControl}
  DB: D1Database
  ACTIONS_SECRET_KEY: string
}
export default {
  async fetch(request: Request, env: Env) {
    const u = new URL(request.url),
      q = env.RUN_QUEUE.get(env.RUN_QUEUE.idFromName('acme/demo'))
    if (u.pathname === '/fixture' && request.method === 'POST') {
      const b = (await request.json()) as {
        url: string
        token: string
        event: Event
        access: { meta: string; acl: Record<string, unknown> }
      }
      await q.fixture(b.url)
      const st = d1Store(env.DB), state = await st.settings.state('acme/demo')
      // Publish the ACL read from the fixture metadata commit, through the same
      // D1 publication driver used in production. Runner reads keep their fence.
      await st.publishRepoAccess(state.id, b.access.meta, b.access.acl)
      await q.fixtureSha(b.event.sha)
      await d1Store(env.DB).saveApiToken(
        await hashToken(b.token),
        'acme',
        'local-fixture',
        Date.now() + 3600_000,
      )
      await q.deliver(b.event)
      return Response.json(await q.overview())
    }
    if (u.pathname === '/drain') return Response.json(await q.drain())
    if (u.pathname === '/expire-logs') {
      await q.expireLogs(Number(u.searchParams.get('run')))
      return Response.json({ ok: true })
    }
    if (u.pathname === '/gate')
      return Response.json(await q.gate(u.searchParams.get('sha')!))
    if (u.pathname === '/expired') return Response.json(await q.expired())
    if (u.pathname === '/workflow')
      return Response.json(await q.workflow(u.searchParams.get('sha')!))
    if (u.pathname === '/pause') {
      await q.pause(u.searchParams.get('value') ?? '0')
      return Response.json({ ok: true })
    }
    if (u.pathname === '/deliver-fixture' && request.method === 'POST') {
      await q.deliver((await request.json()) as Event)
      return Response.json({ ok: true })
    }
    if (u.pathname === '/dispatch-fixture' && request.method === 'POST') {
      const event = (await request.json()) as Event
      await q.deliver(event)
      await q.drain()
      return Response.json(await q.overview())
    }
    if (u.pathname.startsWith('/acme/demo.git/')) {
      const token =
        request.headers.get('authorization')?.replace(/^Bearer /i, '') ?? ''
      if (token.startsWith('gr_'))
        try {
          await q.readRepo(token)
        } catch {
          return new Response('runner token invalid', { status: 401 })
        }
      if (
        request.method !== 'GET' &&
        request.headers.get('content-type')?.includes('json')
      )
        return new Response('invalid git body', { status: 400 })
      const fixture = await env.RUN_QUEUE.get(
        env.RUN_QUEUE.idFromName('acme/demo'),
      ).fixtureUrl()
      const suffix = u.pathname.slice('/acme/demo.git'.length) + u.search
      return fetch(fixture + suffix, {
        method: request.method,
        headers: request.headers,
        body: request.method === 'GET' ? undefined : request.body,
      })
    }
    if(u.pathname.startsWith('/api/v1/')) {
      const execute=actionHandler({runQueue:async()=>q as never,mayWrite:async(_o,by)=>by==='acme',dispatch:async()=>{throw new Error('Use the dispatch fixture')}})
      return dispatchAPI(request,{authorize:async()=>{},execute,control:async id=>env.API_CONTROL.get(env.API_CONTROL.idFromName(id)),authenticate:async r=>{
        const token=r.headers.get('authorization')?.replace(/^Bearer /i,'') ?? ''
        if(token.startsWith('gr_')) {try {await q.readRepo(token);return {id:await hashToken(token),name:'runner',publicKey:'',scopes:['actions'],repos:['acme/demo']}}catch{return null}}
        const t=await verifyStoredToken(token,d1Store(env.DB));return t?.name ? {id:await hashToken(token),name:t.name,publicKey:t.publicKey,scopes:t.scopes,repos:t.repos} : null
      }})
    }
    const prefix = '/api/repos/acme/demo/actions'
    if (!u.pathname.startsWith(prefix))
      return new Response('not found', { status: 404 })
    const caller = async (r: Request) =>
      (
        await verifyStoredToken(
          r.headers.get('authorization')?.replace(/^Bearer /i, '') ?? '',
          d1Store(env.DB),
        )
      )?.name ?? null
    return actionsAPI(
      request,
      {
        owner: 'acme',
        repo: 'demo',
        path: u.pathname.slice(prefix.length).split('/').filter(Boolean),
      },
      {
        caller,
        capabilities: async (_o, _r, by) => ({
          name: by,
          writer: by === 'acme',
          grants: new Set(
            by === 'acme' ? (['pr', 'queue', 'review'] as const) : [],
          ),
        }),
        mayWrite: async (_o, by) => by === 'acme',
        runQueue: async () => q as never,
        actionEnv: async () => env,
        dispatch: async (_owner, _repo, file, ref, actor) => {
          if (ref !== 'main') throw new Error('fixture has only a main branch')
          const sha = await q.fixtureSha(),
            workflow = (await q.workflow(sha)).workflows.find(
              (w) => w.file === file,
            )
          if (!workflow?.triggers.workflow_dispatch)
            throw new Error('workflow_dispatch required')
          return q.enqueue(workflow, {
            name: 'workflow_dispatch',
            ref: 'refs/heads/main',
            sha,
            actor,
            title: 'Manual fixture run',
            repository: 'acme/demo',
            key: crypto.randomUUID(),
          })
        },
      },
    )
  },
}
