// Test-only transport/binding adapter. No production worker imports this.
import { awaitCurrentIndex } from '../../lib/repo-index-ready'
import { listRefs } from '../../lib/repo-refs-live'
import { d1Store } from '../../lib/drivers/d1'
import type { D1Database } from '@cloudflare/workers-types'
import type { RepoIndex } from '../../lib/repo-index-do'
import type { RunQueue } from '../../lib/actions/queue-do'
type RPC<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never
}
type Namespace<T> = { idFromName(s: string): unknown; get(id: unknown): RPC<T> }
export interface Env {
  REPO_CHANNEL: Namespace<import('../../lib/channel/do').RepoChannel> & {idFromName(s:string):unknown;get(id:unknown):any}
  WEBHOOKS: import('@cloudflare/workers-types').Queue<{delivery: string}>
  EVENTS:Namespace<import('../../lib/events/hub-do').ForgeEvents>
  DB: D1Database
  REPO_IMPORT: Namespace<import('../../lib/import/do').RepoImport>
  REPO_INDEX: Namespace<RepoIndex>
  RUN_QUEUE: Namespace<RunQueue>
  RUNNER_POOL: Namespace<import('../../lib/actions/pool-do').RunnerPool>
  FIXTURE_REMOTE: string
  ARTIFACTS_TOKEN: string
  API_CONTROL: Namespace<import('../../lib/api/control-do').ApiControl>
  ACTIONS_SECRET_KEY: string
}
let configured: Env | undefined,
  configuredRemote = ''
// A Durable Object may run in another isolate than the fetch handler that
// called configure() (celld always does this), so fall back to the binding env.
const bindings = async () =>
    configured ?? ((await import('cloudflare:workers')).env as unknown as Env),
  remoteURL = async () => configuredRemote || (await bindings()).FIXTURE_REMOTE
// The request's own context: workerd cancels a promise that outlives its
// response unless that request's waitUntil holds it (API merges drain so).
let context: { waitUntil(p: Promise<unknown>): void } | undefined
export function configure(env: Env, url?: string, ctx?: typeof context) {
  configured = env
  configuredRemote = url ?? env.FIXTURE_REMOTE
  if (ctx) context = ctx
}
export async function getCloudflareContext() {
  return {
    env: await bindings(),
    ctx: {
      waitUntil: (p: Promise<unknown>) => {
        const work = p.catch((e) => console.error('Fixture background error:', e.message))
        context?.waitUntil(work)
      },
    },
  }
}
// lib/backend's surface used by lib/page: the binding and the store
// decorator (the fixture serves no handed page reads, so it stays live).
export async function binding() {
  return (await bindings()).DB
}
export function decorateStore(_fn: unknown) {}
export async function store() {
  return d1Store((await bindings()).DB)
}
export async function repoIndex(owner: string, repo: string) {
  if (owner !== 'acme' || repo !== 'demo') return null
  const { REPO_INDEX } = await bindings()
  return REPO_INDEX.get(REPO_INDEX.idFromName('acme/demo'))
}
export async function readyIndex(owner: string, repo: string) {
  const index = await repoIndex(owner, repo)
  if (!index) return null
  if ((await index.status()).ready) return index
  // A refresh must not revoke read access to an existing fixture repository.
  return awaitCurrentIndex(
    index, owner, repo, await listRefs(owner, repo), () => listRefs(owner, repo),
  )
}
// This adapter exercises API transactions. Page readiness is verified against
// the actual compiled Worker by the browser gates, without this adapter.
export const pageIndex = readyIndex
export async function indexIfReady(owner: string, repo: string) {
  const index = await repoIndex(owner, repo)
  return index && (await index.status()).ready ? index : null
}
export async function indexRefs(owner: string, repo: string) {
  const index = await readyIndex(owner, repo)
  if (!index) return null
  const r = await index.refs()
  return {
    branches: r.refs
      .filter((r) => r.kind === 'branch')
      .map((r) => ({ name: r.name, oid: r.hash })),
    tags: r.refs
      .filter((r) => r.kind === 'tag')
      .map((r) => ({ name: r.name, oid: r.hash })),
    defaultBranch: r.defaultBranch,
    meta: r.meta,
  }
}
export async function scheduleIndex(owner: string, repo: string) {
  const index = await repoIndex(owner, repo)
  if (!index) return
  await index.refresh(owner, repo)
  for (let i = 0; i < 100; i++) {
    await (
      index as unknown as { indexFixture(url: string): Promise<unknown> }
    ).indexFixture(await remoteURL())
    if ((await index.status()).ready) return
  }
  throw new Error('Index did not finish')
}
export async function mintRepoToken() {
  return { plaintext: 'local-fixture-credential' }
}
export async function repoRemote(owner: string, repo: string) {
  const remote = await remoteURL()
  return repo === 'demo' ? remote : remote.replace('/repo.git', `/${owner}-${repo}.git`)
}
export async function repoInfo(owner: string, repo: string) {
  if (owner !== 'acme' || repo !== 'demo') throw new Error('unknown repo')
  return {
    id: 'fixture',
    name: repo,
    description: 'API fixture',
    default_branch: 'main',
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    last_push_at: null,
  }
}
export async function listRepos() {
  return [await repoInfo('acme', 'demo')]
}
export const listReposFor = listRepos
// Catalogue preparation runs in a background DO isolate too. Observe the
// disposable Git server's namespace inventory rather than aliasing listRepos()
// (which returns demo for every owner), or certifying an unobserved empty list.
// The credential is the existing test binding; this local transport does not
// forward it to another service or require production Artifacts credentials.
export async function rawListRepos(ns: string, _credential?: string) {
  const url = new URL('/repositories', await remoteURL())
  url.searchParams.set('namespace', ns)
  const response = await fetch(url)
  if (response.status === 404) return []
  if (!response.ok) throw Object.assign(Error('Fixture repository inventory unavailable'), {status:response.status})
  const rows = await response.json()
  if (!Array.isArray(rows)) throw new Error('Invalid fixture repository inventory')
  return rows as Awaited<ReturnType<typeof repoInfo>>[]
}
export async function repoLog() {
  return []
}
export async function repoFile() {
  throw new Error('API must read indexed files')
}
export async function repoTree() {
  throw new Error('API must read indexed trees')
}
export async function repoCommit() {
  throw new Error('API must read indexed commits')
}
export async function repoBlob() {
  throw new Error('API must read indexed blobs')
}
export const nsFor = (name: string) => 'fixture-' + name
export async function createRepo(
  owner: string,
  name: string,
  description?: string,
) {
  const u = new URL('/repository', await remoteURL())
  u.searchParams.set('owner', owner)
  u.searchParams.set('name', name)
  if (description) u.searchParams.set('description', description)
  const r = await fetch(u, { method: 'POST' })
  if (!r.ok) throw new Error('Repository exists')
  return r.json() as Promise<Awaited<ReturnType<typeof repoInfo>>>
}
export { NAME_RE, AGENT_LABEL_RE } from '../../lib/backend-names'
export const readToken = mintRepoToken

// Disposable Git transport for the production pool's repository existence check.
export async function rawRepo(ns: string, repo: string, method: string) {
  const u = new URL('/repository', await remoteURL())
  u.searchParams.set('owner', ns.replace(/^fixture-/, ''))
  u.searchParams.set('name', repo)
  const response = await fetch(u, { method })
  if (!response.ok)
    throw Object.assign(Error('Repository not found'), { status: response.status })
  return response
}

export const listListingRepos = listRepos
