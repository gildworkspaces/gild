import { promisify } from 'node:util'
import { routes } from '../lib/api/contract.ts'
import { match } from '../lib/api/routing.ts'
// Full OpenNext app on local workerd with actual D1/DOs and a local Git/Artifacts
// transport. No remote credentials or remote writes; fixtures are disposable.
import { createServer } from 'node:http'
import { spawn, spawnSync, execFileSync, execFile } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { randomBytes, createHash, createHmac } from 'node:crypto'
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

export async function forgeFixture({ agentPackage = false, runnerScaling = false, repoList = false, repoListPerf = false, cqxModules = false, cqxFaults = false, privacy = false, reuseWork = undefined, staticReview = false, renderBuild = true, identityFragments = false, latency = 0, idempotencyFault = false, mergeQueue = false, publicationAudit = false, workflowPending = false, documentation = false } = {}) {
  const root = resolve('.tmp')
  mkdirSync(root, { recursive: true })
  process.env.TMPDIR = root
  const work = reuseWork ? resolve(reuseWork) : mkdtempSync(join(root, 'settings-e2e-')),
    gitRoot = join(work, 'git')
  mkdirSync(gitRoot,{recursive:true})
  const metadata = new Map(),
    tokens = {}
  const git = (dir, ...args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
function existingRepo(ns,name) {
 const dir=join(gitRoot,ns,name+'.git'), now=new Date().toISOString()
 metadata.set(ns+'/'+name,{id:ns+'/'+name,name,default_branch:git(dir,'symbolic-ref','--short','HEAD'),created_at:now,updated_at:now})
 return git(dir,'rev-parse','HEAD')
}
if(reuseWork)for(const ns of readdirSync(gitRoot))for(const file of readdirSync(join(gitRoot,ns)))if(file.endsWith('.git'))existingRepo(ns,file.slice(0,-4))
function seedRepo(ns, name, sources) {
  const dir = join(gitRoot, ns, name + '.git')
  if(reuseWork && existsSync(dir))return existingRepo(ns,name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'receive.denyCurrentBranch', 'ignore')
  const write = (p, v) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), v)
  }
  if (sources) {
    for (const f of sources) write(f.path, f.text)
  } else {
    write('README.md', privacy && ns==='o-settingstest' && name==='demo' ? '# private-FULL-WORKER-9122\n' : '# Settings fixture\n')
    write('lib/pulls.ts', 'export const createPull = () => "fixture"\n')
    write('package.json', '{"name":"fixture"}')
    if(agentPackage&&ns==='o-settingstest'&&name==='demo'){
      write('gild.json',JSON.stringify({version:1,name:'editor-fixture',files:['LICENSE','instructions.md'],agents:{ava:{runtime:'codex',model:'before',instructions:'instructions.md',requestedPermissions:['repo:read']},bob:{runtime:'claude'},imported:{dependency:'team',member:'remote'}},dependencies:{team:{kind:'agents',repository:'https://gild.gg/example/team.git',ref:'latest',bundlePath:'bundle'}}},null,2)+'\n')
      write('LICENSE','MIT License\n');write('instructions.md','Owned editor fixture instructions\n')
    }
    if (repoList) {
      const language = ({chi:'go',Alamofire:'swift',jsoup:'java',requests:'py',serde:'rs',ky:'ts'})[name] ?? 'ts'
      write('src/library.'+language, ({go:'package library\nfunc Hello() string { return "hello" }',swift:'public func hello() -> String { "hello" }',java:'public class Library { public String hello() { return "hello"; } }',py:'def hello():\n    return "hello"',rs:`pub fn hello() -> &'static str { "hello" }`})[language] ?? 'export function hello() { return "hello" }')
      if(language !== 'ts') write('src/extra.'+language, readFileSync(join(dir,'src/library.'+language)))
      write('LICENSE', 'MIT License\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.')
    }
    write(
      '.github/workflows/ci.yml',
      'name: Fixture CI\non: workflow_dispatch\njobs:\n  test:\n    runs-on: self-hosted\n    steps:\n      - run: echo fixture\n',
    )
  }
  git(dir, 'add', '.')
  const listFixture = repoList
  const commitAt = (date, message) => execFileSync('git', ['-c','commit.gpgsign=false','commit','-m',message], {cwd:dir,env:{...process.env,GIT_AUTHOR_DATE:date,GIT_COMMITTER_DATE:date},stdio:'pipe'})
  if (listFixture && name === 'tools') commitAt('2024-01-01T12:00:00Z','Inactive fixture code')
  else if(listFixture && name === 'ky') {
    commitAt(new Date(Date.now()-350*86400000).toISOString(),'Initial fixture code')
    for(const weeksAgo of [40,30,20,10,5,2,1,0]) {
      write('src/activity.ts', `export const weeksAgo = ${weeksAgo}\n`)
      git(dir,'add','src/activity.ts')
      commitAt(new Date(Date.now()-weeksAgo*7*86400000).toISOString(),'Fixture activity')
    }
  } else git(dir, '-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture code')
  const sha = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'branch', 'feature')
  git(dir, '-c', 'tag.gpgSign=false', 'tag', 'v1')
  git(dir, 'switch', '--orphan', '_meta')
  git(dir, 'rm', '-rf', '--ignore-unmatch', '.')
  const now = new Date().toISOString(),
    issue = {
      schema: 1,
      number: 1,
      title: 'Settings fixture issue',
      body: 'Fixture',
      author: 'avatest',
      createdAt: now,
      state: 'open',
      labels: [],
      claim: null,
    },
    pull = {
      schema: 1,
      number: 2,
      title: 'Settings fixture PR',
      body: 'Fixture',
      author: 'avatest',
      createdAt: now,
      head: 'feature',
      base: 'main',
      state: 'open',
    }
  write('.gild/1/issue/issue.json', JSON.stringify(issue))
  write('.gild/2/pr/pr.json', JSON.stringify(pull))
  write('.gild/next', '3')
  write('.gild/acl.json', JSON.stringify({ schema: 1, owners: ['@avatest'], ...(repoList && name === 'docs' ? {visibility:'private'} : {}), ...(agentPackage&&ns==='o-settingstest'&&name==='demo'?{visibility:'private',read:['@reader'],write:['@writer']}: {}) }))
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
          approvals: [],
          changesRequested: [],
          conflicts: false,
        },
      ],
      queue: [],
    }),
  )
  git(dir, 'add', '.')
  git(dir, '-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture metadata')
  git(dir, 'switch', 'main')
  metadata.set(ns + '/' + name, {
    id: ns + '/' + name,
    name,
    description: 'A real local Git repository',
    default_branch: 'main',
    created_at: now,
    updated_at: now,
    last_push_at: now,
  })
  return sha
}
const sha = seedRepo('u-avatest', 'glance-test'),
  orgSha = seedRepo('o-settingstest', 'demo')
seedRepo('o-settingstest', 'tools')
seedRepo('o-settingstest', 'runner-images')
if (repoListPerf) for (let i = 0; i < 14; i++) seedRepo('u-avatest', 'perf-' + i)
if (repoList) {
  for (const name of ['ky','chi','Alamofire','jsoup','requests','serde','docs']) seedRepo('o-settingstest',name)
  seedRepo('u-avatest','ky')
}
  if (runnerScaling) for (let i = 0; i < 20; i++) seedRepo('u-second', 'scale' + i)
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://fixture')
      const p = u.pathname.split('/').filter(Boolean)
      const send = (result, status = 200) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            success: status < 400,
            result,
            errors:
              status >= 400
                ? [
                    {
                      message: result?.message ??
                        (status === 404 ? 'Repository not found' : 'Conflict'),
                    },
                  ]
                : [],
          }),
        )
      if (p[0] === 'hook') {
        res.writeHead(200).end()
        return
      }
      if (p[0] === 'git') {
        const ns = p[1],
          repo = p[2].replace(/\.git$/, ''),
          dir = join(gitRoot, ns, repo + '.git')
        if (!existsSync(dir)) {
          res.writeHead(404).end()
          return
        }
        const service =
            u.searchParams.get('service') ??
            (u.pathname.endsWith('git-receive-pack')
              ? 'git-receive-pack'
              : 'git-upload-pack'),
          advertise = u.pathname.endsWith('/info/refs')
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
            dir,
          ],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
              ...process.env,
              GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
            },
          },
        )
        // Deliberately reproduce an upstream that drops flush-only pushes.
        // The gild proxy must terminate this request without forwarding it.
        child.stdin.on('error',()=>res.destroy())
        if(!advertise && service==='git-receive-pack')req.once('data',chunk=>{if(chunk.toString()==='0000'){req.unpipe(child.stdin);child.kill('SIGTERM');res.destroy()}})
        req.pipe(child.stdin)
        child.stdout.pipe(res)
        child.stderr.resume()
        return
      }
      const at = p.indexOf('namespaces'),
        ns = p[at + 1],
        repo = p[at + 3],
        kind = p[at + 4],
        ref = p[at + 5],
        key = ns + '/' + repo,
        dir = join(gitRoot, ns, repo + '.git')
      if (p[at + 2] === 'tokens') {
        send({ plaintext: 'local-fixture-git-token' })
        return
      }
      if (p[at + 2] !== 'repos') {
        send(null, 404)
        return
      }
      if (!repo && req.method === 'GET') {
        send(
          [...metadata]
            .filter(([key]) => key.startsWith(ns + '/'))
            .map(([, v]) => v),
        )
        return
      }
      if (!repo && req.method === 'POST') {
        let body = ''
        for await (const chunk of req) body += chunk
        const b = JSON.parse(body),
          k = ns + '/' + b.name
        if (metadata.has(k)) {
          send(null, 409)
          return
        }
        if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(b.default_branch ?? '')) {
          send({ message: 'Invalid default_branch: Invalid branch name' }, 400)
          return
        }
        const dest = join(gitRoot, ns, b.name + '.git')
        mkdirSync(dirname(dest), { recursive: true })
        execFileSync(
          'git',
          ['init', '--bare', '--initial-branch=' + b.default_branch, dest],
          { stdio: 'pipe' },
        )
        const info = {
          id: k,
          name: b.name,
          description: b.description ?? null,
          default_branch: b.default_branch,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          last_push_at: null,
        }
        metadata.set(k, info)
        send(info, 201)
        return
      }
      if (!metadata.has(key)) {
        send(null, 404)
        return
      }
      if (req.method === 'DELETE') {
        metadata.delete(key)
        rmSync(dir, { recursive: true, force: true })
        send({ id: key })
        return
      }
      if (!kind) {
        send(metadata.get(key))
        return
      }
      const log = (h) => {
        const parts = git(
          dir,
          'show',
          '-s',
          '--format=%H%n%T%n%P%n%an%n%ae%n%at%n%B',
          h,
        ).split('\n')
        return {
          hash: parts[0],
          treeHash: parts[1],
          parents: parts[2].split(' ').filter(Boolean),
          author: { name: parts[3], email: parts[4] },
          authoredAt: Number(parts[5]),
          message: parts.slice(6).join('\n'),
        }
      }
      if (kind === 'commit') {
        send(log(ref))
        return
      }
      if (kind === 'log') {
        const ref = u.searchParams.get('ref') ?? 'main',
          limit = u.searchParams.get('limit') ?? '10'
        send(
          git(dir, 'log', ref, '--format=%H', '-' + limit)
            .split('\n')
            .filter(Boolean)
            .map(log),
        )
        return
      }
      if (kind === 'tree') {
        send(
          git(dir, 'ls-tree', ref)
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const m = /^(\d+) (\w+) ([a-f0-9]+)\t(.+)$/.exec(line)
              return { mode: m[1], type: m[2], hash: m[3], name: m[4] }
            }),
        )
        return
      }
      if (kind === 'blob') {
        res
          .writeHead(200, { 'content-type': 'application/octet-stream' })
          .end(execFileSync('git', ['cat-file', 'blob', ref], { cwd: dir }))
        return
      }
      if (kind === 'file') {
        res
          .writeHead(200, { 'content-type': 'text/plain' })
          .end(
            git(
              dir,
              'show',
              `${u.searchParams.get('ref')}:${u.searchParams.get('path')}`,
            ),
          )
        return
      }
      send(null, 404)
    } catch (e) {
      res
        .writeHead(500, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({ success: false, errors: [{ message: e.message }] }),
        )
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const gitOrigin = `http://127.0.0.1:${server.address().port}`
  const wrapper = join(work, 'entry.ts')
  writeFileSync(
    wrapper,
    `
import { ForgeEvents as ProductionForgeEvents } from ${JSON.stringify(resolve('lib/events/hub-do.ts'))};
export class ForgeEvents extends ProductionForgeEvents { drainChannel(){return this.flushChannel()} }
import worker from ${JSON.stringify(resolve('worker.ts'))};
export * from ${JSON.stringify(resolve('worker.ts'))};
import { ApiControl as ProductionApiControl } from ${JSON.stringify(resolve('lib/api/control-do.ts'))};
// Rate-count assertions must not depend on crossing an actual hour boundary.
export class ApiControl extends ProductionApiControl {
 rate(_now,limit){return super.rate(${Date.now()},limit)}
 ${idempotencyFault ? `async armRecoveryFault(){await this.ctx.storage.put('fixture:recovery-fault',true)}
 async finish(key,claim,response){if(await this.ctx.storage.get('fixture:recovery-fault')){await this.ctx.storage.delete('fixture:recovery-fault');throw new Error('fixture lost response after committed write')}return super.finish(key,claim,response)}` : ''}
}
import { RepoIndex as ProductionRepoIndex } from ${JSON.stringify(resolve('lib/repo-index-do.ts'))};
// A controllable production refresh makes the post-push race deterministic.
export class RepoIndex extends ProductionRepoIndex {
 ${idempotencyFault ? `async armPostPushFault(){await this.ctx.storage.put('fixture:postpush-fault',true)}
 async listingAcl(...args){if(await this.ctx.storage.get('fixture:postpush-fault')){await this.ctx.storage.delete('fixture:postpush-fault');throw new Error('fixture accepted Git push; ACL publication failed')}return super.listingAcl(...args)}` : ''}
 async apiChanges(...args){this.index.setting('fixture:changes',String(Number(this.index.setting('fixture:changes')??0)+1));return super.apiChanges(...args)}
 importCounters(){return {changes:Number(this.index.setting('fixture:changes')??0),pending:this.index.rows('SELECT 1 FROM push_events').length}}
 discardImportBackfill(){this.ctx.storage.sql.exec('DELETE FROM push_events');this.ctx.storage.sql.exec('DELETE FROM health_events')}
 async pauseImportIndex(paused){this.index.setting('fixture:paused',paused?'1':'');if(paused)this.index.setting('dirty','1');else await this.refresh(this.index.setting('owner'),this.index.setting('repo'))}
 status(){const status=super.status();return this.index.setting('fixture:paused')==='1'?{...status,ready:false,refreshing:true}:status}
 async alarm(){if(this.index.setting('fixture:paused')==='1')return;return super.alarm()}
 async deferRefresh(owner,repo){await super.refresh(owner,repo);await this.ctx.storage.setAlarm(Date.now()+2000)}
}
import {RunnerPool as ProductionRunnerPool} from ${JSON.stringify(resolve('lib/actions/pool-do.ts'))};
import {hashToken} from ${JSON.stringify(resolve('lib/token-verifier.ts'))};
import {RunQueue as ProductionRunQueue} from ${JSON.stringify(resolve('lib/actions/queue-do.ts'))};
export class RunQueue extends ProductionRunQueue {
 ${workflowPending ? `async pauseWorkflows(paused){this.runs.setting('fixture:workflow-paused',paused?'1':'');if(!paused)await this.ctx.storage.setAlarm(Date.now()+1)}
 async alarm(){if(this.runs.setting('fixture:workflow-paused')==='1')return;return super.alarm()}` : ''}
 readyCalls = 0; leaseCalls = 0;
 ready(labels){this.readyCalls++;return super.ready(labels)}
 leasesLive(assignments){this.leaseCalls++;return super.leasesLive(assignments)}
 counters(){return {ready:this.readyCalls,leases:this.leaseCalls}}
 ${mergeQueue ? `mergeEvidence(){return {intents:this.merges.pending(),needed:this.merges.needed(),error:this.runs.setting('merge-error')}}` : ''}
}
export class RunnerPool extends ProductionRunnerPool {
 async expireRegistration(token){this.pool.rows('UPDATE pool_registrations SET expires=? WHERE hash=?',Date.now(),await hashToken(token))}
 async offline(id){const r=this.pool.runner(id);this.pool.saveRunner({...r,lastSeen:Date.now()-120001,reportedOffline:false});await this.alarm()}
}
const upstream=globalThis.fetch;
globalThis.fetch=(input,init)=>{const r=new Request(input,init),u=new URL(r.url);if(u.hostname==='hooks.fixture.test' || u.hostname==='api.cloudflare.com' || u.hostname.endsWith('.artifacts.cloudflare.net')){u.protocol='http:';u.host=${JSON.stringify(new URL(gitOrigin).host)};return Promise.resolve(wait('upstream',r.method+' '+u.pathname)).then(()=>upstream(new Request(u,r)))}return upstream(r)};
import fixtureNext from ${JSON.stringify(resolve('.open-next/worker.js'))};
const fixtureNextCalls=new WeakMap(),fixtureNextFetch=fixtureNext.fetch;
fixtureNext.fetch=function(request,env,ctx){const counts=fixtureNextCalls.get(env.DB);if(counts)counts.next++;return fixtureNextFetch.call(this,request,env,ctx)};
const fixtureTraces=new Map();
// latency: every D1/R2/DO/service/upstream round trip waits this long, so a
// local run reports the round trips a page puts on its critical path at a
// realistic cost (production D1 is one region away from most colos).
const LATENCY=${latency};
import {AsyncLocalStorage} from 'node:async_hooks';
const ioTrace=new AsyncLocalStorage(),ioTraces=new Map();
// Each slowed round trip is recorded against the request that made it:
// /__fixture/io?trace= lists them (kind, detail, ms since the request began).
const wait=(kind,detail)=>{if(!LATENCY)return null;const t=ioTrace.getStore();t?.push({kind,detail:String(detail??'').slice(0,90),at:Date.now()-t.start});return new Promise(r=>setTimeout(r,LATENCY))};
let slowed=false;
function slow(env){
 if(!LATENCY||slowed)return;slowed=true;
 const statement=Object.getPrototypeOf(env.DB.prepare('SELECT 1'));
 for(const k of ['first','all','run','raw']){const o=statement[k];statement[k]=async function(...a){await wait('d1',this.statement??this.sql??'');return o.apply(this,a)}}
 const db=Object.getPrototypeOf(env.DB),batch=db.batch;db.batch=async function(...a){await wait('d1-batch',a[0]?.length);return batch.apply(this,a)}
 const bucket=Object.getPrototypeOf(env.FRAGMENTS);for(const k of ['get','head','put','list']){const o=bucket[k];bucket[k]=async function(...a){await wait('r2-'+k,a[0]);return o.apply(this,a)}}
 const stubs=(ns,key)=>ns?.get?{idFromName:n=>ns.idFromName(n),get:id=>new Proxy(ns.get(id),{get(t,k){const v=Reflect.get(t,k);return typeof v==='function'?async(...args)=>{await wait('do',key+'.'+String(k));return Reflect.apply(v,t,args)}:v}})}:ns;
 for(const key of ['REPO_INDEX','RUN_QUEUE','RUNNER_POOL','REPO_IMPORT','EVENTS','API_CONTROL','REPO_CHANNEL','SETTINGS_RENAME'])if(env[key]?.get)env[key]=stubs(env[key],key);
 const assets=env.ASSETS;if(assets)env.ASSETS={fetch:async(...a)=>{await wait('assets',typeof a[0]==='string'?a[0]:a[0].url);return assets.fetch(...a)}};
 const render=env.GILD_RENDER;env.GILD_RENDER={fetch:async(...a)=>{await wait('render',typeof a[0]==='string'?a[0]:a[0].url);return render.fetch(...a)}};
}
let fixtureDocumentationMissing=false;
const fixtureWorker={...worker, async fetch(request,env,ctx){
 slow(env);
 const u=new URL(request.url);
 if(u.pathname==='/__fixture/io')return Response.json(ioTraces.get(u.searchParams.get('trace'))??null);
 if(LATENCY&&!u.pathname.startsWith('/__fixture/')){
  const trace=crypto.randomUUID(),ios=Object.assign([],{start:Date.now()});ioTraces.set(trace,ios);if(ioTraces.size>2000)ioTraces.delete(ioTraces.keys().next().value);
  const response=await ioTrace.run(ios,()=>fixtureWorker.inner(request,env,ctx));
  if(response.status===101)return response;
  const headers=new Headers(response.headers);headers.set('x-fixture-io',trace);
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers,...{encodeBody:'manual'}});
 }
 return fixtureWorker.inner(request,env,ctx);
},
async inner(request,env,ctx){
 const fixtureEnteredAt=Date.now();
 ${documentation ? `if(new URL(request.url).pathname==='/__fixture/documentation-missing'){fixtureDocumentationMissing=(await request.json()).missing===true;return Response.json({ok:true})}
 if(fixtureDocumentationMissing){const assets=env.ASSETS;env={...env,ASSETS:{fetch(input,init){const url=new URL(typeof input==='string'?input:input.url);return url.pathname.includes('/gild-documents/')?Promise.resolve(new Response('Not ready',{status:404})):assets.fetch(input,init)}}}}` : ''}
 const u=new URL(request.url);
 ${idempotencyFault ? "if(u.pathname==='/__fixture/idempotency-fault'){const {token}=await request.json();await env.API_CONTROL.get(env.API_CONTROL.idFromName(await hashToken(token))).armRecoveryFault();return Response.json({ok:true})}" : ''}
 ${idempotencyFault ? "if(u.pathname==='/__fixture/postpush-fault'){const {owner,repo}=await request.json(),st=(await import(" + JSON.stringify(resolve('lib/drivers/d1.ts')) + ")).d1Store(env.DB),id=(await st.settings.state(owner+'/'+repo)).id;await env.REPO_INDEX.get(env.REPO_INDEX.idFromName(id)).armPostPushFault();return Response.json({ok:true})}" : ''}
 ${mergeQueue ? `if(u.pathname==='/__fixture/merge-queue'){
  const owner='settingstest',repo='demo',st=(await import(${JSON.stringify(resolve('lib/drivers/d1.ts'))})).d1Store(env.DB),state=await st.settings.state(owner+'/'+repo),q=env.RUN_QUEUE.get(env.RUN_QUEUE.idFromName(state.id));await q.init(owner,repo);
  if(request.method==='POST'){const body=await request.json();if(body.required)await q.required(body.required)}
  return Response.json(await q.mergeEvidence())
 }` : ''}
 if(u.pathname==='/__fixture/legacy-import'){await env.DB.prepare("INSERT INTO repo_imports(repository,state,updated) VALUES (?,'complete',0)").bind('settingstest/demo').run();return Response.json({ok:true})}
 if(u.pathname==='/__fixture/calls')return Response.json(fixtureTraces.get(u.searchParams.get('trace'))??null);
 ${workflowPending ? `if(u.pathname==='/__fixture/workflow-pending'){const {owner,repo,paused}=await request.json(),st=(await import(${JSON.stringify(resolve('lib/drivers/d1.ts'))})).d1Store(env.DB),id=(await st.settings.state(owner+'/'+repo)).id,q=env.RUN_QUEUE.get(env.RUN_QUEUE.idFromName(id));await q.init(owner,repo);await q.pauseWorkflows(paused);return Response.json({ok:true})}` : ''}
 if(u.pathname==='/__fixture/raw-document'){
  const {default:handler}=await import(${JSON.stringify(resolve('.open-next/worker.js'))});
  return handler.fetch(new Request(new URL(u.searchParams.get('route'),u.origin),request),env,ctx);
 }
 if(u.pathname==='/__fixture/public-pages'){
  const {queuePublicPages,refreshPublicPages,publishPublicPage}=await import(${JSON.stringify(resolve('lib/public-pages.ts'))});
  const {retainPublicAssets}=await import(${JSON.stringify(resolve('lib/public-assets.ts'))});
  const {default:handler}=await import(${JSON.stringify(resolve('.open-next/worker.js'))});
  await retainPublicAssets(env);
  if(u.searchParams.has('route'))return Response.json({published:await publishPublicPage(env,u.searchParams.get('route'),r=>handler.fetch(r,env,ctx),u.origin)});
  await queuePublicPages(env);
  await refreshPublicPages(env,r=>handler.fetch(r,env,ctx),u.origin,100);
  return Response.json(await env.DB.prepare('SELECT route,hash FROM public_pages ORDER BY route').all());
 }
 if(u.pathname==='/__fixture/channel-agent-token'){const b=await request.json(),st=(await import(${JSON.stringify(resolve('lib/drivers/d1.ts'))})).d1Store(env.DB),token='gf_'+crypto.randomUUID().replaceAll('-','');await st.saveApiToken(await hashToken(token),b.agent,'ed25519:fixture',Date.now()+86400000,{scopes:['repo:read','repo:write','pulls:write'],repos:['settingstest/demo']});return Response.json({token})}
 if(u.pathname==='/__fixture/channel-event'){const event=await request.json(),hub=env.EVENTS.get(env.EVENTS.idFromName('forge-v1'));await hub.emit(event);await hub.drainChannel();return Response.json({ok:true})}
 if(u.pathname==='/__fixture/agent-request'){const b=await request.json(),st=(await import(${JSON.stringify(resolve('lib/drivers/d1.ts'))})).d1Store(env.DB);return Response.json(await st.createAgentRequest({id:b.id,sponsor:'avatest',label:b.label,publicKey:'ed25519:'+'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',repo:'settingstest/demo',grants:['pr'],note:'Channel approval proof'}))}
 ${identityFragments ? "if(u.pathname.startsWith('/f/')){const headers=new Headers(request.headers);headers.set('accept-encoding','identity');request=new Request(request,{headers})}" : ''}
 if(u.pathname==='/__fixture/shell-stars'){const st=(await import(${JSON.stringify(resolve('lib/drivers/d1.ts'))})).d1Store(env.DB),id=(await st.settings.state('avatest/shell-test')).id;await env.DB.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<12345) INSERT OR IGNORE INTO stars(repo,name,created_at) SELECT ?,'fixture-star-'||i,'2026-10-09' FROM n").bind(id).run();return Response.json({ok:true})}
 if(u.pathname==='/__fixture/import-index-pause'){const st=(await import(${JSON.stringify(resolve('lib/drivers/d1.ts'))})).d1Store(env.DB),id=(await st.settings.state(u.searchParams.get('repository'))).id,index=env.REPO_INDEX.get(env.REPO_INDEX.idFromName(id));await index.pauseImportIndex(u.searchParams.get('paused')==='1');return Response.json({ok:true})}
 if(u.pathname==='/__fixture/import-counters'){const st=(await import(${JSON.stringify(resolve('lib/drivers/d1.ts'))})).d1Store(env.DB),id=(await st.settings.state(u.searchParams.get('repository'))).id,index=env.REPO_INDEX.get(env.REPO_INDEX.idFromName(id));if(u.searchParams.has('discard'))await index.discardImportBackfill();return Response.json(await index.importCounters())}
 if(u.pathname==='/__fixture/import-fence'){const b=await request.json(),st=(await import(${JSON.stringify(resolve('lib/drivers/d1.ts'))})).d1Store(env.DB);if(b.restore)await st.publishRepoAccess(b.repository,b.restore.meta,b.restore.acl);else{const previous=await st.getRepoAccess(b.repository);await st.fenceRepoAccess(b.repository,'fixture-pending-import');return Response.json(previous)}return Response.json({ok:true})}
 if(u.pathname==='/__fixture/cqx-mode'){await env.CQX_HEAVY.configure(u.searchParams.get('mode'));const st=(await import(${JSON.stringify(resolve('lib/drivers/d1.ts'))})).d1Store(env.DB),rows=await env.DB.prepare('SELECT id FROM settings_entities WHERE key LIKE ?').bind('%/%').all();for(const row of rows.results){const index=env.REPO_INDEX.get(env.REPO_INDEX.idFromName(row.id));if((await index.status()).ready)await index.renderProjection()}return Response.json({ok:true})}
 if(u.pathname==='/__fixture/cqx-api-health'){const owner=u.searchParams.get('owner'),repo=u.searchParams.get('repo'),st=(await import(${JSON.stringify(resolve('lib/drivers/d1.ts'))})).d1Store(env.DB),id=(await st.settings.state(owner+'/'+repo)).id;return Response.json(await env.REPO_INDEX.get(env.REPO_INDEX.idFromName(id)).apiHealth(u.searchParams.get('sha')))}
 if(u.pathname==='/__fixture/cqx-cache') return Response.json(await env.DB.prepare('SELECT key,report FROM cqx_scores ORDER BY key').all());
 if(u.pathname==='/__fixture/cqx-scan'){const b=await request.json();return Response.json(await (await import(${JSON.stringify(resolve('lib/cqx-wasm.ts'))})).scoreFiles(b.files,b.config??null,b.label,env.CQX_HEAVY))}
 if(u.pathname==='/__fixture/runner-scaling'){
  const st=(await import(${JSON.stringify(resolve('lib/drivers/d1.ts'))})).d1Store(env.DB),p=env.RUNNER_POOL.get(env.RUNNER_POOL.idFromName((await st.settings.state('second')).id));
  await p.init('second');const queues=[];
  for(let i=0;i<20;i++){const repo='scale'+i,id=(await st.settings.state('second/'+repo)).id,q=env.RUN_QUEUE.get(env.RUN_QUEUE.idFromName(id));await q.init('second',repo);await p.offer('second/'+repo,id,[]);queues.push(q)}
  const tokens=[];
  for(let i=0;i<100;i++){const r=await p.register('second',{name:'scale-runner-'+i,os:'linux',arch:'x64',labels:[]});tokens.push(r.token)}
  await p.saveGroup({allow_public_repositories:true},'default');
  const started=performance.now();await Promise.all(tokens.map(t=>p.poll(t,0)));const coldMs=performance.now()-started,cold=await Promise.all(queues.map(q=>q.counters()));
  const repeated=performance.now();await Promise.all(tokens.map(t=>p.poll(t,0)));const warmMs=performance.now()-repeated,warm=await Promise.all(queues.map(q=>q.counters()));
  return Response.json({runtime:'local workerd, actual RunnerPool/RunQueue/D1/RepoIndex and mayRead',repositories:20,runners:100,coldMs,warmMs,coldReadyCalls:cold.reduce((n,c)=>n+c.ready,0),repeatedReadyCalls:warm.reduce((n,c)=>n+c.ready,0)-cold.reduce((n,c)=>n+c.ready,0),pollLeaseCalls:warm.reduce((n,c)=>n+c.leases,0)})
 }
 if(u.pathname==='/__fixture/expire-registration'){const b=await request.json();await env.RUNNER_POOL.get(env.RUNNER_POOL.idFromName(b.owner)).expireRegistration(b.token);return Response.json({ok:true})}
 if(u.pathname==='/__fixture/offline'){const b=await request.json();await env.RUNNER_POOL.get(env.RUNNER_POOL.idFromName(b.owner)).offline(b.id);return Response.json({ok:true})}
 if(u.pathname==='/__fixture/history'){const key=u.searchParams.get('key'),st=(await import(${JSON.stringify(resolve('lib/drivers/d1.ts'))})).d1Store(env.DB),index=env.REPO_INDEX.get(env.REPO_INDEX.idFromName((await st.settings.state(key.toLowerCase())).id)),refs=await index.refs(),tip=refs.refs.find(r=>r.kind==='branch'&&r.name===refs.defaultBranch)?.hash;return Response.json({ready:tip?await index.ensureHistory(tip):false})}
 if(u.pathname==='/__fixture/refresh'&&u.searchParams.has('key')){const key=u.searchParams.get('key'),st=(await import(${JSON.stringify(resolve('lib/drivers/d1.ts'))})).d1Store(env.DB),id=(await st.settings.state(key.toLowerCase())).id,index=env.REPO_INDEX.get(env.REPO_INDEX.idFromName(id));await index.deferRefresh(...key.split('/'));return Response.json(await index.status())}
 if(u.pathname==='/__fixture/refresh'){const owner=u.searchParams.get('owner'),repo=u.searchParams.get('repo'),st=(await import(${JSON.stringify(resolve('lib/drivers/d1.ts'))})).d1Store(env.DB),id=(await st.settings.state(owner+'/'+repo)).id;await env.REPO_INDEX.get(env.REPO_INDEX.idFromName(id)).refresh(owner,repo);return Response.json({ok:true})}
 if(u.pathname==='/__fixture/publication-audit'){
  if(u.searchParams.has('init'))await (await import(${JSON.stringify(resolve('lib/fragments/edge.ts'))})).invalidatePublicReads(u.origin);
  const generation=await caches.default.match(new Request(u.origin+'/__gild-read-generation'));
  return Response.json({generation:generation?await generation.text():null});
 }
 if(u.pathname==='/__fixture/render-settled'){
  const {fragmentKey}=await import(${JSON.stringify(resolve('packages/render/address.ts'))});
  const entities=(await env.DB.prepare("SELECT id,key FROM settings_entities WHERE instr(key,'/')>0 AND deleted_at IS NULL").all()).results,pending=[];
  for(const entity of entities){
   const index=env.REPO_INDEX.get(env.REPO_INDEX.idFromName(entity.id)),snapshot=await index.readiness();
   if(!snapshot.status.ready){if(!snapshot.status.refreshing)await index.refresh(...entity.key.split('/'));pending.push(entity.key+':index');continue}
   const tip=snapshot.refs.refs.find(r=>r.kind==='branch'&&r.name===snapshot.refs.defaultBranch)?.hash;
   if(!tip)continue;
   try {
    let cursor=0;
    do {const plan=await index.renderPlan({entity:entity.id,repository:entity.key,oldTip:null,newTip:tip,meta:snapshot.refs.meta},cursor);
     for(const item of plan.items)if(!await env.FRAGMENTS.head(fragmentKey(item.fragment,plan.scope)))pending.push(entity.key+':'+item.fragment.kind);
     cursor=plan.cursor;
    }while(cursor!==null);
   }catch{pending.push(entity.key+':projection')}
  }
  return Response.json({ready:pending.length===0,pending});
 }
 if(u.pathname==='/__fixture/lease'){const st=(await import(${JSON.stringify(resolve('lib/drivers/d1.ts'))})).d1Store(env.DB);if(u.searchParams.has('release')){await st.settings.release(u.searchParams.get('release'));return Response.json({ok:true})}return Response.json({lease:await st.settings.lease(u.searchParams.get('key'))})}
 if(u.pathname==='/__fixture/scheduled'){if(u.searchParams.has('expire'))await env.DB.prepare('UPDATE settings_entities SET deleted_at=? WHERE deleted_at IS NOT NULL').bind(Date.now()-8*86400000).run();await worker.scheduled({},env,ctx);return Response.json({ok:true})}
 if(u.pathname==='/__fixture/state'){const key=u.searchParams.get('key'),id=u.searchParams.get('id')??(await (await import(${JSON.stringify(resolve('lib/drivers/d1.ts'))})).d1Store(env.DB).settings.state(key)).id,hub=env.EVENTS.get(env.EVENTS.idFromName('forge-v1')),q=env.RUN_QUEUE.get(env.RUN_QUEUE.idFromName(id));return Response.json({secrets:await env.DB.prepare('SELECT name FROM action_secrets WHERE repo=?').bind(id).all(),members:await env.DB.prepare('SELECT member FROM org_members WHERE org=?').bind(key.split('/')[0]).all(),hooks:await hub.list('repo:'+key,u.origin),secretMatches: (await (await import(${JSON.stringify(resolve('lib/actions/secrets.ts'))})).repoSecrets(env,key)).MATRIX_TEST===u.searchParams.get('expected'),runners:(await q.overview()).runners,index:await env.REPO_INDEX.get(env.REPO_INDEX.idFromName(id)).status()})}
 if(u.pathname.includes('.git/')) {
  let standaloneNamespaceReads=0;
  const DB=new Proxy(env.DB,{get(target,property){if(property==='prepare')return query=>{if(query.startsWith('SELECT internal_prefix'))standaloneNamespaceReads++;return target.prepare(query)};const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value}});
  const response=await worker.fetch(request,{...env,DB},ctx),out=new Response(response.body,response);
  out.headers.set('x-fixture-namespace-reads',String(standaloneNamespaceReads));return out;
 }
 if(!${staticReview})return worker.fetch(request,env,ctx);
 const counts={do:0,d1:0,r2:0,render:0,queue:0,next:0,publication:0,doMethods:[]};
 const wrap=(target,counter,keys)=>new Proxy(target,{get(t,k){const v=Reflect.get(t,k);return typeof v==='function'?(...args)=>{if(keys.includes(k))counts[counter]++;return Reflect.apply(v,t,args)}:v}});
 const wrapped={...env,DB:new Proxy(env.DB,{get(t,k){const v=Reflect.get(t,k);if(k==='prepare')return query=>{counts.d1++;if(/public_page_jobs|SELECT name FROM claims UNION SELECT name FROM orgs/.test(query))counts.publication++;return t.prepare(query)};return typeof v==='function'?v.bind(t):v}}),FRAGMENTS:wrap(env.FRAGMENTS,'r2',['get','head','put','delete','list']),REPO_INDEX:{idFromName:n=>env.REPO_INDEX.idFromName(n),get:id=>new Proxy(env.REPO_INDEX.get(id),{get(t,k){const v=Reflect.get(t,k);return typeof v==='function'?(...args)=>{counts.do++;counts.doMethods.push('REPO_INDEX.'+String(k));return Reflect.apply(v,t,args)}:v}})},GILD_RENDER:{fetch:(...args)=>{const path=new URL(typeof args[0]==='string'?args[0]:args[0].url).pathname;if(path==='/render')counts.render++;if(path==='/pointer')counts.do++;return env.GILD_RENDER.fetch(...args)}}};
 for(const key of ['RUN_QUEUE','RUNNER_POOL','REPO_IMPORT','EVENTS','API_CONTROL'])if(env[key]?.get)wrapped[key]={idFromName:n=>env[key].idFromName(n),get:id=>new Proxy(env[key].get(id),{get(t,k){const v=Reflect.get(t,k);return typeof v==='function'?(...args)=>{counts.do++;counts.doMethods.push(key+'.'+String(k));if(key==='RUN_QUEUE')counts.queue++;return Reflect.apply(v,t,args)}:v}})};
 fixtureNextCalls.set(wrapped.DB,counts);
 const trace=crypto.randomUUID();fixtureTraces.set(trace,counts);if(fixtureTraces.size>1000)fixtureTraces.delete(fixtureTraces.keys().next().value);
 const pending=[],auditContext=${publicationAudit}?{waitUntil(work){pending.push(work);ctx.waitUntil(work)}}:ctx;
 const response=await worker.fetch(request,wrapped,auditContext);
 // Preserve the native upgrade object; rebuilding a101 Response loses its socket.
 if(response.status===101)return response;
 if(${publicationAudit})await Promise.allSettled(pending);
 const headers=new Headers(response.headers);headers.set('x-fixture-trace',trace);
 headers.set('x-fixture-entered-at',String(fixtureEnteredAt));headers.set('x-fixture-returned-at',String(Date.now()));
 headers.set('x-fixture-calls',JSON.stringify(counts));
 return new Response(response.body,{status:response.status,headers,...{encodeBody:'manual'}})
}};
export default fixtureWorker;
`,
  )
  const sessionSecret = randomBytes(32).toString('hex'),
    config = join(work, 'wrangler.json'),
    state = join(work, 'state'),
    baseConfig = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'))
  writeFileSync(
    config,
    JSON.stringify({
      ...baseConfig,
      name: 'gild-settings-fixture',
      build: { command: 'node ' + resolve('scripts/cqx-artifacts.mjs') },
      main: wrapper,
      assets: { ...baseConfig.assets, directory: resolve('.open-next/assets') },
      vars: {
        SESSION_SECRET: sessionSecret,
        ARTIFACTS_TOKEN: 'local-fixture-only',
        ACTIONS_SECRET_KEY: randomBytes(32).toString('base64'),
      },
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'settings-fixture',
          database_id: '00000000-0000-0000-0000-000000000001',
        },
      ],
      triggers: { crons: [] },
      queues: baseConfig.queues,
      send_metrics: false,
    }),
  )
  const schema = join(work, 'schema.sql'),
    now = new Date().toISOString()
  let sql = reuseWork ? '' : readdirSync('migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync('migrations/' + f, 'utf8'))
    .join('\n')
  for (const name of ['avatest', 'adminuser', 'member', 'outsider', 'second', ...((privacy||agentPackage) ? ['reader','writer'] : [])]) {
    if(!reuseWork)sql += `\nINSERT INTO claims(name,public_key,email,email_verified,claimed_at) VALUES('${name}','ed25519:${name}','${name}@example.com',0,'${now}');`
    const token = 'gf_' + randomBytes(16).toString('hex')
    tokens[name] = token
    sql += `\nINSERT INTO api_tokens(token_hash,name,public_key,created_at,expires_at,label) VALUES('${createHash('sha256').update(token).digest('hex')}','${name}','ed25519:${name}',${Date.now()},${Date.now() + 86400000},'Local fixture');`
  }
  if(!reuseWork)sql += `\nINSERT INTO orgs(name,description,created_by,created_at) VALUES('settingstest','The settings fixture organization','avatest','${now}');\nINSERT INTO org_members(org,member,role,added_at) VALUES('settingstest','avatest','owner','${now}'),('settingstest','adminuser','admin','${now}'),('settingstest','member','member','${now}');\nINSERT INTO agents(name,sponsor,label,public_key,created_at) VALUES('avatest/codex','avatest','codex',NULL,'${now}');`
  if(privacy) for(const label of ['granted','ungranted']) {
    const name='avatest/'+label,token='gf_'+randomBytes(16).toString('hex');tokens[name]=token;
    sql+=`\nINSERT INTO agents(name,sponsor,label,public_key,created_at) VALUES('${name}','avatest','${label}','ed25519:${name}','${now}'); INSERT INTO api_tokens(token_hash,name,public_key,created_at,expires_at,label) VALUES('${createHash('sha256').update(token).digest('hex')}','${name}','ed25519:${name}',${Date.now()},${Date.now()+86400000},'Private local fixture');`
  }
  writeFileSync(schema, sql)
  const wrangler = resolve('node_modules/.bin/wrangler')
  execFileSync(
    wrangler,
    [
      'd1',
      'execute',
      'settings-fixture',
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
  let heavyConfig = resolve('wrangler.cqx-heavy.jsonc')
  if (cqxFaults) {
    const entry = join(work, 'heavy.ts')
    writeFileSync(entry, `import Production from ${JSON.stringify(resolve('cqx-heavy.ts'))};
let mode = 'healthy';
export default class FaultFixture extends Production {
 configure(next){mode=next}
 open(id,files,label,build){
  if(mode==='outage') throw new Error('fixture heavy outage');
  return super.open(id,files,label,mode==='mismatch'?'wrong-build':build)
 }
}`)
    heavyConfig = join(work, 'heavy.json')
    writeFileSync(heavyConfig, JSON.stringify({ ...JSON.parse(readFileSync('wrangler.cqx-heavy.jsonc', 'utf8')), main: entry, build: { command: 'node ' + resolve('scripts/cqx-artifacts.mjs') }, send_metrics: false }))
  }
  const renderConfig=join(work,'render.json')
  writeFileSync(renderConfig,JSON.stringify({...JSON.parse(readFileSync('wrangler.render.jsonc','utf8')),main:resolve('.render/worker.mjs'),build:renderBuild?{command:'node '+resolve('scripts/render-build.mjs')}:undefined,durable_objects:{bindings:[{name:'REPO_INDEX',class_name:'RepoIndex',script_name:'gild-settings-fixture'}]},send_metrics:false}))
  const portServer = createServer()
  await new Promise((r) => portServer.listen(0, '127.0.0.1', r))
  const port = portServer.address().port
  await new Promise((r) => portServer.close(r))
  const origin = `http://127.0.0.1:${port}`,
    worker = spawn(
      wrangler,
      [
        'dev',
        '--inspector-port','0',
        '--local',
        '--config',
        config,
        ...(cqxModules ? ['--config', heavyConfig] : []),
        '--config',renderConfig,
        '--persist-to',
        state,
        '--port',
        String(port),
      ],
      { env: {...process.env, WRANGLER_REGISTRY_PATH: join(work,'registry')}, stdio: ['ignore', 'pipe', 'pipe'] },
    )
  let logs = ''
  for (const stream of [worker.stdout, worker.stderr])
    stream.on('data', (b) => {
      logs += b
      writeFileSync(join(work, 'wrangler.log'), logs)
    })
  const cookie = (name, displayName = name) => {
    const payload = Buffer.from(
      JSON.stringify({ publicKey: 'ed25519:' + name, name: displayName, at: now }),
    ).toString('base64url')
    return (
      payload +
      '.' +
      createHmac('sha256', sessionSecret).update(payload).digest('base64url')
    )
  }

  return {
    work,
    gitRoot,
    git,
    seedRepo,
    metadata,
    tokens,
    server,
    origin,
    worker,
    cookie,
    sessionSecret,
    sha,
    orgSha,
    config,
    state,
    get logs() {
      return logs
    },
  }
}
