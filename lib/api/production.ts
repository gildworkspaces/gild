import {PreparedConversations} from '../prepared-conversations.ts'
import {PreparedRepositoryContent} from '../prepared-repository-content.ts'
import type {D1Database} from '@cloudflare/workers-types'
import {PreparedReadModels} from '../prepared-read-models.ts'
import { writePackageManifest } from '../agent-package-write'
import { channelHandler } from '../channel/service'
import { orchestratorHandler } from '../orchestrators.ts'
import { apiImports,authorizeImport } from './imports'
import { importJob } from '../import/service'
import { apiRunners } from './runners'
import { runnerPool } from '../actions/pool-service'
import { settingsHandler } from '../settings-production.ts'
import { mayRead } from '../repo-read.ts'
import { eventRepositories } from '../events/repositories.ts'
import { eventHandler } from './events.ts'
import { hub } from '../events/emit.ts'
import { changeIssue } from '../issues.ts'
import { dequeuePull } from '../pulls.ts'
import { setAgentGrants } from '../access.ts'
import { ApiError, errorResponse } from './errors.ts'
import { createRepository } from '../repos-write.ts'
import { getCloudflareContext } from '@opennextjs/cloudflare'
import { store } from '../backend.ts'
import { verifyToken, createToken } from '../tokens.ts'
import { hashToken, denySuspended } from '../token-verifier.ts'
import { readyIndex } from '../repo-index.ts'
import { listReposFor } from '../artifacts.ts'
import { memo } from '../kept.ts'
import { service } from './service.ts'
import { match } from './dispatch.ts'
import { runQueue } from '../actions/service.ts'
import { dispatch, type Dependencies } from './dispatch.ts'
import { createIssueRecord, updateItem, addInlineComment } from './metadata.ts'
import { addComment } from '../issues.ts'
import { createPull, commentOnPull, reviewPull, enqueueAndDrain } from '../pulls.ts'
import { fileRequest, decide } from '../agentRequests.ts'
import { apiActions } from './actions-production.ts'
import type { ApiControl } from './control-do.ts'
const catalogCache = memo<
  {
    owner: string
    name: string
    description: string | null
    created_at: string
    updated_at: string
    default_branch: string
  }[]
>(60_000)
export async function dependencies(): Promise<Dependencies> {
  const st = await store()
  const visible = async (rows: Awaited<ReturnType<typeof catalogCache>>) =>
    (
      await Promise.all(
        rows.map(async (r) => {
          const original = `${r.owner}/${r.name}`,
            owner = await st.settings.canonical(r.owner),
            direct = await st.settings.canonical(original),
            key =
              direct === original
                ? await st.settings.canonical(`${owner}/${r.name}`)
                : direct
          const [nextOwner, nextRepo] = key.split('/'),
            org = await st.settings.state(nextOwner),
            item = await st.settings.state(key)
          return org.deletedAt !== null || item.deletedAt !== null
            ? null
            : {
                ...r,
                owner: nextOwner,
                name: nextRepo,
                description: item.description ?? r.description,
                default_branch: item.defaultBranch ?? r.default_branch,
              }
        }),
      )
    ).filter((r) => r !== null)
  const db=((await getCloudflareContext()).env as unknown as {DB:D1Database}).DB,readModels=new PreparedReadModels(db)
  const searchDB=((await getCloudflareContext()).env as unknown as {SEARCH_DB?:D1Database}).SEARCH_DB
  const handlers = service({
    accounts: { db, store: st },
    ...(searchDB ? { search: async ({ viewer, ...input }: Parameters<NonNullable<import('./service.ts').Services['search']>>[0]) => {
      const { searchCode, readablePrivate } = await import('../search-index.ts')
      return searchCode(searchDB, { ...input, readable: await readablePrivate(db, viewer) })
    } } : {}),
    readModels,contentReads:new PreparedRepositoryContent(db,readModels),conversationReads:new PreparedConversations(db,readModels),
    packageWrite:writePackageManifest,
    channel: channelHandler({store:st,index:readyIndex},async ()=>(await getCloudflareContext()).env as never),
    orchestrators: orchestratorHandler({store:st,index:readyIndex},{
      bindings: async () => (await getCloudflareContext()).env as never,
      createToken,
      attach: (owner, repo, by, agent, grants) => setAgentGrants(owner, repo, by, agent, grants, true),
    }),
    imports: apiImports,
      importAuthorize: authorizeImport,
    store: st,
    privacy:(await import('../privacy-production')).privacyOperations,
    settings: settingsHandler,
    runners: apiRunners,
    index: readyIndex,
    catalog: async (owner) =>
      visible(
        await catalogCache(owner ?? '*', async () => {
          const owners = owner
            ? [
                {
                  name: owner,
                  kind: (await st.getOrg(owner))
                    ? ('org' as const)
                    : ('user' as const),
                },
              ]
            : await st.owners()
          return (
            await Promise.all(
              owners.map(async (o) =>
                (await listReposFor(o.name, o.kind)).map((r) => ({
                  ...r,
                  owner: o.name,
                })),
              ),
            )
          ).flat()
        }),
      ),
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
    events: eventHandler(hub, (c) =>
      eventRepositories(
        c,
        async () =>
          (
            await Promise.all(
              (await st.owners()).map(async (o) =>
                (await listReposFor(o.name, o.kind)).map(
                  (r) => `${o.name}/${r.name}`,
                ),
              ),
            )
          ).flat(),
        (owner, repo, viewer) =>
          mayRead({ store: st, index: readyIndex }, owner, repo, viewer),
      ),
    ),
    health: async (index, _owner, _repo, sha) => index.apiHealth(sha),
    actions: apiActions,
  })
  return {
    ...handlers,
    account: async (name: string) => (await import('../accounts.ts')).account(db, name),
    authenticate: async (request) => {
      const runner =
        request.headers.get('authorization')?.replace(/^Bearer /i, '') ?? ''
      const route = match(
        request.method,
        new URL(request.url).pathname.replace(/^\/api\/v1/, ''),
      )
      if(runner.startsWith('gi_') && /^import(?:Credentials|Heartbeat|Batch|Workflow|Finish)$/.test(route?.route.id ?? '')) {
        try {await (await importJob(route!.params.owner,route!.params.repo)).authorize(runner);return {id:'import:'+await hashToken(runner),name:'import-runner',publicKey:'',scopes:['repo:read','repo:write'],repos:[`${route!.params.owner}/${route!.params.repo}`]}} catch {return null}
      }
      if(runner.startsWith('gro_') && /^import(?:User|Org)Poll$/.test(route?.route.id ?? '')) {
        try {await (await runnerPool(route!.params.org ?? route!.params.name,route!.params.org?'org':'user')).authenticate(runner);return {id:await hashToken(runner),name:'runner',publicKey:'',scopes:['actions'],repos:null}} catch {return null}
      }
      if (
        runner.startsWith('grt_') &&
        (route?.route.id === 'actionRegister' ||
          /^(org|user)PoolRegister$/.test(route?.route.id ?? ''))
      )
        return {
          id: await hashToken(runner),
          name: 'registration',
          publicKey: '',
          scopes: ['actions'],
          repos: route?.params.repo
            ? [`${route.params.owner}/${route.params.repo}`]
            : null,
        }
      if (
        runner.startsWith('gro_') &&
        /^(org|user)PoolPoll$/.test(route?.route.id ?? '')
      ) {
        try {
          await (
            await runnerPool(
              route!.params.org ?? route!.params.name,
              route!.params.org ? 'org' : 'user',
            )
          ).authenticate(runner)
          return {
            id: await hashToken(runner),
            name: 'runner',
            publicKey: '',
            scopes: ['actions'],
            repos: null,
          }
        } catch {
          return null
        }
      }
      if (
        (runner.startsWith('gr_') || runner.startsWith('gc_')) &&
        (route?.route.id.startsWith('runner') ||
          (runner.startsWith('gr_') && route?.route.id === 'actionRunners'))
      ) {
        try {
          const { owner, repo } = route.params
          await (await runQueue(owner, repo)).readRepo(runner)
          return {
            id: await hashToken(runner),
            name: 'runner',
            publicKey: '',
            scopes: ['actions'],
            repos: [`${owner}/${repo}`],
          }
        } catch {
          return null
        }
      }
      const auth = request.headers
        .get('authorization')
        ?.match(/^(?:Bearer|token)\s+(gf_\w+)$/i)
      if (!auth) return null
      const token = await verifyToken(auth[1])
      if (!token?.name) {
        await denySuspended(auth[1], st)
        return null
      }
      return {
        id: await hashToken(auth[1]),
        name: token.name,
        publicKey: token.publicKey,
        scopes: token.scopes,
        repos: token.repos,
      }
    },
    control: async (id) => {
      const ns = (
        (await getCloudflareContext()).env as unknown as Record<string, unknown>
      ).API_CONTROL as unknown as {
        idFromName(s: string): unknown
        get(id: unknown): ApiControl
      }
      if (!ns) throw new Error('API_CONTROL binding is required')
      return ns.get(ns.idFromName(id))
    },
  }
}
export async function api(request: Request) {
  try {
    return await dispatch(request, await dependencies())
  } catch (e) {
    return errorResponse(
      e instanceof ApiError ? e.status : 503,
      e instanceof ApiError
        ? e.message
        : 'API storage is temporarily unavailable',
    )
  }
}
