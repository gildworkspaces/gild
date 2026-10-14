import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { memoryStore } from './drivers/memory.ts'
import { metadataOperationPath } from './metadata-operation.ts'

const globals = globalThis as unknown as { __operationStore: ReturnType<typeof memoryStore>; __operationURL: string }
test('actual metadata Git commit contains operation receipt even when post-push publication fails', async () => {
  mkdirSync('.tmp', { recursive: true })
  const work = mkdtempSync(resolve('.tmp/metadata-operation-')), source = join(work, 'source'), bare = join(work, 'repo.git')
  mkdirSync(source); mkdirSync(join(source, '.gild'))
  const run = (...args: string[]) => execFileSync('git', args, { cwd: source, stdio: 'pipe', encoding: 'utf8' }).trim()
  run('init', '-b', '_meta')
  writeFileSync(join(source, '.gild/next'), '1\n'); writeFileSync(join(source, '.gild/acl.json'), '{"visibility":"public"}')
  run('add', '.'); run('-c', 'commit.gpgsign=false', 'commit', '-m', 'Disposable operation fixture')
  run('init', '--bare', '--initial-branch=main', bare); run('push', bare, '_meta')
  const initial = run('--git-dir=' + bare, 'rev-parse', '_meta')
  const server = createServer((request, response) => {
    const advertise = request.url?.includes('/info/refs'), service = request.url?.includes('receive-pack') ? 'receive-pack' : 'upload-pack'
    response.setHeader('content-type', `application/x-git-${service}-${advertise ? 'advertisement' : 'result'}`)
    if (advertise) {
      const line = '# service=git-' + service + '\n'
      response.write((Buffer.byteLength(line) + 4).toString(16).padStart(4, '0') + line + '0000')
    }
    const child = spawn('git', ['-c', 'uploadpack.allowAnySHA1InWant=true', service, '--stateless-rpc', ...(advertise ? ['--advertise-refs'] : []), bare], { stdio: ['pipe', 'pipe', 'pipe'] })
    child.stderr.resume(); request.pipe(child.stdin); child.stdout.pipe(response)
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  globals.__operationURL = `http://127.0.0.1:${address.port}/repo.git`
  globals.__operationStore = memoryStore()
  let fail = true
  const publish = globals.__operationStore.publishRepoAccess.bind(globals.__operationStore)
  globals.__operationStore.publishRepoAccess = async (...args) => { if (fail) { fail = false; throw Error('post-push ACL fixture failure') }; return publish(...args) }
  const mocks: Record<string, string> = {
    repo: 'export const repoRefs=()=>{throw Error("unused repoRefs")}',
    backend: 'export const store=async()=>globalThis.__operationStore;export const binding=async()=>null;export const decorateStore=()=>{}',
    artifacts: 'export const readToken=()=>{throw Error("Unused read connection in metadata receipt test")};export const repoRemote=async()=>globalThis.__operationURL;export const mintRepoToken=async()=>({plaintext:"disposable"});export const repoFile=()=>{throw Error("unused repoFile")}',
    index: 'export const pageIndex=async()=>{throw Error("Unused page read in metadata receipt test")};export const readyIndex=async()=>null;export const repoIndex=async()=>null;export const scheduleIndex=async()=>{}',
    cloudflare: 'export const getCloudflareContext=()=>({env:{},ctx:{waitUntil(){}}})',
    channel: 'export const channelAccessChanged=async()=>{}',
    headers: 'export const cookies=()=>{throw Error("Unexpected Next request access")};export const headers=cookies',
  }
  const outfile = join(work, 'metastore.mjs')
  try {
    await build({ stdin: { contents: "export {writeMeta,DIR} from './lib/metastore.ts';export {withMetadataOperation} from './lib/metadata-operation.ts'", resolveDir: resolve('.') }, outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', plugins: [{ name: 'disposable-deployment-bindings', setup(b) {
      b.onResolve({ filter: /\/repo(?:\.ts)?$/ }, () => ({ path: 'repo', namespace: 'fixture' }))
      b.onResolve({ filter: /\/backend(?:\.ts)?$/ }, () => ({ path: 'backend', namespace: 'fixture' }))
      b.onResolve({ filter: /\/artifacts(?:\.ts)?$/ }, () => ({ path: 'artifacts', namespace: 'fixture' }))
      b.onResolve({ filter: /\/repo-index(?:\.ts)?$/ }, () => ({ path: 'index', namespace: 'fixture' }))
      b.onResolve({ filter: /^next\/headers$/ }, () => ({ path: 'headers', namespace: 'fixture' }))
      b.onResolve({ filter: /^@opennextjs\/cloudflare$/ }, () => ({ path: 'cloudflare', namespace: 'fixture' }))
      b.onResolve({ filter: /\/channel\/binding(?:\.ts)?$/ }, () => ({ path: 'channel', namespace: 'fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ contents: mocks[a.path], loader: 'js' }))
    } }] })
    const metadata = await import(pathToFileURL(outfile).href)
    const operation = 'a'.repeat(64)
    let applied = 0
    const mutate = () => metadata.withMetadataOperation(operation, () => metadata.writeMeta('acme', 'demo', 'fixture issue', 'acme', async (fs: any) => {
      applied++
      const issue = { schema: 1, number: 1, author: 'acme', title: 'one', body: 'once', createdAt: '2026-10-11T20:00:00.000Z', state: 'open', labels: [], claim: null }
      await fs.writeFile(metadata.DIR + '/.gild/1/issue/issue.json', JSON.stringify(issue))
      return issue
    }))
    await assert.rejects(mutate(), /post-push ACL fixture failure/)
    const committed = run('--git-dir=' + bare, 'rev-parse', '_meta')
    assert.notEqual(committed, initial, 'Git accepted the metadata push before the failure')
    assert.ok(run('--git-dir=' + bare, 'ls-tree', '-r', '--name-only', '_meta').split('\n').includes(metadataOperationPath(operation)), 'committed write must carry its durable operation receipt')
    const receipt = JSON.parse(run('--git-dir=' + bare, 'show', '_meta:' + metadataOperationPath(operation)))
    const issue = JSON.parse(run('--git-dir=' + bare, 'show', '_meta:.gild/1/issue/issue.json'))
    assert.deepEqual(receipt.result, issue, 'receipt and business record are in the exact same commit')
    assert.deepEqual(await mutate(), issue)
    assert.equal(applied, 1, 'recovery must skip the mutation callback')
    assert.equal(run('--git-dir=' + bare, 'rev-parse', '_meta'), committed, 'recovery must not create another Git commit')
  } finally {
    await new Promise<void>(r => server.close(() => r()))
    rmSync(work, { recursive: true, force: true })
  }
})
