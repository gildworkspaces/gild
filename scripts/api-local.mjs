import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { randomBytes, createHmac } from 'node:crypto'
import { build } from 'esbuild'
import { Octokit } from '@octokit/rest'
import assert from 'node:assert/strict'
import { celldRuntime, startCelld } from './celld-runtime.mjs'
const root = resolve('.tmp')
mkdirSync(root, { recursive: true })
process.env.TMPDIR = root
const work = mkdtempSync(join(root, 'api-e2e-')),
  fixture = join(work, 'repo')
mkdirSync(fixture)
await build({ entryPoints: ['lib/api/client.ts'], outfile: join(work, 'api-client.mjs'), bundle: true, platform: 'node', format: 'esm' })
const { GildClient } = await import(join(work, 'api-client.mjs'))
const git = (...args) =>
    execFileSync('git', args, { cwd: fixture, encoding: 'utf8' }).trim(),
  write = (path, data) => {
    mkdirSync(dirname(join(fixture, path)), { recursive: true })
    writeFileSync(join(fixture, path), data)
  }
const commit = (message) => {
  git('add', '.')
  git('-c', 'commit.gpgsign=false', 'commit', '-m', message)
  return git('rev-parse', 'HEAD')
}
git('init', '-b', 'main')
git('config', 'receive.denyCurrentBranch', 'ignore')
write('README.md', '# API fixture\n')
write('src/main.ts', 'export function greet() { return "hello" }\n')
write('binary.dat', Buffer.from([0, 255, 3, 10]))
write(
  '.github/workflows/ci.yml',
  'name: API fixture\non: [push, workflow_dispatch, pull_request]\njobs:\n  test:\n    runs-on: [self-hosted]\n    steps:\n      - name: Echo\n        run: echo hello\n',
)
const base = commit('Initial fixture')
git('branch', 'feature')
git('switch', 'feature')
write('src/main.ts', 'export function greet() { return "hello v1" }\n')
const head = commit('Feature fixture')
git('branch', 'topic/with-slash')
if(process.argv.includes('--prepared-pagination')){
  git('switch','-c','zz-late-feature')
  write('src/main.ts','export function greet() { return "hello v2" }\n')
  commit('Late preparation fixture')
  for(let i=0;i<205;i++)git('branch','z-page-'+String(i).padStart(3,'0'),head)
}

git('switch', '--orphan', '_meta')
const now = new Date().toISOString(),
  issue = {
    schema: 1,
    number: 1,
    title: 'Seed issue',
    body: 'Initial issue',
    author: 'acme',
    createdAt: now,
    state: 'open',
    labels: ['bug'],
    claim: null,
  },
  pull = {
    schema: 1,
    number: 2,
    title: 'Seed PR',
    body: 'Initial pull',
    author: 'worker',
    createdAt: now,
    head: 'feature',
    base: 'main',
    state: 'open',
  }
write('.gild/next', '3\n')
write(
  '.gild/acl.json',
  JSON.stringify({
    schema: 1,
    owners: ['@acme'],
    agents: { '@acme/bot': ['pr', 'review', 'queue'] },
  }),
)
write('.gild/1/issue/issue.json', JSON.stringify(issue))
write('.gild/2/pr/pr.json', JSON.stringify(pull))
write(
  '.gild/2/pr/r-1-fixture.json',
  JSON.stringify({
    id: 'fixture',
    author: 'acme',
    verdict: 'approve',
    body: 'LGTM',
    createdAt: now,
    headOid: head,
  }),
)
write(
  '.gild/index.json',
  JSON.stringify({
    schema: 1,
    issues: [{ ...issue, updatedAt: now, comments: 0 }],
    pulls: [
      {
        ...pull,
        updatedAt: now,
        comments: 0,
        approvals: ['acme'],
        changesRequested: [],
        conflicts: false,
      },
    ],
    queue: [],
  }),
)
if(process.argv.includes('--prepared-conversations')){
  const metadata=JSON.parse(readFileSync(join(fixture,'.gild/index.json'),'utf8'))
  for(let i=3;i<=131;i++){const item={...issue,number:i,title:'Paged issue '+i};write('.gild/'+i+'/issue/issue.json',JSON.stringify(item));metadata.issues.push({...item,updatedAt:now,comments:0})}
  for(let i=0;i<105;i++)write('.gild/1/issue/c-'+String(i).padStart(3,'0')+'.json',JSON.stringify({id:'reply-'+i,author:'acme',body:'Reply '+i,createdAt:now}))
  metadata.issues[0].comments=105
  write('.gild/2/pr/c-inline.json',JSON.stringify({id:'inline',author:'acme',body:'Actual inline',createdAt:now,path:'src/main.ts',line:1,side:'RIGHT',commit_id:head}))
  metadata.pulls[0].comments=1
  write('.gild/index.json',JSON.stringify(metadata))
}
if(process.argv.includes('--prepared-pagination')){
  const metadata=JSON.parse(readFileSync(join(fixture,'.gild/index.json'),'utf8'))
  metadata.pulls=Array.from({length:1101},(_,i)=>({...metadata.pulls[0],number:i+2,...(i===1100?{head:'zz-late-feature'}:{})}))
  write('.gild/index.json',JSON.stringify(metadata))
}
write('.gild/queue.json', '[]')
commit('Metadata fixture')
git('switch', 'main')
let gitRequests = 0
// Namespace records are observations of this disposable source server's
// successful creations, not a fixed repository list for every owner.
const inventories=new Map([['fixture-acme',new Map([['demo',{dir:fixture,info:{id:'fixture',name:'demo',description:'API fixture',default_branch:'main',created_at:new Date(0).toISOString(),updated_at:new Date(0).toISOString(),last_push_at:null}}]])]])
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://local'),
    advertise = url.pathname.endsWith('/info/refs'),
    service = advertise
      ? url.searchParams.get('service')
      : url.pathname.endsWith('/git-receive-pack')
        ? 'git-receive-pack'
        : 'git-upload-pack'
  if(url.pathname==='/repositories'&&req.method==='GET'){
    const inventory=inventories.get(url.searchParams.get('namespace'))
    if(!inventory){res.writeHead(404,{'content-type':'application/json'}).end(JSON.stringify({message:'Namespace not found'}));return}
    const rows=[...inventory.values()].filter(r=>existsSync(r.dir)).map(r=>r.info)
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(rows));return
  }
  if (url.pathname === '/repository' && req.method === 'GET') {
    const owner = url.searchParams.get('owner'), name = url.searchParams.get('name')
    const exists = (owner === 'acme' && name === 'demo') || existsSync(join(work, `${owner}-${name}.git`))
    res.writeHead(exists ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify({ name }))
    return
  }
  if (url.pathname === '/repository' && req.method === 'POST') {
    const owner = url.searchParams.get('owner'),
      name = url.searchParams.get('name'),
      dir = join(work, `${owner}-${name}.git`)
    try {
      execFileSync('git', ['init', '--bare', dir], { stdio: 'pipe' })
      const namespace='fixture-'+owner,inventory=inventories.get(namespace)??new Map()
      inventory.set(name,{dir,info:{id:name,name,description:url.searchParams.get('description'),default_branch:'main',created_at:new Date().toISOString(),updated_at:new Date().toISOString(),last_push_at:null}})
      inventories.set(namespace,inventory)

      res.writeHead(201, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: name,
          name,
          description: url.searchParams.get('description'),
          default_branch: 'main',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          last_push_at: null,
        }),
      )
    } catch {
      res.writeHead(409).end()
    }
    return
  }
  const repoDir = url.pathname.startsWith('/repo.git/')
    ? fixture
    : join(work, url.pathname.split('/')[1])
  if (
    !url.pathname.endsWith('/info/refs') &&
    !url.pathname.endsWith('/git-upload-pack') &&
    !url.pathname.endsWith('/git-receive-pack')
  ) {
    res.writeHead(404).end()
    return
  }
  gitRequests++
  res.setHeader(
    'content-type',
    `application/x-${service}-${advertise ? 'advertisement' : 'result'}`,
  )
  if (advertise)
    res.write(
      `${service === 'git-upload-pack' ? '001e' : '001f'}# service=${service}\n0000`,
    )
  const child = spawn(
    'git',
    [
      '-c',
      'uploadpack.allowAnySHA1InWant=true',
      service.slice(4),
      '--stateless-rpc',
      ...(advertise ? ['--advertise-refs'] : []),
      repoDir,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  req.pipe(child.stdin)
  child.stdout.pipe(res)
  child.stderr.resume()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const remote = `http://127.0.0.1:${server.address().port}/repo.git`
const entry = join(work, 'worker.mjs'),
  runtime = resolve('scripts/api-fixture/runtime.ts')
await build({
  entryPoints: ['scripts/api-test-worker.ts'],
  outfile: entry,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  conditions: ['workerd', 'browser'],
  target: 'es2022',
  external: ['cloudflare:workers', 'cloudflare:sockets', 'node:*'],
  plugins: [
    {
      name: 'fixture-transport',
      setup(b) {
        b.onResolve(
          {
            filter:
              /(?:^@opennextjs\/cloudflare$|(?:^|\/)(artifacts|repo-index|backend)(?:\.ts)?$)/,
          },
          (args) => ({ path: runtime }),
        )
        b.onResolve({filter:/^next\/server$/},()=>({path:resolve('node_modules/next/dist/server/web/spec-extension/response.js')}))
        b.onResolve({ filter: /^next\/headers$/ }, () => ({
          path: resolve('scripts/api-fixture/headers.ts'),
        }))
      },
    },
  ],
})
const wrapper = join(work, 'entry.ts')
writeFileSync(
  wrapper,
  `import wasm from ${JSON.stringify(resolve('cqx/core.wasm'))}; globalThis.__cqxWasm=wasm; export {default,TestRepoIndex,TestRunQueue,TestApiControl,TestForgeEvents,RunnerPool,RepoImport,RepoChannel} from './worker.mjs';`,
)
const config = join(work, 'wrangler.json'),
  state = join(work, 'state')
writeFileSync(
  config,
  JSON.stringify({
    name: 'gild-api-fixture',
    main: wrapper,
    compatibility_date: '2026-10-01',
    compatibility_flags: ['nodejs_compat'],
    send_metrics: false,
    vars: { FIXTURE_REMOTE: remote, PRIVACY_FIXTURE:process.argv.includes('--privacy')?'enabled':'', ACTIONS_SECRET_KEY: randomBytes(32).toString('base64'), ARTIFACTS_TOKEN: 'local-fixture-credential' },
    r2_buckets: [{binding:'FRAGMENTS',bucket_name:'push-staging-fixture'}],
    durable_objects: {
      bindings: [
        { name: 'REPO_INDEX', class_name: 'TestRepoIndex' },
        { name: 'RUN_QUEUE', class_name: 'TestRunQueue' },
        { name: 'RUNNER_POOL', class_name: 'RunnerPool' },
        { name: 'REPO_IMPORT', class_name: 'RepoImport' },
        { name: 'API_CONTROL', class_name: 'TestApiControl' },
        { name: 'EVENTS', class_name: 'TestForgeEvents' },
        { name: 'REPO_CHANNEL', class_name: 'RepoChannel' },
      ],
    },
    migrations: [
      {
        tag: 'v1',
        new_sqlite_classes: [
          'TestRepoIndex',
          'TestRunQueue',
          'RunnerPool',
          'RepoImport',
          'TestApiControl',
          'TestForgeEvents',
          'RepoChannel',
        ],
      },
    ],
    queues: {
      producers: [{ binding: 'WEBHOOKS', queue: 'gild-webhooks-fixture' }],
      consumers: [
        {
          queue: 'gild-webhooks-fixture',
          max_batch_timeout: 1,
          max_retries: 7,
        },
      ],
    },
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'api-fixture',
        database_id: '00000000-0000-0000-0000-000000000001',
      },
      {
        binding: 'SEARCH_DB',
        database_name: 'search-fixture',
        database_id: '00000000-0000-0000-0000-000000000002',
      },
    ],
  }),
)
const schema = join(work, 'schema.sql')
writeFileSync(
  schema,
  (await import('node:fs/promises')).readdir
    ? (await (await import('node:fs/promises')).readdir('migrations'))
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((f) => readFileSync('migrations/' + f, 'utf8'))
        .join('\n')
    : '',
)
if (!celldRuntime) execFileSync(
  resolve('node_modules/.bin/wrangler'),
  [
    'd1',
    'execute',
    'api-fixture',
    '--local',
    '--config',
    config,
    '--persist-to',
    state,
    '--file',
    schema,
  ],
  { stdio: 'pipe' },
)
const searchSchema = join(work, 'search-schema.sql')
writeFileSync(searchSchema, readdirSync('migrations-search').filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync('migrations-search/' + f, 'utf8')).join('\n'))
if (!celldRuntime) execFileSync(
  resolve('node_modules/.bin/wrangler'),
  ['d1', 'execute', 'search-fixture', '--local', '--config', config, '--persist-to', state, '--file', searchSchema],
  { stdio: 'pipe' },
)
const portServer = createServer()
await new Promise((r) => portServer.listen(0, '127.0.0.1', r))
const port = portServer.address().port
await new Promise((r) => portServer.close(r))
const origin = `http://127.0.0.1:${port}`
const worker = celldRuntime ? await startCelld({ config, port, schema, database: 'api-fixture' }) : spawn(
  resolve('node_modules/.bin/wrangler'),
  [
    'dev',
    '--inspector-port','0',
    '--local',
    '--config',
    config,
    '--persist-to',
    state,
    '--port',
    String(port),
  ],
  { env: {...process.env, WRANGLER_REGISTRY_PATH: join(work,'registry')}, stdio: ['ignore', 'pipe', 'pipe'] },
)
let logs = ''
worker.stdout.on('data', (b) => {
  logs += b
  writeFileSync(join(work, 'wrangler.log'), logs)
})
worker.stderr.on('data', (b) => {
  logs += b
  writeFileSync(join(work, 'wrangler.log'), logs)
})
const received = [],
  counts = new Map()
const receiver = createServer(async (req, res) => {
  let body = ''
  for await (const b of req) body += b
  const id = req.headers['x-gild-delivery'],
    count = (counts.get(id) ?? 0) + 1
  counts.set(id, count)
  received.push({ id, headers: req.headers, body, at: Date.now() })
  res
    .writeHead(
      req.url === '/fail'
        ? 500
        : req.url === '/retry' && count === 1
          ? 503
          : 200,
    )
    .end('receiver result')
})
await new Promise((r) => receiver.listen(0, '127.0.0.1', r))
const token = 'gf_' + randomBytes(16).toString('hex'),
  auth = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  },
  request = async (path, method = 'GET', body, headers = {}) => {
    const response = await fetch(origin + path, {
      method,
      headers: { ...auth, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    // Many assertions inspect only status. Drain finite responses so hundreds
    // of real RPC/HTTP probes do not leave unconsumed local proxy sockets.
    if(response.headers.get('content-type')?.startsWith('text/event-stream'))return response
    const bytes=response.body?await response.arrayBuffer():null
    return new Response(bytes,{status:response.status,statusText:response.statusText,headers:response.headers})
  }
try {
  for (let i = 0; i < 100; i++) {
    if (worker.exitCode !== null) throw new Error(logs)
    try {
      await fetch(origin + '/api/v1/openapi.json')
      break
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  const seeded = await request('/fixture', 'POST', {
    url: remote,
    token,
    sha: base,
  })
  assert.equal(seeded.status, 200, await seeded.text())
  let preparedCovered=[]
  if(!process.argv.some(arg=>['--channel','--orchestrator','--privacy','--prepared-pagination','--prepared-content','--prepared-conversations'].includes(arg))) {
    const {preparedReadHTTP}=await import('./prepared-read-http.mjs')
    preparedCovered=await preparedReadHTTP({GildClient,origin,token,request,gitReads:()=>gitRequests})
  }
  if(process.argv.includes('--prepared-conversations')) {
    assert.equal((await request('/prepared-reads-fixture','POST',{})).status,200)
    const producer=await request('/prepared-conversation-fixture','POST',{})
    assert.equal(producer.status,200,await producer.clone().text());const evidence=await producer.json()
    assert.equal(evidence.counts.threads,131);assert.equal(evidence.counts.comments,106);assert.equal(evidence.counts.reviews,1)
    assert.ok(evidence.producerTrace.length>=3);for(const call of evidence.producerTrace)assert.ok(call.after-call.before<=100,'each actual producer call stages at most100 total rows')
    const before=gitRequests
    const late=await request('/api/v1/repos/acme/demo/issues?state=all&direction=asc&per_page=100&page=2')
    assert.equal(late.status,200,await late.clone().text());const items=await late.json()
    assert.equal(items.length,31);assert.equal(items.at(-1).title,'Paged issue 131')
    const issueResponse=await request('/api/v1/repos/acme/demo/issues/1')
    assert.equal(issueResponse.status,200);assert.equal((await issueResponse.json()).comments,105)
    const replies=await request('/api/v1/repos/acme/demo/issues/1/comments?per_page=100&page=2')
    assert.equal(replies.status,200);const replyData=await replies.json();assert.equal(replyData.length,5);assert.equal(replyData[0].body,'Reply 100')
    const pullResponse=await request('/api/v1/repos/acme/demo/pulls/2')
    assert.equal(pullResponse.status,200,await pullResponse.clone().text());assert.equal((await pullResponse.json()).head.sha,head)
    const pulls=await request('/api/v1/repos/acme/demo/pulls');assert.equal(pulls.status,200);assert.equal((await pulls.json()).length,1)
    const inline=await request('/api/v1/repos/acme/demo/pulls/2/comments');assert.equal(inline.status,200);assert.equal((await inline.json())[0].body,'Actual inline')
    const review=await request('/api/v1/repos/acme/demo/pulls/2/reviews');assert.equal(review.status,200);assert.equal((await review.json())[0].state,'APPROVED')
    assert.equal((await request('/api/v1/repos/acme/demo/issues/999')).status,404)
    assert.equal(gitRequests,before,'all seven conversation GETs must use prepared data without Git')
    await request('/prepared-conversation-pending-fixture','POST',{})
    const pending=await request('/api/v1/repos/acme/demo/issues')
    assert.equal(pending.status,503);assert.equal((await pending.json()).errors[0].code,'PREPARATION_PENDING');assert.equal(gitRequests,before)
    writeFileSync(join(root,'prepared-conversation-http.json'),JSON.stringify({work,evidence,items,replyData,gitReadsOnGET:0},null,2))
    console.log('PASS actual background conversation producer and seven registered GETs; second inventory/child pages, actual inline/review facts, unknown404, typedPending and zero Git')
  } else if(process.argv.includes('--prepared-content')) {
    assert.equal((await request('/prepared-reads-fixture','POST',{})).status,200)
    const prepared=await request('/prepared-content-fixture','POST',{})
    assert.equal(prepared.status,200,await prepared.clone().text())
    const preparedEvidence=await prepared.json(),before=gitRequests
    const file=await request('/api/v1/repos/acme/demo/contents/README.md?ref=main')
    assert.equal(file.status,200,await file.clone().text())
    const text=await file.json();assert.equal(Buffer.from(text.content,'base64').toString(),'# API fixture\n')
    const binaryResponse=await request('/api/v1/repos/acme/demo/contents/binary.dat?ref=main')
    assert.equal(binaryResponse.status,200,await binaryResponse.clone().text())
    const binary=await binaryResponse.json();assert.deepEqual(Buffer.from(binary.content,'base64'),Buffer.from([0,255,3,10]))
    const rootResponse=await request('/api/v1/repos/acme/demo/contents?ref=main')
    assert.equal(rootResponse.status,200);assert.ok((await rootResponse.json()).some(e=>e.name==='README.md'))
    const blobResponse=await request('/api/v1/repos/acme/demo/git/blobs/'+binary.sha)
    assert.equal(blobResponse.status,200);assert.equal((await blobResponse.json()).content,binary.content)
    const treeResponse=await request('/api/v1/repos/acme/demo/git/trees/main?recursive=1')
    assert.equal(treeResponse.status,200);assert.ok((await treeResponse.json()).tree.some(e=>e.path==='src/main.ts'))
    assert.equal((await request('/api/v1/repos/acme/demo/contents/absent.txt?ref=main')).status,404)
    assert.equal(gitRequests,before,'all actual content/tree/blob GETs use prepared data without Git')
    await request('/prepared-content-pending-fixture','POST',{})
    const pending=await request('/api/v1/repos/acme/demo/contents/README.md?ref=main')
    assert.equal(pending.status,503);assert.equal((await pending.json()).errors[0].code,'PREPARATION_PENDING')
    assert.equal(pending.headers.get('retry-after'),'1');assert.equal(gitRequests,before,'missing preparation must not start Git')
    const legacy=await request('/prepared-content-legacy-fixture','POST',{})
    assert.equal(legacy.status,200);assert.equal((await legacy.json()).rawBytesPresent,false)
    assert.equal((await request('/api/v1/repos/acme/demo/contents/binary.dat?ref=main')).status,503)
    assert.equal(gitRequests,before,'legacy missing byte GET stays fast without hydration')
    const recovered=await request('/prepared-content-fixture','POST',{})
    assert.equal(recovered.status,200,await recovered.clone().text())
    const recoveryEvidence=await recovered.json(),afterBackground=gitRequests
    const recoveredFile=await request('/api/v1/repos/acme/demo/contents/binary.dat?ref=main')
    assert.equal(recoveredFile.status,200,await recoveredFile.clone().text())
    assert.equal((await recoveredFile.json()).content,binary.content);assert.equal(gitRequests,afterBackground)
    writeFileSync(join(root,'prepared-content-http.json'),JSON.stringify({work,preparedEvidence,recoveryEvidence,text,binary,gitReadsOnGET:0,legacyRecoveryGitReads:afterBackground-before},null,2))
    console.log('PASS actual background content producer and registered content/tree/blob GETs; exact text/binary bytes, absent404, typedPending and zero Git')
  } else if(process.argv.includes('--prepared-pagination')) {
    assert.equal((await request('/prepared-reads-fixture','POST',{})).status,200)
    const probe=await request('/prepared-pagination-fixture','POST',{})
    assert.equal(probe.status,200,await probe.clone().text())
    const evidence=await probe.json()
    writeFileSync(join(root,'prepared-pagination-probe.json'),JSON.stringify({work,evidence},null,2))
    assert.equal(evidence.blocked.refs,0);assert.equal(evidence.blocked.pulls,0,'full queue must not skip source inputs')
    assert.equal(evidence.blocked.pending,99,'one real queued job drained without losing walk cursor')
    assert.equal(evidence.final.pulls,1101);assert.ok(evidence.producerCalls.length>10,'actual producer continues beyond first100')
    for(const call of evidence.producerCalls){const before=call.before??{refs:0,pulls:0};assert.ok(call.after.refs-before.refs+call.after.pulls-before.pulls<=100,'each actual producer continuation bounded100')}
    const before=gitRequests,response=await request('/api/v1/repos/acme/demo/pulls/1102/changes')
    assert.equal(response.status,200,await response.clone().text())
    const data=await response.json();assert.equal(data.files[0].path,'src/main.ts');assert.ok(data.files.some(f=>f.path==='src/main.ts'&&f.hunks.some(h=>h.lines.some(line=>line.includes('hello v2')))),'distinct later-head actual diff appears')
    assert.equal(gitRequests,before,'prepared later-pull GET must not touch Git')
    writeFileSync(join(root,'prepared-pagination-http.json'),JSON.stringify({work,evidence,data,gitReadsOnGET:gitRequests-before},null,2))
    console.log('PASS actual DO full-queue retry/continued preparation and prepared pull1102 GET without Git')
  } else if(process.argv.includes('--prepared-reads')) {
    assert.deepEqual(preparedCovered.sort(),['branches','commitChanges','health','healthAt','ownerRepoCards','publicDisplayProfile','pullChanges','ref','refs','viewerContext'])
  } else if(process.argv.includes('--channel')) {
    // The merge proof closed #1; the modal proof starts from an open issue.
  assert.equal((await request('/api/v1/repos/acme/demo/issues/1', 'PATCH', {state:'open'})).status, 200)
  const {channelSuite}=await import('./channel-check.mjs')
    await channelSuite({origin,request,work,token})
  } else if(process.argv.includes('--orchestrator')) {
    const {orchestratorSuite}=await import('./orchestrator-check.mjs')
    await orchestratorSuite({request,work,token})
  } else if(process.argv.includes('--privacy')) {
    const {privacySuite}=await import('./privacy-check.mjs')
    await privacySuite({origin,request,remote,token,git,write,commit,base,head,work,receiver,received,gitReads:()=>gitRequests})
  } else {
  const octokit = new Octokit({ auth: token, baseUrl: origin + '/api/v1' })
  const repos = await octokit.repos.listForAuthenticatedUser()
  assert.equal(repos.data[0].full_name, 'acme/demo')
  const content = await octokit.repos.getContent({
    owner: 'acme',
    repo: 'demo',
    path: 'README.md',
  })
  assert.equal(
    Buffer.from(content.data.content, 'base64').toString(),
    '# API fixture\n',
  )
  const typedClient = new GildClient(origin + '/api/v1', token)
  const slashCommit = await typedClient.request('commit', { owner: 'acme', repo: 'demo', sha: 'topic/with-slash' })
  assert.equal(slashCommit.sha, head)
  const slashCompare = await typedClient.request('compare', { owner: 'acme', repo: 'demo', base: 'main', head: 'topic/with-slash' })
  assert.equal(slashCompare.commits.at(-1).sha, head)
  const requestsBefore = gitRequests,
    start = performance.now()
  let r = await request(`/api/v1/repos/acme/demo/commits/${head}`)
  assert.equal(r.status, 200, await r.clone().text())
  const coldMs = performance.now() - start,
    etag = r.headers.get('etag')
  const warmStart = performance.now()
  r = await request(
    `/api/v1/repos/acme/demo/commits/${head}`,
    'GET',
    undefined,
    { 'if-none-match': etag },
  )
  assert.equal(r.status, 304)
  const cachedMs = performance.now() - warmStart
  assert.equal(
    gitRequests,
    requestsBefore,
    'indexed reads must not contact git',
  )
  const created = await octokit.issues.create({
    owner: 'acme',
    repo: 'demo',
    title: 'Octokit issue',
    body: 'Stored by the real metadata handler',
  })
  assert.equal(created.status, 201)
  assert.equal(
    JSON.parse(
      git('show', `_meta:.gild/${created.data.number}/issue/issue.json`),
    ).body,
    'Stored by the real metadata handler',
  )
  const pr = await octokit.pulls.create({
    owner: 'acme',
    repo: 'demo',
    title: 'Octokit PR',
    head: 'feature',
    base: 'main',
  })
  assert.equal(pr.status, 201)
  assert.equal(
    JSON.parse(git('show', `_meta:.gild/${pr.data.number}/pr/pr.json`)).head,
    'feature',
  )
  const spec = await (await request('/api/v1/openapi.json')).json()
  assert.equal(spec.openapi, '3.1.0')
  const samples = {
    repo: '/repos/acme/demo',
    branches: '/repos/acme/demo/branches',
    refs: '/repos/acme/demo/git/refs',
    ref: '/repos/acme/demo/git/ref/heads/main',
    commits: '/repos/acme/demo/commits',
    commit: `/repos/acme/demo/commits/${head}`,
    compare: `/repos/acme/demo/compare/${base}...${head}`,
    contentsRoot: '/repos/acme/demo/contents',
    contents: '/repos/acme/demo/contents/src/main.ts',
    tree: `/repos/acme/demo/git/trees/${head}?recursive=1`,
    blob: `/repos/acme/demo/git/blobs/${git('rev-parse', base + ':binary.dat')}`,
    issues: '/repos/acme/demo/issues',
    issue: '/repos/acme/demo/issues/1',
    issueComments: '/repos/acme/demo/issues/1/comments',
    labels: '/repos/acme/demo/labels',
    pulls: '/repos/acme/demo/pulls',
    pull: '/repos/acme/demo/pulls/2',
    pullFiles: '/repos/acme/demo/pulls/2/files',
    pullReviews: '/repos/acme/demo/pulls/2/reviews',
    pullComments: '/repos/acme/demo/pulls/2/comments',
    mergeQueue: '/repos/acme/demo/merge-queue',
    commitChanges: `/repos/acme/demo/changes/${head}`,
    pullChanges: '/repos/acme/demo/pulls/2/changes',
    health: '/repos/acme/demo/health',
    healthAt: `/repos/acme/demo/health/${head}`,
    searchCode: '/search/code?q=hello',
    tokens: '/user/tokens',
    agents: '/agents',
    agentRequests: '/agents/requests',
    repos: '/user/repos',
    ownerRepos: '/users/acme/repos',
    orgRepos: '/orgs/acme/repos',
    actionRuns: '/repos/acme/demo/actions/runs',
    actionRunners: '/repos/acme/demo/actions/runners',
  }
  const covered = new Set(['openapi', 'createIssue', 'createPull',...preparedCovered])
  // The typed client validates each real Worker response with its output schema.
  const exercise = async (id, params, body, client = typedClient) => {
    const data = await client.request(id, params, body)
    covered.add(id)
    return data
  }
  const starParams = { owner: 'acme', repo: 'demo' }
  assert.equal(await exercise('star', starParams), null)
  assert.equal(await exercise('star', starParams), null)
  assert.equal((await typedClient.request('repo', starParams)).stargazers_count, 1)
  assert.deepEqual((await exercise('stargazers', starParams)).map(u => u.login), ['acme'])
  for (const method of ['PUT', 'DELETE']) {
    assert.equal((await request('/api/v1/user/starred/acme/nonexistent', method)).status, 404)
    assert.equal((await request('/api/v1/user/starred/unknown/demo', method)).status, 404)
  }
  assert.deepEqual(await (await request('/star-rows-fixture')).json(), [{repo:'acme/demo',name:'acme'}], 'no orphan star rows')
  assert.equal(await exercise('unstar', starParams), null)
  assert.equal(await exercise('unstar', starParams), null)
  assert.equal((await typedClient.request('repo', starParams)).stargazers_count, 0)
  assert.deepEqual(await exercise('stargazers', starParams), [])
  console.log('Stars: PUT/DELETE/GET contract-validated production Worker responses; idempotent toggles, live counts, nonexistent repo/owner 404 with no orphan rows passed')
  for (const [id, path] of Object.entries(samples)) {
    const r = await request('/api/v1' + path)
    assert.equal(r.status, 200, `${id}: ${await r.clone().text()}`)
    covered.add(id)
  }
  for (const id of ['repo', 'ownerRepos', 'orgRepos', 'branches', 'refs', 'ref', 'commits', 'commit', 'compare', 'contentsRoot', 'contents', 'tree', 'blob', 'issues', 'issue', 'pulls', 'pull', 'searchCode']) {
    const response = await fetch(origin + '/api/v1' + samples[id], { headers: { 'cf-connecting-ip': '192.0.2.10' } })
    assert.equal(response.status, 200, `anonymous ${id}: ${await response.clone().text()}`)
  }
  assert.equal((await fetch(origin + '/api/v1/repos/acme/%ZZ/issues')).status, 400)
  const issuesToken = await (await request('/api/v1/user/tokens', 'POST', { label: 'issues-only', scopes: ['issues:write'] })).json()
  for (const repo of ['issues-app', 'pulls-x', 'actions-app', 'agents-app', 'orgs-app']) {
    const headers = { authorization: 'Bearer ' + issuesToken.token }
    assert.equal((await request(`/api/repos/acme/${repo}/actions/settings`, 'PUT', {}, headers)).status, 401)
    assert.equal((await request(`/api/repos/acme/${repo}/pulls`, 'POST', { title: 'forbidden' }, headers)).status, 401)
    assert.equal((await request('/api/v1/user/repos', 'POST', { name: repo }, headers)).status, 403)
  }
  const treeResult = await (
    await request(`/api/v1/repos/acme/demo/git/trees/${head}?recursive=1`)
  ).json()
  assert.ok(treeResult.tree.some((e) => e.path === 'src/main.ts'))
  const binary = await (
    await request(
      `/api/v1/repos/acme/demo/git/blobs/${git('rev-parse', base + ':binary.dat')}`,
    )
  ).json()
  assert.deepEqual(
    Buffer.from(binary.content, 'base64'),
    Buffer.from([0, 255, 3, 10]),
  )
  r = await request('/api/v1/repos/acme/demo/issues/1', 'PATCH', {
    title: 'Updated via v1',
    body: 'Changed',
  })
  assert.equal(r.status, 200, await r.clone().text())
  assert.equal(
    JSON.parse(git('show', '_meta:.gild/1/issue/issue.json')).title,
    'Updated via v1',
  )
  covered.add('updateIssue')
  r = await request('/api/v1/repos/acme/demo/pulls/2', 'PATCH', {
    title: 'Updated PR',
    body: 'Fixes #1',
  })
  assert.equal(r.status, 200, await r.clone().text())
  covered.add('updatePull')
  r = await request('/api/v1/repos/acme/demo/issues/1/comments', 'POST', {
    body: 'A comment',
  })
  assert.equal(r.status, 201, await r.clone().text())
  covered.add('createIssueComment')
  r = await request('/api/v1/repos/acme/demo/pulls/2/comments', 'POST', {
    body: 'Inline note',
    path: 'src/main.ts',
    line: 1,
    commit_id: head,
  })
  assert.equal(r.status, 201, await r.clone().text())
  covered.add('createPullComment')
  r = await request('/api/v1/repos/acme/demo/pulls/2/reviews', 'POST', {
    event: 'APPROVE',
    body: 'Reviewed',
  })
  assert.equal(r.status, 201, await r.clone().text())
  covered.add('createReview')
  r = await request('/api/v1/repos/acme/demo/pulls/2/merge', 'PUT', {}, { 'idempotency-key': 'merge-once' })
  assert.equal(r.status, 202, await r.clone().text())
  assert.equal((await r.json()).merged, false)
  // Asynchronous, but it must land: the queue drains after the response
  // (before 10 Oct an API merge stayed queued forever).
  // The queue pushes main, then records the merge in _meta: wait for both.
  const pullState = () => JSON.parse(git('show', '_meta:.gild/2/pr/pr.json')).state
  for (let i = 0; i < 150 && pullState() !== 'merged'; i++)
    await new Promise((done) => setTimeout(done, 200))
  assert.notEqual(git('rev-parse', 'main'), base, 'the API merge never landed')
  assert.equal(
    JSON.parse(git('show', '_meta:.gild/2/pr/pr.json')).state,
    'merged',
  )
  // "Fixes #1" in the PR body closes issue 1 when it merges.
  assert.equal(
    JSON.parse(git('show', '_meta:.gild/1/issue/issue.json')).state,
    'closed',
  )
  covered.add('mergePull')
  const mergeReplay = await request('/api/v1/repos/acme/demo/pulls/2/merge', 'PUT', {}, { 'idempotency-key': 'merge-once' })
  assert.equal(mergeReplay.status, 202)
  assert.equal(mergeReplay.headers.get('idempotency-replayed'), 'true')
  r = await request('/api/v1/user/tokens', 'POST', {
    label: 'Read only',
    scopes: ['repo:read'],
    repos: ['acme/demo'],
  })
  assert.equal(r.status, 201, await r.clone().text())
  const restricted = await r.json()
  covered.add('createToken')
  assert.equal(
    (
      await request(
        '/api/v1/repos/acme/demo/issues',
        'POST',
        { title: 'Forbidden' },
        { authorization: `Bearer ${restricted.token}` },
      )
    ).status,
    403,
  )
  assert.equal(
    (
      await request('/api/v1/repos/acme/other', 'GET', undefined, {
        authorization: `Bearer ${restricted.token}`,
      })
    ).status,
    404,
  )
  r = await request('/api/v1/user/tokens/' + restricted.id, 'DELETE')
  assert.equal(r.status, 200)
  covered.add('deleteToken')
  r = await request('/api/v1/agents/disposable', 'DELETE')
  assert.equal(r.status, 200)
  covered.add('deleteAgent')
  r = await request('/api/v1/agents/requests', 'POST', {
    sponsor: 'acme',
    label: 'requested',
    publicKey: 'ed25519:fixture',
    repo: 'acme/demo',
    grants: ['pr'],
  })
  assert.equal(r.status, 201, await r.clone().text())
  const joinRequest = await r.json()
  covered.add('createAgentRequest')
  r = await request('/api/v1/agents/requests/' + joinRequest.id, 'PATCH', {
    decision: 'approve',
    grants: ['pr'],
  })
  assert.equal(r.status, 200, await r.clone().text())
  covered.add('decideAgentRequest')
  const beforeActions = await request('/drain'),
    overview = await beforeActions.json()
  assert.ok(overview.runs.length)
  const runId = overview.runs[0].id
  for (const [id, path] of [
    ['actionRun', `/actions/runs/${runId}`],
    ['actionJobs', `/actions/runs/${runId}/jobs`],
    ['actionLogs', `/actions/runs/${runId}/logs`],
  ]) {
    r = await request('/api/v1/repos/acme/demo' + path)
    assert.equal(r.status, 200, `${id}: ${await r.clone().text()}`)
    covered.add(id)
  }
  const jobs = await (
    await request(`/api/v1/repos/acme/demo/actions/runs/${runId}/jobs`)
  ).json()
  assert.ok(jobs.jobs.length)
  r = await request(`/api/v1/repos/acme/demo/actions/jobs/${jobs.jobs[0].id}`)
  assert.equal(r.status, 200, await r.clone().text())
  covered.add('actionJob')
  r = await request('/api/v1/repos/acme/demo/actions/runners', 'POST', {
    name: 'fixture',
    os: process.platform,
    arch: process.arch,
    labels: [],
  })
  assert.equal(r.status, 201, await r.clone().text())
  const machine = await r.json()
  covered.add('actionRegister')
  const repoParams = { owner: 'acme', repo: 'demo', runner: machine.id }
  const registration = await exercise('actionRegistration', repoParams)
  const registeredOnce = await new GildClient(origin + '/api/v1', registration.token).request('actionRegister', repoParams, { name: 'one-time', os: process.platform, arch: process.arch, labels: [] })
  await typedClient.request('actionRemove', { ...repoParams, runner: registeredOnce.id })
  await assert.rejects(new GildClient(origin + '/api/v1', registration.token).request('actionRegister', repoParams, { name: 'reuse', os: process.platform, arch: process.arch, labels: [] }), e => e.status === 401)
  await exercise('actionPatch', repoParams, { labels: ['contract-tested'] })
  const patchedRunners = await typedClient.request('actionRunners', repoParams)
  assert.ok(patchedRunners.runners.find(r => r.gild_id === machine.id).labels.some(l => l.name === 'contract-tested'))
  const machineAuth = { authorization: `Bearer ${machine.token}` }
  r = await request(
    '/api/v1/repos/acme/demo/actions/runners/poll',
    'POST',
    { wait: 0 },
    machineAuth,
  )
  assert.equal(r.status, 200, await r.clone().text())
  const assignment = (await r.json()).job
  assert.ok(assignment)
  covered.add('runnerPoll')
  const assigned = { job: assignment.job, lease: assignment.lease }
  for (const [id, path, input] of [
    ['runnerHeartbeat', 'heartbeat', assigned],
    [
      'runnerStep',
      'step',
      { ...assigned, step: 0, status: 'running', exit: null },
    ],
    [
      'runnerLogs',
      'logs',
      { ...assigned, step: 0, batch: 0, lines: ['hello from v1'] },
    ],
    [
      'runnerStep',
      'step',
      { ...assigned, step: 0, status: 'success', exit: 0 },
    ],
    [
      'runnerFinish',
      'finish',
      { ...assigned, status: 'success', reason: null },
    ],
  ]) {
    r = await request(
      '/api/v1/repos/acme/demo/actions/runners/' + path,
      'POST',
      input,
      machineAuth,
    )
    assert.equal(r.status, 200, `${id}: ${await r.clone().text()}`)
    covered.add(id)
  }
  const recentJobs = await exercise('actionRunnerJobs', repoParams)
  assert.ok(recentJobs.jobs.some(j => j.job === assignment.job && j.status === 'success'))
  const approvalResponse = await request('/approval-fixture', 'POST', { run: runId })
  assert.equal(approvalResponse.status, 200, await approvalResponse.clone().text())
  const { id: approvalRun, job: approvalJob } = await approvalResponse.json()
  assert.ok(!(await (await request('/ready-fixture')).json()).some(j => j.job === approvalJob))
  await exercise('actionApprove', { ...repoParams, run: approvalRun })
  assert.ok((await (await request('/ready-fixture')).json()).some(j => j.job === approvalJob), 'approval makes the gated run ready')
  await typedClient.request('actionCancel', { ...repoParams, run: approvalRun })
  r = await request(
    `/api/v1/repos/acme/demo/actions/runs/${runId}/rerun`,
    'POST',
    {},
  )
  assert.equal(r.status, 201, await r.clone().text())
  const rerun = await r.json()
  covered.add('actionRerun')
  r = await request(
    `/api/v1/repos/acme/demo/actions/runs/${rerun.id}/cancel`,
    'POST',
    {},
  )
  assert.equal(r.status, 200, await r.clone().text())
  covered.add('actionCancel')
  r = await request(
    '/api/v1/repos/acme/demo/actions/workflows/ci.yml/dispatches',
    'POST',
    { ref: 'main' },
  )
  assert.equal(r.status, 201, await r.clone().text())
  covered.add('actionDispatch')
  r = await request(
    '/api/v1/repos/acme/demo/actions/runners/' + machine.id,
    'DELETE',
  )
  assert.equal(r.status, 200)
  covered.add('actionRemove')
  r = await request('/api/v1/user/repos', 'POST', {
    name: 'created',
    description: 'Created through v1',
  })
  assert.equal(r.status, 201, await r.clone().text())
  covered.add('createRepository')
  assert.equal(
    execFileSync(
      'git',
      ['--git-dir', join(work, 'acme-created.git'), 'show', '_meta:.gild/next'],
      { encoding: 'utf8' },
    ).trim(),
    '1',
  )
  r = await request('/api/v1/orgs', 'POST', {
    name: 'fixture-org',
    description: 'API org',
  })
  assert.equal(r.status, 201, await r.clone().text())
  covered.add('createOrg')
  r = await request('/api/v1/orgs')
  assert.equal(r.status, 200)
  assert.equal((await r.json())[0].name, 'fixture-org')
  covered.add('orgs')
  r = await request('/api/v1/orgs/fixture-org/repos', 'POST', {
    name: 'created',
  })
  assert.equal(r.status, 201, await r.clone().text())
  covered.add('createOrgRepository')
  r = await request('/api/v1/orgs/fixture-org/members', 'POST', {
    member: 'acme',
    role: 'owner',
  })
  assert.equal(r.status, 201, await r.clone().text())
  covered.add('addOrgMember')
  // Exercise both owner kinds through the same production pool/handler and D1.
  // Read back mutations before deleting the runner/group so dead writes fail.
  for (const [kind, owner, repo] of [['org', 'fixture-org', 'created'], ['user', 'acme', 'demo']]) {
    const prefix = kind + 'Pool', params = kind === 'org' ? { org: owner } : { name: owner }
    const op = (suffix, body, extra = {}, client = typedClient) => exercise(prefix + suffix, { ...params, ...extra }, body, client)
    const group = await op('CreateGroup', { name: 'Contract builds' })
    const groupParams = { group: group.id }
    assert.equal((await op('Group', undefined, groupParams)).name, 'Contract builds')
    assert.ok((await op('Groups')).runner_groups.some(g => g.id === group.id))
    const patched = await op('PatchGroup', { name: 'Renamed builds', visibility: 'selected', allow_public_repositories: true }, groupParams)
    assert.equal(patched.name, 'Renamed builds')
    assert.equal((await op('Group', undefined, groupParams)).allow_public_repositories, true)
    const repositories = async () => (await op('Repositories', undefined, groupParams)).repositories
    await op('AddRepository', {}, { ...groupParams, repo })
    assert.deepEqual(await repositories(), [`${owner}/${repo}`])
    await op('RemoveRepository', undefined, { ...groupParams, repo })
    assert.deepEqual(await repositories(), [])
    await op('PutRepositories', { repositories: [`${owner}/${repo}`] }, groupParams)
    assert.deepEqual(await repositories(), [`${owner}/${repo}`])
    await op('ClearRepositories', undefined, groupParams)
    assert.deepEqual(await repositories(), [])
    const registration = await op('Registration', { group: group.id })
    const registrationClient = new GildClient(origin + '/api/v1', registration.token)
    const data = { name: `${kind}-fixture`, os: process.platform, arch: process.arch, labels: [], group: group.id }
    const runner = await op('Register', data, {}, registrationClient)
    await assert.rejects(registrationClient.request(prefix + 'Register', params, data), e => e.status === 401)
    const runnerParams = { runner: runner.id }
    assert.ok((await op('Runners')).runners.some(r => r.gild_id === runner.id))
    const patchedRunner = await op('PatchRunner', { labels: ['contract-tested'], group: group.id }, runnerParams)
    assert.equal(patchedRunner.group, group.id)
    assert.ok(patchedRunner.labels.some(l => l.name === 'contract-tested'))
    assert.ok((await op('Runners')).runners.find(r => r.gild_id === runner.id).labels.some(l => l.name === 'contract-tested'))
    const poll = await op('Poll', { wait: 0 }, {}, new GildClient(origin + '/api/v1', runner.token))
    assert.equal(poll.job, null, 'empty selected group cannot lease a repository job')
    assert.deepEqual((await op('Recent', undefined, runnerParams)).jobs, [])
    await op('Remove', undefined, runnerParams)
    assert.ok(!(await op('Runners')).runners.some(r => r.gild_id === runner.id))
    await op('DeleteGroup', undefined, groupParams)
    assert.ok(!(await op('Groups')).runner_groups.some(g => g.id === group.id))
  }
  const cli = resolve(process.env.GILD_TEST_CLI_DIR || '../gild-cli'),
    identityDir = join(work, 'identity')
  mkdirSync(identityDir, { mode: 0o700 })
  writeFileSync(
    join(identityDir, 'identity.json'),
    JSON.stringify({
      schema: 1,
      name: 'acme',
      device: 'fixture',
      publicKey: 'fixture',
      secretKey: 'fixture',
      apiToken: { server: origin, token },
      createdAt: now,
    }),
    { mode: 0o600 },
  )
  const runCLI = async (...args) =>
    (
      await promisify(execFile)(
        'bun',
        [
          'src/gild.ts',
          '--config-dir',
          identityDir,
          ...args,
          '--server',
          origin,
        ],
        { cwd: cli, encoding: 'utf8' },
      )
    ).stdout
  assert.match(await runCLI('org', 'create', 'cli-org'), /created org @cli-org/)
  assert.match(await runCLI('org', 'list'), /@cli-org/)
  assert.match(
    await runCLI('repo', 'create', 'cli-created'),
    /created acme\/cli-created/,
  )
  assert.equal(
    execFileSync(
      'git',
      [
        '--git-dir',
        join(work, 'acme-cli-created.git'),
        'show',
        '_meta:.gild/next',
      ],
      { encoding: 'utf8' },
    ).trim(),
    '1',
  )
  for (const [id, path] of [
    ['org', '/orgs/fixture-org'],
    ['orgMembers', '/orgs/fixture-org/members'],
    ['agentRequest', '/agents/requests/' + joinRequest.id],
    ['repoAgents', '/repos/acme/demo/agents'],
    ['actionOverview', '/repos/acme/demo/actions'],
    ['actionCommitRuns', '/repos/acme/demo/actions/commits/' + base],
    ['actionSecrets', '/repos/acme/demo/actions/settings/secrets'],
  ]) {
    r = await request('/api/v1' + path)
    assert.equal(r.status, 200, `${id}: ${await r.clone().text()}`)
    covered.add(id)
  }
  for (const [id, path, method, body] of [
    ['updateAgent', '/agents/requested', 'PATCH', { approver: true }],
    [
      'setRepoAgent',
      '/repos/acme/demo/agents',
      'POST',
      { agent: 'acme/requested', grants: ['pr'] },
    ],
    [
      'claimIssue',
      '/repos/acme/demo/issues/1/claim',
      'POST',
      { action: 'claim' },
    ],
    ['dequeuePull', '/repos/acme/demo/merge-queue/2', 'DELETE', undefined],
    [
      'actionSettings',
      '/repos/acme/demo/actions/settings',
      'PUT',
      { required: ['ci.yml'] },
    ],
    [
      'actionPutSecret',
      '/repos/acme/demo/actions/settings/secrets/FIXTURE',
      'PUT',
      { value: 'generated-disposable-fixture' },
    ],
    [
      'actionDeleteSecret',
      '/repos/acme/demo/actions/settings/secrets/FIXTURE',
      'DELETE',
      undefined,
    ],
  ]) {
    r = await request('/api/v1' + path, method, body)
    assert.equal(r.status, 200, `${id}: ${await r.clone().text()}`)
    covered.add(id)
  }
  await request('/event-fixture', 'POST', {
    receiver: `http://127.0.0.1:${receiver.address().port}`,
  })
  const secret = randomBytes(32).toString('hex'),
    hookBase = '/api/v1/repos/acme/demo/hooks',
    bCovered = new Set(['events'])
  const eventually = async (fn) => {
    for (let i = 0; i < 150; i++) {
      const v = await fn()
      if (v) return v
      await new Promise((r) => setTimeout(r, 100))
    }
    throw Error('Timed out waiting for webhook')
  }
  const missingHook=await request(hookBase+'/999999');assert.equal(missingHook.status,404,await missingHook.clone().text())
  let repoHook, repoDelivery
  for (const [prefix, path] of [
    ['repo', hookBase],
    ['org', '/api/v1/orgs/fixture-org/hooks'],
  ]) {
    let response = await request(path, 'POST', {
      config: { url: 'https://receiver.example/retry', secret },
      events: ['issues', 'pull_request', 'health_changed'],
    })
    assert.equal(response.status, 201, await response.clone().text())
    const hook = await response.json()
    assert.equal(hook.config.secret, undefined)
    bCovered.add(prefix + 'CreateHook')
    for (const [id, url, method, body] of [
      [prefix + 'Hooks', path, 'GET'],
      [prefix + 'Hook', path + '/' + hook.id, 'GET'],
      [prefix + 'UpdateHook', path + '/' + hook.id, 'PATCH', { active: true }],
    ]) {
      response = await request(url, method, body)
      assert.equal(response.status, 200, await response.clone().text())
      bCovered.add(id)
    }
    const delivery = await eventually(async () => {
      const response = await request(path + '/' + hook.id + '/deliveries')
      if ([404, 503].includes(response.status)) {
        // Metadata pushes briefly make the production read boundary pending.
        await request('/drain-index')
        return false
      }
      assert.equal(response.status, 200, await response.clone().text())
      const rows = await response.json()
      if (rows.some((d) => d.error)) throw Error(rows[0].error)
      return rows.find((d) => d.status === 'success' && d.attempts === 2)
    })
    bCovered.add(prefix + 'HookDeliveries')
    const actual = received.filter((r) => r.id === delivery.guid)
    assert.equal(typeof delivery.id, 'number')
    assert.deepEqual(delivery.request.payload, JSON.parse(actual[0].body))
    assert.equal(delivery.request.wire, actual[0].body)
    assert.equal(actual.length, 2)
    assert.ok(
      actual[1].at - actual[0].at >= 4500,
      'Queue applies exponential backoff',
    )
    assert.equal(actual[0].body, actual[1].body)
    assert.equal(
      actual[0].headers['x-hub-signature-256'],
      'sha256=' +
        createHmac('sha256', secret).update(actual[0].headers['x-gild-timestamp'] + '.' + actual[0].body).digest('hex'),
    )
    assert.equal(
      actual[0].headers['x-gild-signature-256'],
      actual[0].headers['x-hub-signature-256'],
    )
    response = await request(
      path + '/' + hook.id + '/deliveries/' + delivery.id,
    )
    assert.equal(response.status, 200)
    bCovered.add(prefix + 'HookDelivery')
    response = await request(
      path + '/' + hook.id + '/deliveries/' + delivery.id + '/attempts',
      'POST',
      {},
    )
    assert.equal(response.status, 202)
    const redelivery = await response.json()
    assert.notEqual(redelivery.id, delivery.id)
    assert.notEqual(redelivery.guid, delivery.guid)
    bCovered.add(prefix + 'RedeliverHook')
    response = await request(path + '/' + hook.id + '/pings', 'POST', {})
    assert.equal(response.status, 202)
    bCovered.add(prefix + 'PingHook')
    if (prefix === 'org') {
      assert.equal((await request(path + '/' + hook.id, 'DELETE')).status, 200)
      bCovered.add(prefix + 'DeleteHook')
    } else {
      repoHook = hook
      repoDelivery = delivery
    }
  }
  await request('/flush-events')
  const eventsURL = '/api/v1/events?repos=acme/demo&since=0&wait=0',
    streamResponse = await request(eventsURL)
  assert.equal(streamResponse.status, 200, await streamResponse.clone().text())
  const stream = await streamResponse.json()
  assert.ok(
    stream.events.some(
      (e) => e.event === 'issues' && e.payload.action === 'opened',
    ),
  )
  assert.ok(
    stream.events.some(
      (e) => e.event === 'pull_request' && e.payload.action === 'opened',
    ),
  )
  assert.ok(stream.events.some((e) => e.event === 'pull_request_review'))
  assert.ok(stream.events.some((e) => e.event === 'issue_comment'))
  assert.ok(
    stream.events.some((e) => e.event === 'pull_request_review_comment'),
  )
  assert.ok(stream.events.some((e) => e.event === 'merge_queue'))
  assert.ok(stream.events.some((e) => e.event === 'workflow_run'))
  assert.ok(stream.events.some((e) => e.event === 'workflow_job'))
  assert.ok(stream.events.some((e) => e.event === 'agent_request'))
  assert.equal(
    new Set(stream.events.map((e) => e.id)).size,
    stream.events.length,
  )
  const event = {
    id: 'durable-once',
    event: 'issues',
    repository: 'acme/demo',
    payload: { action: 'edited', issue: { number: 1 } },
  }
  await request('/emit-fixture', 'POST', event)
  await request('/emit-fixture', 'POST', event)
  const resumed = await (
    await request(
      '/api/v1/events?repos=acme/demo&since=' + stream.cursor + '&wait=0',
    )
  ).json()
  assert.equal(resumed.events.filter((e) => e.id === event.id).length, 1)
  const sse = await request(
    '/api/v1/events?repos=acme/demo&since=' + stream.cursor + '&wait=0',
    'GET',
    undefined,
    { accept: 'text/event-stream' },
  )
  assert.match(sse.headers.get('content-type'), /text\/event-stream/)
  assert.match(await sse.text(), /id: [0-9]+\nevent: issues/)
  const tail = JSON.parse(
    (
      await runCLI(
        'events',
        'tail',
        '--repo',
        'acme/demo',
        '--since',
        stream.cursor,
        '--once',
      )
    )
      .trim()
      .split('\n')
      .find((line) => JSON.parse(line).id === event.id),
  )
  assert.equal(tail.id, event.id)
  const cursor = resumed.cursor,
    longpoll = request(
      '/api/v1/events?repos=acme/demo&since=' + cursor + '&wait=2000',
    )
  await new Promise((r) => setTimeout(r, 100))
  await request('/emit-fixture', 'POST', { ...event, id: 'wake-long-poll' })
  assert.ok(
    (await (await longpoll).json()).events.some(
      (e) => e.id === 'wake-long-poll',
    ),
  )
  write(
    'src/main.ts',
    'export function greet(input: string) { return eval(input) }\n',
  )
  const pushed = commit('Push fixture')
  await request('/push-fixture', 'POST', {
    sha: pushed,
    before: base,
    ref: 'refs/heads/main',
  })
  await eventually(async () => {
    await request('/flush-events')
    return (await (await request(eventsURL)).json()).events.some(
      (e) => e.event === 'push' && e.payload.after === pushed,
    )
  })
  const pushedEvents = await (await request(eventsURL)).json(),
    push = pushedEvents.events.find(
      (e) => e.event === 'push' && e.payload.after === pushed,
    )
  assert.deepEqual(push.payload.head_commit.modified, ['src/main.ts'])
  assert.equal(push.payload.forced, false)
  const health = pushedEvents.events.find((e) => e.event === 'health_changed')
  assert.ok(health)
  const security = health.payload.scores.find((s) => s.category === 'security')
  assert.equal(security.before, 100)
  assert.equal(security.after, 70)
  assert.ok(security.rules.some((r) => r.rule === 'dynamic-code'))
  for (const bad of ['http://127.0.0.1', 'http://2130706433', 'http://[::1]'])
    assert.equal(
      (await request(hookBase, 'POST', { config: { url: bad, secret } }))
        .status,
      422,
    )
  const readonly = await (
    await request('/api/v1/user/tokens', 'POST', {
      label: 'events readonly',
      scopes: ['repo:read'],
      repos: ['acme/demo'],
    })
  ).json()
  assert.equal(
    (
      await request(hookBase, 'GET', undefined, {
        authorization: 'Bearer ' + readonly.token,
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await request(
        '/api/v1/events?repos=other/private&wait=0',
        'GET',
        undefined,
        { authorization: 'Bearer ' + readonly.token },
      )
    ).status,
    404,
  )
  const fail = await (
    await request(hookBase, 'POST', {
      config: { url: 'https://receiver.example/fail', secret },
    })
  ).json()
  for (let i = 0; i < 11; i++)
    await request(hookBase + '/' + fail.id + '/pings', 'POST', {})
  await eventually(
    async () =>
      !(await (await request(hookBase + '/' + fail.id)).json()).active,
  )
  assert.match(
    (await (await request(hookBase + '/' + fail.id)).json()).disabled_reason,
    /10 consecutive/,
  )
  await request(hookBase + '/' + fail.id, 'DELETE')
  assert.equal(
    (await request(hookBase + '/' + repoHook.id, 'DELETE')).status,
    200,
  )
  bCovered.add('repoDeleteHook')
  // Account lifecycle routes (lib/accounts.test.ts covers the lifecycle itself).
  const mine = await request('/api/v1/user/account')
  assert.equal(mine.status, 200)
  assert.deepEqual(await mine.json(), { name: 'acme', status: 'active', trial_ends_at: null, delete_after: null, writable: true })
  bCovered.add('account')
  assert.equal((await request('/api/v1/user', 'DELETE', { confirm: 'not-acme' })).status, 422, 'deletion needs the account name')
  bCovered.add('deleteAccount')
  const restored = await request('/api/v1/user/restore', 'POST', {})
  assert.equal(restored.status, 200)
  assert.equal((await restored.json()).status, 'active', 'nothing to restore leaves an active account as it is')
  bCovered.add('restoreAccount')
  assert.equal((await request('/api/v1/admin/accounts/acme', 'PUT', { status: 'unpaid' })).status, 404, 'only a site admin sets a status')
  bCovered.add('setAccount')
  assert.deepEqual(
    [...bCovered].sort(),
    Object.values(spec.paths)
      .flatMap((path) =>
        Object.values(path)
          .filter((op) => op['x-gild-phase'] === 'B')
          .map((op) => op.operationId),
      )
      .sort(),
  )
  await (
    await import('./events-browser.mjs')
  ).verifyWebhooks(origin, token, secret)
  console.log(
    'Events: all 19 contracts; signed real Queue retries; source emits, durable resume/SSE/long-poll, CLI, SSRF, auto-disable passed',
  )
  const agentToken = 'gf_' + randomBytes(16).toString('hex')
  await request('/session-token-fixture', 'POST', { token: agentToken })
  const agentAuth = { authorization: 'Bearer ' + agentToken },
    sessionBase = '/api/v1/repos/acme/demo/pulls/2/sessions',
    sessionInput = {
      started_at: new Date().toISOString(),
      model: 'any-harness',
      tokens_in: 123,
      tokens_out: 45,
      cost: 0.0123,
      commands: [
        { name: 'bun test', exit_code: 0, duration_ms: 123 },
        { name: 'false', exit_code: 1, duration_ms: 10 },
        { name: 'echo ' + 'word '.repeat(800), exit_code: 0, duration_ms: 1 },
      ],
      files: { read: ['README.md', 'src/main.ts'], written: ['src/main.ts'] },
      notes: 'Harness report ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    },
    cCovered = new Set()
  r = await request(sessionBase, 'POST', sessionInput, agentAuth)
  assert.equal(r.status, 201, await r.clone().text())
  let receipt = await r.json()
  assert.equal(receipt.agent, 'acme/requested')
  assert.equal(receipt.closed, false)
  cCovered.add('createPullSession')
  assert.equal(receipt.reported_by, 'agent')
  assert.ok(!receipt.notes.includes('ghp_'))
  assert.match(receipt.notes, /redacted/)
  assert.ok(receipt.commands[2].name.length <= 1024)
  assert.equal(receipt.signature, undefined)
  assert.equal(receipt.token_fingerprint, undefined)
  assert.equal(receipt.public_key, undefined)
  r = await request(
    sessionBase,
    'POST',
    { ...sessionInput, id: receipt.id, ended_at: new Date().toISOString() },
    agentAuth,
  )
  assert.equal(r.status, 201, await r.clone().text())
  receipt = await r.json()
  assert.equal(receipt.closed, true)
  assert.equal(receipt.version, 2)
  assert.equal(receipt.signature, undefined)

  assert.equal(
    (
      await request(
        sessionBase,
        'POST',
        { ...sessionInput, id: receipt.id, notes: 'tamper' },
        agentAuth,
      )
    ).status,
    409,
  )
  assert.equal(
    (
      await request(
        sessionBase,
        'POST',
        { ...sessionInput, agent: 'other/bot' },
        agentAuth,
      )
    ).status,
    403,
  )
  assert.equal((await request(sessionBase, 'POST', sessionInput)).status, 403)
  const firstStart = performance.now()
  r = await request(sessionBase)
  assert.equal(r.status, 200)
  const sessionColdMs = performance.now() - firstStart
  cCovered.add('pullSessions')
  const repeatStart = performance.now()
  assert.deepEqual(await (await request(sessionBase)).json(), [receipt])
  const sessionRepeatMs = performance.now() - repeatStart
  assert.match(r.headers.get('cache-control'), /no-store/)
  const commitSessions =
    '/api/v1/repos/acme/demo/commits/' + pushed + '/sessions'
  r = await request(
    commitSessions,
    'POST',
    { ...sessionInput, ended_at: new Date().toISOString() },
    agentAuth,
  )
  assert.equal(r.status, 201, await r.clone().text())
  cCovered.add('createCommitSession')
  r = await request(commitSessions)
  assert.equal(r.status, 200)
  assert.equal((await r.json())[0].target, 'commit:' + pushed)
  cCovered.add('commitSessions')
  assert.deepEqual(
    [...cCovered].sort(),
    Object.values(spec.paths)
      .flatMap((path) =>
        Object.values(path)
          .filter((op) => op['x-gild-phase'] === 'C')
          .map((op) => op.operationId),
      )
      .sort(),
  )
  const gitReadsBeforeReceipt = gitRequests
  await request(sessionBase)
  await request(commitSessions)
  assert.equal(
    gitRequests,
    gitReadsBeforeReceipt,
    'Receipt reads must not clone or contact Git',
  )
  await (await import('./sessions-browser.mjs')).verifyReceipts(origin, token)
  await (
    await import('./sessions-examples.mjs')
  ).verifySessionExamples({
    request,
    runCLI,
    cli,
    identityDir,
    work,
    fixture,
    origin,
    agentToken,
    now,
    sessionInput,
    sessionBase,
    auth,
  })
  writeFileSync(
    join(root, 'sessions-timings.json'),
    JSON.stringify(
      {
        sessionColdMs,
        sessionRepeatMs,
        indexedGitRequests: 0,
        covered: [...cCovered],
      },
      null,
      2,
    ),
  )
  console.log(
    'Sessions: all four real contracts, redacted agent reports, open/closed, immutability, scope, browser overlay passed',
  )
  // The merge proof closed #1; the modal proof starts from an open issue.
  assert.equal((await request('/api/v1/repos/acme/demo/issues/1', 'PATCH', {state:'open'})).status, 200)
  const {channelSuite}=await import('./channel-check.mjs')
  const channelEvidence=await channelSuite({origin,request,work,token})
  for(const id of channelEvidence.covered)covered.add(id)
  const {orchestratorSuite}=await import('./orchestrator-check.mjs')
  for(const id of (await orchestratorSuite({request,work,token})).covered)covered.add(id)
  const expected = Object.values(spec.paths)
    .flatMap((path) =>
      Object.values(path)
        .filter((op) => op['x-gild-phase'] === 'A')
        .map((op) => op.operationId),
    )
    .sort()
  assert.deepEqual(
    [...covered].sort(),
    expected,
    'Every definition must validate a real response',
  )
  const issuePath = '/api/v1/repos/acme/demo/issues',
    key = { 'idempotency-key': 'same-issue' },
    first = await request(issuePath, 'POST', { title: 'Idempotent' }, key),
    firstData = await first.json(),
    second = await request(issuePath, 'POST', { title: 'Idempotent' }, key)
  assert.equal((await second.json()).number, firstData.number)
  assert.equal(second.headers.get('idempotency-replayed'), 'true')
  assert.equal(
    (await request(issuePath, 'POST', { title: 'Different' }, key)).status,
    409,
  )
  const list = await request(
    '/api/v1/repos/acme/demo/issues?per_page=1&state=all',
  )
  assert.equal((await list.clone().json()).length, 1)
  const next = list.headers.get('link').match(/<([^>]+)>; rel="next"/)[1]
  const page2 = await fetch(next, { headers: auth })
  assert.notEqual((await page2.json())[0].number, (await list.json())[0].number)
  const onceHeaders = { 'idempotency-key': 'token-once' },
    onceBody = { scopes: ['repo:read'], label: 'once' }
  r = await request('/api/v1/user/tokens', 'POST', onceBody, onceHeaders)
  assert.equal(r.status, 201)
  assert.ok((await r.json()).token)
  r = await request('/api/v1/user/tokens', 'POST', onceBody, onceHeaders)
  assert.equal(r.status, 409)
  assert.equal((await r.json()).token, undefined)
  const missing = 'f'.repeat(40)
  r = await request('/api/v1/repos/acme/demo/git/blobs/' + missing)
  assert.equal(r.status, 503)
  await request('/drain-index')
  r = await request('/api/v1/repos/acme/demo/git/blobs/' + missing)
  assert.equal(r.status, 404)
  await request('/evict-raw?sha=' + git('rev-parse', base + ':src/main.ts'))
  r = await request('/api/v1/repos/acme/demo/contents/src/main.ts?ref=' + base)
  assert.equal(r.status, 503)
  await request('/drain-index')
  r = await request('/api/v1/repos/acme/demo/contents/src/main.ts?ref=' + base)
  assert.equal(r.status, 200, await r.clone().text())
  assert.equal(
    Buffer.from((await r.json()).content, 'base64').toString(),
    'export function greet() { return "hello" }\n',
  )
  r = await request('/api/v1/user/tokens', 'POST', {
    scopes: ['repo:read'],
    label: 'rate',
  })
  const limited = await r.json()
  await request('/exhaust?token=' + limited.token)
  r = await request('/api/v1/user/repos', 'GET', undefined, {
    authorization: 'Bearer ' + limited.token,
  })
  assert.equal(r.status, 429)
  assert.equal(r.headers.get('x-ratelimit-remaining'), '0')
  assert.ok(r.headers.has('retry-after'))
  assert.equal(
    (
      await fetch(origin + '/api/v1/user/repos', {
        headers: { cookie: 'gild_session=fake' },
      })
    ).status,
    401,
  )
  assert.equal((await request('/api/v1/events?repos=other/private&wait=0')).status, 404, 'unrestricted token still needs repository read access')
  const hubStart = performance.now()
  for (let i = 0; i < 200; i++) {
    const r = await request('/emit-fixture', 'POST', {id: 'hub-bench-' + i, event: 'issues', repository: 'acme/demo', payload: {action: 'benchmark'}})
    assert.equal(r.status, 200, await r.text())
  }
  const hubMs = performance.now() - hubStart
  console.log({hubSequentialEvents: 200, hubMs, eventsPerSecond: 200000 / hubMs})
  writeFileSync(join(root, 'event-hub-timings.json'), JSON.stringify({events: 200, hubMs, eventsPerSecond: 200000 / hubMs}, null, 2))
  // Exhaust one IP and one principal in real SQLite DOs, then change IP/token.
  const { anonymous } = await import('../lib/api/routing.ts')
  const ipRequest = new Request(origin + '/api/v1/repos/acme/demo/issues', { headers: { 'cf-connecting-ip': '192.0.2.20' } })
  await request('/exhaust?id=' + encodeURIComponent((await anonymous(ipRequest)).id))
  assert.equal((await fetch(ipRequest)).status, 429)
  assert.equal((await fetch(origin + '/api/v1/repos/acme/demo/issues', { headers: { 'cf-connecting-ip': '192.0.2.21' } })).status, 200)
  await request('/exhaust?id=' + encodeURIComponent('principal:acme'))
  assert.equal((await request('/api/v1/repos/acme/demo/issues', 'GET', undefined, { authorization: 'Bearer ' + issuesToken.token })).status, 429)
  const evidence = {
    coldMs,
    cachedMs,
    indexedGitRequests: 0,
    covered: [...covered].sort(),
    octokit: ['list repos', 'read contents', 'create issue', 'create pull'],
    wrangler: !celldRuntime,
    runtime: celldRuntime ? 'celld' : 'wrangler',
    work,
  }
  writeFileSync(
    join(root, 'api-timings.json'),
    JSON.stringify(evidence, null, 2),
  )
  console.log(`API contract: ${covered.size} Phase A operations exercised through the production Worker fixture; coverage check passed`)
  console.log(evidence)
  }
} finally {
  if (worker.exitCode === null) {
    worker.kill('SIGTERM')
    await new Promise((r) => worker.once('exit', r))
  }
  receiver.closeAllConnections()
  await new Promise((r) => receiver.close(r))
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
  writeFileSync(join(work, 'wrangler.log'), logs)
}
