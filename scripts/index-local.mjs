// Drive the real SQLite DO inside workerd via a local git smart HTTP server.
import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import assert from 'node:assert/strict'
const base = resolve('.tmp'); mkdirSync(base,{ recursive:true }); process.env.TMPDIR = base
const dir = mkdtempSync(join(base,'worker-fixture-'))
const git = (...args) => execFileSync('git',args,{cwd:dir,encoding:'utf8'}).trim()
const write = (path,value) => { mkdirSync(dirname(join(dir,path)),{recursive:true}); writeFileSync(join(dir,path),value) }
git('init','-b','main')
write('src/index.ts','// Repository index\nexport function SparseIndex() {\n  return "hello world"\n}\n')
write('src/store.rs','pub struct RepoIndex {}\npub fn search(query: &str) {}\n')
write('src/search.ts','export function search(query: string) {\n  return query.toLowerCase()\n}\n')
write('README.md','# Repo index\nSearch every indexed branch and tag.\n')
const large = process.argv.includes('--large')
if (large) {
  // 16MB text + 6MB incompressible binary, 94 commits: the stated Worker-size
  // envelope. Text is kept under the 512KB per-blob search limit.
  for (let i=0;i<64;i++) write(`data/part-${i}.ts`, `// ${i}\n` + ('export const sparse = "hello world";\n'.repeat(7600)).slice(0,256*1024))
  for (let i=0;i<6;i++) write(`assets/${i}.bin`, randomBytes(1024*1024))
}
const commit = (message) => { git('add','.'); git('-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-m',message) }
commit('Initial index fixture')
const first = git('rev-parse','HEAD'); git('-c','tag.gpgsign=false','tag','v1')
if (large) for (let i=1;i<94;i++) { write('progress.txt',`commit ${i}\n`); commit(`Progress ${i}`) }
const tip = git('rev-parse','HEAD')
let requests = 0
const server = createServer((req,res) => {
  requests++
  const advertise = req.url.startsWith('/repo.git/info/refs')
  if (!advertise && !req.url.startsWith('/repo.git/git-upload-pack')) { res.writeHead(404).end(); return }
  res.setHeader('Content-Type',advertise ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-upload-pack-result')
  if (advertise) res.write('001e# service=git-upload-pack\n0000')
  const child = spawn('git',['-c','uploadpack.allowAnySHA1InWant=true','upload-pack','--stateless-rpc',...(advertise ? ['--advertise-refs'] : []),dir],{stdio:['pipe','pipe','pipe']})
  req.pipe(child.stdin); child.stdout.pipe(res); child.stderr.resume()
})
await new Promise((r) => server.listen(0,'127.0.0.1',r))
const remote = `http://127.0.0.1:${server.address().port}/repo.git`
const file = join(base,'index-test-worker.mjs')
await build({entryPoints:['scripts/index-test-worker.ts'],outfile:file,bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers','node:*'],conditions:['workerd','browser']})
const mf = new Miniflare(convertV4MiniflareOptions({ inspectorPort:0, resourceTmpPath:base,resourcePersistencePath:mkdtempSync(join(base,'do-state-')), modules:true,scriptPath:file,compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],durableObjects:{REPO_INDEX:{className:'TestRepoIndex',useSQLite:true}},unsafeModuleFallbackService:undefined }))

let heapPeak = 0, backingPeak = 0, sampler, socket
if (process.argv.includes('--heap')) {
  await mf.ready
  const inspector = await mf.getInspectorURL()
  const list = new URL('/json',inspector); list.protocol = 'http:'
  const targets = await (await fetch(list)).json()
  socket = new WebSocket(targets[0].webSocketDebuggerUrl)
  await new Promise((r,j) => { socket.addEventListener('open',r,{once:true}); socket.addEventListener('error',j,{once:true}) })
  let id = 1
  socket.addEventListener('message',(e) => { const r=JSON.parse(e.data).result; if (r?.usedSize !== undefined) { heapPeak=Math.max(heapPeak,r.usedSize); backingPeak=Math.max(backingPeak,r.backingStorageSize ?? 0) } })
  sampler=setInterval(()=>socket.send(JSON.stringify({id:id++,method:'Runtime.getHeapUsage'})),50)
}
const start = performance.now(); let rounds = 0, result
try {
  do {
    const r = await mf.dispatchFetch('http://localhost/index',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:remote})})
    if (!r.ok) throw new Error(await r.text())
    result = await r.json(); rounds++; if (rounds % 10 === 0) console.log({ rounds, pending:result.pending })
    if (rounds > 1000) throw new Error('backfill did not finish')
  } while (!result.done)
  const indexedMs = performance.now() - start
  const measure = async (q) => { const t = performance.now(); const r = await mf.dispatchFetch(`http://localhost/search?q=${encodeURIComponent(q)}`); const data = await r.json(); return {ms:performance.now()-t,data} }
  const beforeRequests = requests
  const firstSearch = await measure('sparse NOT path:data'), cachedSearch = await measure('sparse NOT path:data')
  assert.equal(firstSearch.data.hits[0].path,'src/index.ts'); assert.equal(firstSearch.data.hits[0].lines[0].line,2)
  assert.equal((await measure('symbol:search language:rust')).data.hits[0].path,'src/store.rs')
  assert.equal((await measure('Progress ref:v1')).data.count,0)
  assert.equal(requests,beforeRequests,'indexed searches must not call git')
  writeFileSync(join(base,'fixture-search.json'),JSON.stringify(firstSearch.data,null,2))
  const evidence = {large,indexedMs,firstSearchMs:firstSearch.ms,indexedSearchMs:cachedSearch.ms,rounds,gitRequests:requests,counts:result.counts,workerMemory:'Local workerd completed without allocation failures; production limits need live preview',sampledHeapPeakBytes:heapPeak,sampledBackingPeakBytes:backingPeak}
  writeFileSync(join(base,large ? 'index-large-timings.json':'index-timings.json'),JSON.stringify(evidence,null,2)); console.log(evidence)
  if (process.argv.includes('--serve')) {
    const proxy = createServer(async (req,res) => { const r=await mf.dispatchFetch(`http://localhost${req.url}`); res.writeHead(r.status,{'content-type':'application/json'}); res.end(await r.text()) })
    await new Promise((r) => proxy.listen(8799,'127.0.0.1',r)); console.log('SQLite DO search fixture listening on 8799')
    await new Promise((r) => { process.once('SIGINT',r); process.once('SIGTERM',r) }); await new Promise((r) => proxy.close(r))
  }
} finally { clearInterval(sampler); socket?.close(); await mf.dispose(); await new Promise((r) => server.close(r)) }
