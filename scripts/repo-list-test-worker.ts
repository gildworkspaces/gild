// Disposable workerd fixture: real repository SQLite DOs and the D1 driver.
import { RepoIndex } from '../lib/repo-index-do'
import { d1Store } from '../lib/drivers/d1'
import * as listing from '../lib/repo-list'
import type { ListServices } from '../lib/repo-list'
import { publicActivityLoader } from '../lib/public-activity'
import { awaitCurrentIndex } from '../lib/repo-index-ready'
import { BUILD, CATEGORIES } from '../lib/cqx-wasm'
import { READS_VERSION } from '../lib/cqx-reads'
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { RepoList } from '../components/RepoList'

export class ListingFixture extends RepoIndex {
  // This seed-only fixture has no Git transport; publication is driven below.
  async alarm() { await this.ctx.storage.deleteAlarm() }
  async seed(version = 1, privateRepo = false, publish = false, id = '') {
    const tip = version.toString(16).padStart(40, '0'),
      tree = 'tree' + version
    this.index.putCommit({
      hash: tip,
      tree,
      parents: [],
      author_name: 'Fixture',
      author_email: 'fixture@example.test',
      time: 1791460800 + version,
      message: 'Fixture push',
    })
    this.index.putTree(tree, [
      { name: 'main.ts', type: 'blob', mode: '100644', child: 'code' },
    ])
    this.index.putBlob({
      hash: 'code',
      size: 20,
      lines: 1,
      language: 'TypeScript',
      binary: 0,
      content: 'export const n = 1',
      symbols: [],
    })
    const meta = 'meta' + version + privateRepo
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO meta_roots VALUES (?)',
      meta,
    )
    for (const [path, value] of Object.entries({
      '.gild/acl.json': { private: privateRepo, read: ['@reader'] },
      '.gild/index.json': {
        issues: [{schema:1,number:1,title:'Fixture issue',body:'Fixture',author:'reader',createdAt:'2026-10-01T00:00:00Z',state:'open',labels:[],claim:null}],
        pulls: [
          {schema:1,number:2,title:'Fixture open pull',body:'Fixture',author:'reader',createdAt:'2026-10-01T00:00:00Z',head:'main',base:'main',state:'open'},
          {schema:1,number:3,title:'Fixture merged pull',body:'Fixture',author:'reader',createdAt:'2026-10-01T00:00:00Z',head:'main',base:'main',state:'merged'},
        ],
      },
    }))
      this.ctx.storage.sql.exec(
        'INSERT OR IGNORE INTO meta_files VALUES (?,?,?)',
        meta,
        path,
        JSON.stringify(value),
      )
    // Simulate the same pre-push access fence as real metadata writes.
    if (id) await d1Store(this.env.DB).fenceRepoAccess(id, meta)
    this.index.publish(
      [{ name: 'main', kind: 'branch', hash: tip }],
      'main',
      meta,
    )
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO api_history_roots VALUES (?)',
      tip,
    )
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO api_history_nodes VALUES (?,?,?)',
      tip,
      tip,
      1791460800 + version,
    )
    this.index.setting('dirty', '')
    if (publish) await this.listing(id)
    return tip
  }
}
type Stub = {
  [
    K in
      | 'seed'
      | 'purge'
      | 'address'
      | 'listing'
      | 'listingAcl'
      | 'status'
      | 'refs'
      | 'refresh'
      | 'ensureHistory'
      | 'commit'
      | 'tree'
      | 'languages'
      | 'blobText'
      | 'apiLog'
      | 'metaFile'
  ]: (
    ...args: Parameters<ListingFixture[K]>
  ) => Promise<Awaited<ReturnType<ListingFixture[K]>>>
}
interface Env {
  DB: D1Database
  REPO_INDEX: { idFromName(name: string): unknown; get(id: unknown): Stub }
}
const catalog = Array.from({ length: 15 }, (_, i) => ({
  id: String(i),
  name: 'repo' + i,
  description: 'Fixture',
  default_branch: 'main',
  created_at: '',
  updated_at: '',
  last_push_at: null,
}))
const cache = new Map<string, unknown>()
let landingServices: Parameters<typeof publicActivityLoader>[0]
// Fix only the candidate-cache clock so restarting workerd at a real minute
// boundary cannot accidentally turn this warm-cache assertion into a miss.
const landing = publicActivityLoader(
  {
    owners: () => landingServices.owners(),
    repos: (...args) => landingServices.repos(...args),
    commits: (rows) => landingServices.commits(rows),
    keep: (key, compute) => landingServices.keep!(key, compute),
  },
  () => 0,
)
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url),
      st = d1Store(env.DB)
    let doCalls = 0,
      d1Calls = 0,
      scans = 0
    // Count actual D1 statements and DO RPCs, including the service adapters.
    const countedDB = new Proxy(env.DB, {
      get(target, key) {
        if (key === 'prepare')
          return (sql: string) => {
            const wrap = (
              statement: D1PreparedStatement,
            ): D1PreparedStatement =>
              new Proxy(statement, {
                get(s, method) {
                  if (method === 'bind')
                    return (...args: unknown[]) => wrap(s.bind(...args))
                  if (['first', 'all', 'run', 'raw'].includes(String(method)))
                    return (...args: unknown[]) => {
                      d1Calls++
                      return Reflect.apply(Reflect.get(s, method), s, args)
                    }
                  return Reflect.get(s, method)
                },
              })
            return wrap(target.prepare(sql))
          }
        return Reflect.get(target, key)
      },
    })
    const store = d1Store(countedDB)
    const index = (name: string) => {
      const stub = env.REPO_INDEX.get(env.REPO_INDEX.idFromName('acme/' + name))
      return new Proxy(stub, {
        get(target, key) {
          if (key === 'then') return undefined
          return (...args: unknown[]) => {
            doCalls++
            return Reflect.apply(Reflect.get(target, key), target, args)
          }
        },
      })
    }
    if (url.pathname === '/seed') {
      for (const r of catalog) {
        const tip = await index(r.name).seed(
          Number(url.searchParams.get('version') ?? 1),
          url.searchParams.get('private') === r.name,
          url.searchParams.has('publish'),
          'acme/' + r.name,
        )
        await st.putScore(
          `acme/${r.name}@${tip}#${BUILD}:${READS_VERSION}`,
          JSON.stringify({
            scores: Object.fromEntries(CATEGORIES.map((k) => [k, 72])),
          }),
        )
      }
      cache.clear()
      return Response.json({ seeded: 15 })
    }
    if (url.pathname === '/star') {
      await st.star('acme/repo0', 'reader')
      return Response.json({ ok: true })
    }
    if (url.pathname === '/acl') {
      await st.fenceRepoAccess('acme/repo0', 'meta2true')
      await index('repo0').listingAcl('meta2true', {
        private: true,
        read: ['@reader'],
      })
      return Response.json({ ok: true })
    }
    if (url.pathname === '/purge') {
      await index('repo0').purge()
      return Response.json(await st.getListings(['acme/repo0']))
    }
    if (url.pathname === '/old-projection') {
      const value = (await st.getListings(['acme/repo0']))['acme/repo0']
      await st.putListing('acme/repo0', 0, { ...value, issues: 999 })
      return Response.json((await st.getListings(['acme/repo0']))['acme/repo0'])
    }
    const services = {
      store,
      catalog: async () => catalog,
      snapshots: async (repos: { id: string; name: string }[]) => {
        return listing.listingBatch(store, repos, (id) =>
          index(id.slice('acme/'.length)).listing(id),
        )
      },
      scores: async (
        owner: string,
        repos: { name: string; tip: string | null }[],
      ) => {
        const keys = repos
          .filter((r) => r.tip)
          .map((r) => ({
            name: r.name,
            key: `${owner}/${r.name}@${r.tip}#${BUILD}:${READS_VERSION}`,
          }))
        const raw = await store.getScores(keys.map((r) => r.key))
        return Object.fromEntries(
          keys.map((r) => [
            r.name,
            raw[r.key] ? JSON.parse(raw[r.key]).scores.quality : null,
          ]),
        )
      },
      index: async (owner: string, repo: string) => {
        const state = await store.settings.state(`${owner}/${repo}`),
          stub = index(repo)
        await stub.address(owner, repo)
        const live = {
          branches: [
            {
              name: 'main',
              oid: Number(url.searchParams.get('version') ?? 1)
                .toString(16)
                .padStart(40, '0'),
            },
          ],
          tags: [],
          defaultBranch: 'main',
          meta: 'meta' + Number(url.searchParams.get('version') ?? 1) + false,
        }
        void state
        return awaitCurrentIndex(stub, owner, repo, live, async () => live)
      },
      keep: async (key: string, compute: () => Promise<unknown>) => {
        if (cache.has(key)) return cache.get(key)
        const raw = await store.getChange(key)
        if (raw) {
          const value = JSON.parse(new TextDecoder().decode(raw))
          cache.set(key, value)
          return value
        }
        const value = await compute()
        await store.putChange(
          key,
          new TextEncoder().encode(JSON.stringify(value)),
        )
        cache.set(key, value)
        return value
      },
      score: async (owner: string, repo: string, tip: string) => {
        const raw = await store.getScore(
          `${owner}/${repo}@${tip}#${BUILD}:${READS_VERSION}`,
        )
        return raw ? JSON.parse(raw).scores.quality : null
      },
    } as unknown as ListServices
    const start = performance.now()
    landingServices = {
      owners: async () => {
        scans++
        return [{ name: 'acme' }]
      },
      repos: (owner, names, candidates) =>
        listing.repoList(owner, null, services, Date.now(), names, candidates),
      commits: async () => [],
      keep: (
        services as unknown as {
          keep: NonNullable<typeof landingServices.keep>
        }
      ).keep,
    }
    const result =
      url.pathname === '/landing'
        ? await landing()
        : await listing.repoList(
            'acme',
            url.searchParams.get('viewer'),
            services,
          )
    const html = renderToString(
      createElement(RepoList, {
        repos: Array.isArray(result) ? result : result.repos,
        showOwner: url.pathname === '/landing',
      }),
    )
    return Response.json({
      serverMs: performance.now() - start,
      doCalls,
      d1Calls,
      scans,
      html,
      result,
    })
  },
}
