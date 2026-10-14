import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'
mkdirSync('.tmp', { recursive: true })
await build({
  stdin: { contents: "export {listRefs} from './lib/repo-refs-live.ts'", resolveDir: process.cwd() },
  outfile: '.tmp/repo-refs-runtime.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external',
  plugins: [{ name: 'no-request-context', setup(b) {
    for (const filter of [/^isomorphic-git$/, /^\.\/artifacts$/, /^\.\/backend$/, /^@opennextjs\/cloudflare$/])
      b.onResolve({ filter }, ({ path }) => ({ path, namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ loader: 'js', contents: path === 'isomorphic-git'
      ? 'export const listServerRefs=async options=>{globalThis.liveRefsOptions=options;return globalThis.liveRefsAdvertisement}'
      : 'export const readToken=()=>{throw Error("Next bindings forbidden")};export const repoRemote=readToken;export const store=readToken;export const getCloudflareContext=readToken' }))
  } }],
})
const { listRefs } = await import('../.tmp/repo-refs-runtime.mjs')
test('alarm live refs use explicit read connection, filter current import namespace and honor owner default branch without Next state', async () => {
  ;(globalThis as any).liveRefsAdvertisement = [
    { ref: 'HEAD', oid: 'one', target: 'refs/heads/main' },
    { ref: 'refs/heads/main', oid: 'one' },
    { ref: 'refs/heads/release', oid: 'two' },
    { ref: 'refs/heads/_meta', oid: 'meta' },
    { ref: 'refs/heads/staging/private', oid: 'hidden' },
    { ref: 'refs/tags/v1', oid: 'tag', peeled: 'peeled' },
  ]
  let connections = 0, queries = 0, settings = 0
  const runtime = {
    async connection(scope: string) { assert.equal(scope, 'read'); connections++; return { token: 'disposable-fixture', url: 'https://fixture.invalid/owner/repo.git' } },
    DB: { prepare(query: string) { queries++; assert.match(query, /internal_prefix/); return { bind(repo: string) { assert.equal(repo, 'owner/repo'); return { first: async () => ({ internal_prefix: 'staging' }) } } } } },
    store: { settings: { async state(repo: string) { settings++; assert.equal(repo, 'owner/repo'); return { defaultBranch: 'release' } } } },
  }
  assert.deepEqual(await listRefs('owner', 'repo', runtime), { branches: [{ name: 'main', oid: 'one' }, { name: 'release', oid: 'two' }], tags: [{ name: 'v1', oid: 'peeled' }], defaultBranch: 'release', meta: 'meta' })
  assert.equal(connections, 1); assert.equal(queries, 1); assert.equal(settings, 1)
  assert.equal((globalThis as any).liveRefsOptions.url, 'https://fixture.invalid/owner/repo.git')
  assert.deepEqual((globalThis as any).liveRefsOptions.headers, { authorization: 'Bearer disposable-fixture' })
})
