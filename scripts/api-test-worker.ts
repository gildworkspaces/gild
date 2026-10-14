import {PreparedConversations} from '../lib/prepared-conversations'
import {PreparedRepositoryContent} from '../lib/prepared-repository-content'
import { channelHandler } from '../lib/channel/service'
export { RepoChannel } from '../lib/channel/do'
import { apiImports,authorizeImport } from '../lib/api/imports'
import { importJob } from '../lib/import/service'
export { RepoImport } from '../lib/import/do'
import { privacyFixture } from './privacy-fixture'
import { apiRunners } from '../lib/api/runners'
import { runnerPool } from '../lib/actions/pool-service'
export { RunnerPool } from '../lib/actions/pool-do'
import { mayRead } from '../lib/repo-read'
import { eventRepositories } from '../lib/events/repositories'
import { consumeWebhooks } from '../lib/events/consumer'
import { ApiError } from '../lib/api/errors'
import {PreparedReadModels} from '../lib/prepared-read-models'
import {publishPreparedCatalogue} from '../lib/prepared-catalogue-producer'
import { eventHandler } from '../lib/api/events'
import { hubFrom } from '../lib/events/binding'
import { ForgeEvents } from '../lib/events/hub-do'
import { publicDestination } from '../lib/events/security'
export class TestForgeEvents extends ForgeEvents {
  drainChannel() { return this.flushChannel() }
  privacyHookAccess(viewer:string,scope:string,repository:string) {
    return this.creatorAccess({creator:viewer,scope} as any,repository)
  }
  async fixture(receiver: string) {
    await this.ctx.storage.put('receiver', receiver)
  }
  protected async send(
    url: string,
    headers: Record<string, string>,
    body: string,
  ) {
    await publicDestination(
      url,
      async () => ['9.9.9.9'],
      AbortSignal.timeout(10000),
    )
    const target = await this.ctx.storage.get<string>('receiver')
    if (!target) throw Error('No test receiver')
    const response = await fetch(target + new URL(url).pathname, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    })
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: (await response.text()).slice(0, 8192),
      truncated: false,
    }
  }
}
import { changeIssue } from '../lib/issues'
import { dequeuePull } from '../lib/pulls'
import { setAgentGrants } from '../lib/access'
import { orchestratorHandler } from '../lib/orchestrators'
import { createRepository } from '../lib/repos-write'
// Real v1 dispatcher, service, token verifier, writes and index; only external
// Artifacts/Next bindings use the disposable local-git transport adapter.
import {
  configure,
  store,
  readyIndex,
  repoIndex,
  type Env,
} from './api-fixture/runtime'
import { TestRepoIndex } from './index-test-worker'
import { TestRunQueue } from './actions-test-worker'
import { ApiControl } from '../lib/api/control-do'
import { dispatch, match } from '../lib/api/dispatch'
import { service } from '../lib/api/service'
import { verifyStoredToken, hashToken, denySuspended } from '../lib/token-verifier'
import { createToken } from '../lib/tokens'
import {
  createIssueRecord,
  updateItem,
  addInlineComment,
} from '../lib/api/metadata'
import { addComment } from '../lib/issues'
import {
  createPull,
  commentOnPull,
  reviewPull,
  enqueueAndDrain,
} from '../lib/pulls'
import { fileRequest, decide } from '../lib/agentRequests'
import { actionHandler } from '../lib/api/actions'
import { caller } from '../lib/access'
import { mayWrite } from '../lib/access'
import { runQueue, dispatch as dispatchWorkflow } from '../lib/actions/service'
export class TestApiControl extends ApiControl {
  exhaust() {
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO rate VALUES (?,?)',
      Math.floor(Date.now() / 3600000),
      10000,
    )
  }
}
export { TestRepoIndex, TestRunQueue }
export default {
  async queue(
    batch: import('@cloudflare/workers-types').MessageBatch<{
      delivery: string
    }>,
    env: Env,
  ) {
    await consumeWebhooks(batch, env)
  },
  async fetch(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    configure(env, undefined, ctx)
    if((env as any).PRIVACY_FIXTURE && !new URL(request.url).pathname.endsWith('-fixture') && !['/fixture','/drain-index','/drain'].includes(new URL(request.url).pathname))
      return privacyFixture(request,env,r=>fixtureFetch(r,env))
    return fixtureFetch(request,env)
  },
}
let channelUI = ''
async function fixtureFetch(request: Request, env: Env) {
    if (new URL(request.url).pathname==='/channel-ui-fixture') {channelUI=((await request.json()) as {url:string}).url;return Response.json({ok:true})}
    if (new URL(request.url).pathname.startsWith('/channel-browser')) return fetch(channelUI+new URL(request.url).pathname.replace('/channel-browser','')+new URL(request.url).search,{headers:{authorization:request.headers.get('authorization') ?? ''}})

    configure(env)
    const url = new URL(request.url),
      index = env.REPO_INDEX.get(
        env.REPO_INDEX.idFromName('acme/demo'),
      ) as unknown as TestRepoIndex,
      q = env.RUN_QUEUE.get(
        env.RUN_QUEUE.idFromName('acme/demo'),
      ) as unknown as TestRunQueue,
      st = await store()
    if(url.pathname==='/prepared-conversation-fixture'&&request.method==='POST')return Response.json(await index.preparedConversationFixture())
    if(url.pathname==='/prepared-conversation-pending-fixture'&&request.method==='POST'){await env.DB.prepare('DELETE FROM prepared_conversation_receipts').run();return Response.json({ok:true})}
    if(url.pathname==='/prepared-content-legacy-fixture'&&request.method==='POST'){
      await env.DB.exec('DELETE FROM prepared_content_snapshots;DELETE FROM prepared_content_blobs;')
      return Response.json(await index.legacyContentFixture())
    }
    if(url.pathname==='/prepared-content-fixture'&&request.method==='POST')return Response.json(await index.preparedContentFixture())
    if(url.pathname==='/prepared-content-pending-fixture'&&request.method==='POST'){
      await env.DB.prepare('DELETE FROM prepared_content_snapshots').run();return Response.json({ok:true})
    }
    if(url.pathname==='/prepared-pagination-fixture'&&request.method==='POST')return Response.json(await index.preparedPaginationFixture())
    if(url.pathname==='/prepared-reads-fixture'&&request.method==='POST') {
      const b=await request.json() as {pending?:boolean;health?:boolean;diffs?:boolean}
      if(b.pending)await env.DB.prepare('DELETE FROM prepared_catalogues WHERE owner=?').bind('acme').run()
      else {
        // Observe the actual seeded disposable catalogue outside the GET path.
        // Do not certify an empty owner whose Git fixture contains demo.
        const {listReposFor}=await import('./api-fixture/runtime')
        const rows=[]
        for(const repo of await listReposFor()){
          const state=await st.settings.state('acme/'+repo.name)
          rows.push({name:repo.name,id:state.id,description:repo.description,
            defaultBranch:repo.default_branch,createdAt:repo.created_at,updatedAt:repo.updated_at})
        }
        await publishPreparedCatalogue(env.DB,'acme',rows,Date.now())
        if(b.health){
          // Explicit test producer preparation, never a health GET fallback.
          const refs=await index.refs()
          for(const sha of new Set(refs.refs.map(r=>r.hash)))await index.apiHealth(sha)
        }
        if(b.diffs)await index.preparedDiffFixture(await q.fixtureUrl())
      }
      return Response.json({ok:true})
    }
    if(url.pathname==='/privacy-fixture') {
      const b=await request.json() as any
      let accessNotifications=0
      if(b.rejectListing!==undefined) {
        if(b.rejectListing)await env.DB.exec("CREATE TRIGGER reject_listing_insert BEFORE INSERT ON repo_listing BEGIN SELECT RAISE(ABORT,'fixture listing unavailable'); END; CREATE TRIGGER reject_listing_update BEFORE UPDATE ON repo_listing BEGIN SELECT RAISE(ABORT,'fixture listing unavailable'); END;")
        else await env.DB.exec('DROP TRIGGER IF EXISTS reject_listing_insert; DROP TRIGGER IF EXISTS reject_listing_update;')
      }
      if(b.hookViewer!==undefined) return Response.json({allowed:await (env.EVENTS.get(env.EVENTS.idFromName('forge-v1')) as unknown as TestForgeEvents).privacyHookAccess(b.hookViewer,b.scope??'repo:acme/demo',b.repository??'acme/demo')})
      if(b.pendingRefProof)return Response.json(await index.pendingRefAcknowledgementFixture())
      if(b.status) return Response.json({status:await index.status(),access:await st.getRepoAccess('acme/demo'),listing:await st.getListings(['acme/demo']),
        preparedRefs:await env.DB.prepare('SELECT epoch,pending,meta,data FROM prepared_repository_refs WHERE id=?').bind('acme/demo').first(),
        renderQueueAvailable:!!(env as any).RENDER_QUEUE})
      if(b.actor) {
        if(!b.actor.includes('/')){if(!b.legacy){await st.prepareClaim(b.actor,'key:'+b.actor,b.actor+'@example.test','claim:'+b.actor);await st.finalizeClaim('claim:'+b.actor)}}
        else {const [sponsor,label]=b.actor.split('/');await st.createAgent(sponsor,label,'key:'+b.actor)}
        await st.saveApiToken(await hashToken(b.token),b.legacy ? null : b.actor,'key:'+b.actor,Date.now()+86400000,{scopes:b.scopes??['repo:read','repo:write','issues:write','pulls:write','actions','hooks','admin'],repos:null as any})
      }
      if(b.org) {
        // Fixture migrates acme from a claimed personal namespace to an org
        // namespace; Git transport keeps the same disposable repository.
        await env.DB.prepare("DELETE FROM owner_names WHERE name='acme'").run()
        await st.createOrg('acme',null,'acme')
        await st.addOrgMember('acme','member','member')
      }
      if(b.acl) {
        const {writeMeta,readJson,writeJson,DIR}=await import('../lib/metastore')
        // Observe the direct notification before acknowledging the ACL write.
        // Draining push events also clears socket grants, so eventual socket
        // closure alone cannot prove this production notification was sent.
        const channels=env.REPO_CHANNEL
        configure({...env,REPO_CHANNEL:{idFromName:name=>channels.idFromName(name),get:id=>new Proxy(channels.get(id),{
          get(target,key){const value=Reflect.get(target,key)
            if(key==='accessChanged')return (...args:unknown[])=>{accessNotifications++;return Reflect.apply(value,target,args)}
            return typeof value==='function'?value.bind(target):value
          },
        })}})
        try {await writeMeta('acme','demo','privacy fixture acl','acme',async fs=>{await writeJson(fs,`${DIR}/.gild/acl.json`,b.acl)})}
        finally {configure(env)}
      }
      if(b.fence)await st.fenceRepoAccess('acme/demo',b.fence)
      if(b.unfence)await st.publishRepoAccess('acme/demo',b.unfence,b.policy)
      return Response.json({ok:true,...(b.acl?{accessNotifications}:{})})
    }
    const oldIssue = url.pathname.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)(\/comments)?$/)
    if (oldIssue && request.method === 'POST') {
      const params = {owner:oldIssue[1],repo:oldIssue[2],number:oldIssue[3]}, b = await request.clone().json() as any
      // Shared browser adapters use the same canonical handlers. Full cookie/
      // CSRF adapter behavior is tested in channel-web against compiled Next.
      const url = new URL(request.url)
      url.pathname = `/api/v1/repos/${params.owner}/${params.repo}/issues/${params.number}${oldIssue[4] ? '/comments' : b.action === 'claim' || b.action === 'unclaim' ? '/claim' : ''}`
      return fixtureFetch(new Request(url, {method:oldIssue[4] || b.action === 'claim' || b.action === 'unclaim' ? 'POST' : 'PATCH',headers:request.headers,body:JSON.stringify(oldIssue[4] || b.action === 'claim' || b.action === 'unclaim' ? b : {state:b.action === 'close' ? 'closed' : 'open'})}),env)
    }
    if (url.pathname === '/flush-events') {
      await index.indexFixture(await q.fixtureUrl())
      await q.drain()
      await (await import('../lib/events/d1-outbox')).flushAgentEvents(env)
      await (env.EVENTS.get(env.EVENTS.idFromName('forge-v1')) as unknown as TestForgeEvents).drainChannel()
      return Response.json({ ok: true })
    }
    if (url.pathname === '/emit-fixture') {
      return Response.json({
        cursor: await hubFrom(env).emit(
          (await request.json()) as import('../lib/api/events-contract').Emission,
        ),
      })
    }
    if (url.pathname === '/push-fixture') {
      const b = (await request.json()) as {
        sha: string
        before: string
        ref: string
      }
      await index.recordPush('fixture:' + b.sha, [b], 'acme')
      await index.refresh('acme', 'demo')
      return Response.json(await index.indexFixture(await q.fixtureUrl()))
    }
    if (url.pathname === '/session-token-fixture') {
      const b = (await request.json()) as { token: string }
      await st.saveApiToken(
        await hashToken(b.token),
        'acme/requested',
        'ed25519:fixture',
        Date.now() + 86400000,
        {
          scopes: ['repo:read', 'repo:write', 'pulls:write'],
          repos: ['acme/demo'],
        },
      )
      return Response.json({ ok: true })
    }
    if (url.pathname === '/event-fixture') {
      await (
        env.EVENTS.get(
          env.EVENTS.idFromName('forge-v1'),
        ) as unknown as TestForgeEvents
      ).fixture(((await request.json()) as { receiver: string }).receiver)
      return Response.json({ ok: true })
    }
    if (url.pathname.startsWith('/api/repos')) {
      const name = await caller(request)
      return Response.json({ name }, { status: name ? 200 : 401 })
    }
    if (url.pathname === '/fixture') {
      const b = (await request.json()) as {
        url: string
        token: string
        sha: string
      }
      configure(env, b.url)
      await q.fixture(b.url)
      let result
      for (let i = 0; i < 100; i++) {
        result = await index.indexFixture(b.url)
        if (result.done) break
      }
      await st.prepareClaim(
        'acme',
        'ed25519:fixture',
        'fixture@example.test',
        'claim',
      )
      await st.finalizeClaim('claim')
      await st.saveApiToken(
        await hashToken(b.token),
        'acme',
        'ed25519:fixture',
        Date.now() + 86400000,
      )
      await st.createAgent('acme', 'disposable', 'key')
      await q.deliver({
        name: 'push',
        title: 'Fixture',
        key: 'fixture-push',
        sha: b.sha,
        ref: 'refs/heads/main',
        before: '0'.repeat(40),
        repository: 'acme/demo',
        actor: 'acme',
      })
      await q.drain()
      return Response.json(result)
    }
    if (url.pathname === '/evict-raw') {
      await index.evictRaw(url.searchParams.get('sha')!)
      return Response.json({ ok: true })
    }
    if (url.pathname === '/drain-index')
      return Response.json(await index.indexFixture(await q.fixtureUrl()))
    if (url.pathname === '/exhaust') {
      await (
        env.API_CONTROL.get(
          env.API_CONTROL.idFromName(
            url.searchParams.get('id') ?? await hashToken(url.searchParams.get('token')!),
          ),
        ) as unknown as TestApiControl
      ).exhaust()
      return Response.json({ ok: true })
    }
    if (url.pathname === '/approval-fixture') {
      const { run } = (await request.json()) as { run: number }
      const detail = await q.detail(run)
      if (!detail) throw Error('Fixture run missing')
      const id = await q.enqueue(detail.run.workflow, {
        ...detail.run.event,
        name: 'pull_request',
        actor: 'untrusted',
        key: crypto.randomUUID(),
      })
      return Response.json({ id, job: (await q.detail(id))!.jobs[0].id })
    }
    if (url.pathname === '/star-rows-fixture')
      return Response.json((await env.DB.prepare('SELECT repo,name FROM stars ORDER BY repo,name').all()).results)
    if (url.pathname === '/ready-fixture') return Response.json(await q.ready())
    if (url.pathname === '/drain') {
      await q.drain()
      return Response.json(await q.overview())
    }
    const readModels=new PreparedReadModels(env.DB)
    const handlers = service({
      accounts:{db:env.DB,store:st},
      readModels,contentReads:new PreparedRepositoryContent(env.DB,readModels),conversationReads:new PreparedConversations(env.DB,readModels),
      channel:channelHandler({store:st,index:readyIndex},async()=>env),
      orchestrators: orchestratorHandler({store:st,index:readyIndex},{
        bindings: async () => env as never,
        createToken,
        attach: (owner, repo, by, agent, grants) => setAgentGrants(owner, repo, by, agent, grants, true),
      }),
      privacy:(await import('../lib/privacy-production')).privacyOperations,
      store: st,
      runners: apiRunners,
      imports: apiImports,
      importAuthorize: authorizeImport,
      index: readyIndex,
      catalog: async (owner) => owner && owner !== 'acme' ? [] : [
        {
          owner: 'acme',
          name: 'demo',
          default_branch: 'main',
          description: 'API fixture',
        },
      ],
      createToken,
      writes: {
        claim: changeIssue,
        dequeue: dequeuePull,
        grants: setAgentGrants,
        repository: createRepository,
        issue: createIssueRecord,
        update: updateItem,
        inline: addInlineComment,
        comment: addComment,
        pull: createPull,
        pullComment: commentOnPull,
        review: reviewPull,
        queue: enqueueAndDrain,
        fileRequest,
        decide,
      },
      events: eventHandler(async () => hubFrom(env), c => eventRepositories(c, async () => ['acme/demo'],
        (owner, repo, viewer) => mayRead({store: st, index: readyIndex}, owner, repo, viewer))),
      health: async (index, _owner, _repo, sha) => index.apiHealth(sha),
      actions: actionHandler({
        inheritedRunners: async (owner, repo) =>
          (await (await runnerPool(owner)).overview(`${owner}/${repo}`)).runners,
        actionEnv: async () => env,
        runQueue,
        dispatch: dispatchWorkflow,
        mayWrite,
      }),
    })
    return dispatch(request, {
      ...handlers,
      execute: async (c) => {
        try {
          return await handlers.execute(c)
        } catch (e) {
          console.error('Fixture service failure:', (e as Error).stack)
          throw e
        }
      },
      authenticate: async (request) => {
        const token =
          request.headers
            .get('authorization')
            ?.replace(/^(Bearer|token) /i, '') ?? ''
        const matched = match(
          request.method,
          new URL(request.url).pathname.replace(/^\/api\/v1/, ''),
        )
        if(token.startsWith('gi_') && /^import(?:Credentials|Heartbeat|Batch|Workflow|Finish)$/.test(matched?.route.id??'')) {
          try {await (await importJob(matched!.params.owner,matched!.params.repo)).authorize(token);return {id:'import:'+await hashToken(token),name:'import-runner',publicKey:'',scopes:['repo:read','repo:write'],repos:[`${matched!.params.owner}/${matched!.params.repo}`]}} catch{return null}
        }
        if (
          token.startsWith('gr_') &&
          (matched?.route.id.startsWith('runner') ||
            matched?.route.id === 'actionRunners')
        ) {
          try {
            await q.readRepo(token)
            return {
              id: await hashToken(token),
              name: 'runner',
              publicKey: '',
              scopes: ['actions'],
              repos: ['acme/demo'],
            }
          } catch {
            return null
          }
        }
        if (matched && token.startsWith('gro_') && (matched.route.id.endsWith('PoolPoll') || /^import(?:User|Org)Poll$/.test(matched?.route.id??''))) {
          try {
            const owner = matched.params.org ?? matched.params.name
            await (
              await runnerPool(owner, matched.params.org ? 'org' : 'user')
            ).authenticate(token)
            return {
              id: await hashToken(token), name: 'runner', publicKey: '',
              scopes: ['actions'], repos: null,
            }
          } catch {
            return null
          }
        }
        if (
          token.startsWith('grt_') &&
          ['actionRegister', 'orgPoolRegister', 'userPoolRegister'].includes(matched?.route.id ?? '')
        )
          return {
            id: await hashToken(token), name: 'registration', publicKey: '',
            scopes: ['actions'],
            repos: matched?.params.repo ? [`${matched.params.owner}/${matched.params.repo}`] : null,
          }
        const t = await verifyStoredToken(token, st)
        if (!t?.name) await denySuspended(token, st)
        return t?.name
          ? {
              id: await hashToken(token),
              name: t.name,
              publicKey: t.publicKey,
              scopes: t.scopes,
              repos: t.repos,
            }
          : null
      },
      account: async (name: string) => (await import('../lib/accounts.ts')).account(env.DB, name),
      control: async (id) =>
        env.API_CONTROL.get(env.API_CONTROL.idFromName(id)),
    })
}
