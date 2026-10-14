import { forgeFixture } from './forge-fixture.mjs'
import { writeFileSync,readFileSync,mkdirSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { spawn,execFileSync,execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
import {launchChrome} from './chrome.mjs'
import {createHash,randomBytes} from 'node:crypto'
import { routes } from '../lib/api/contract.ts'
import { match } from '../lib/api/routing.ts'
const covered=new Set()
const readinessOnly=process.argv.includes('--readiness-only')
const f=await forgeFixture({renderBuild:!readinessOnly,staticReview:readinessOnly}),{origin,tokens,work,gitRoot,git}=f
console.log('Import fixture: '+work)
const start=Date.now()
async function call(path,body,token=tokens.avatest,expected=200) {
  const method=body===undefined?'GET':'POST',route=match(method,path)?.route;if(route)covered.add(route.id)
  for(let attempt=0;;attempt++) {
    const response=await fetch(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)})
    const message=await response.clone().text()
    if(expected===200 && response.status===503 && message.includes('Repository is indexing') && attempt<120){await response.body?.cancel();await new Promise(resolve=>setTimeout(resolve,500));continue}
    assert.equal(response.status,expected,message);return response.json()
  }
}
const memory={samples:0,baseline_kib:0,peak_kib:0}
function memorySample(){try{const rows=execFileSync('ps',['-axo','pid,ppid,rss,comm'],{encoding:'utf8'}).trim().split('\n').slice(1).map(line=>{const [pid,ppid,rss,...command]=line.trim().split(/\s+/);return {pid:Number(pid),ppid:Number(ppid),rss:Number(rss),command:command.join(' ')}}),descendants=new Set([f.worker.pid]);let changed=true;while(changed){changed=false;for(const row of rows)if(descendants.has(row.ppid)&&!descendants.has(row.pid)){descendants.add(row.pid);changed=true}}const rss=rows.filter(r=>descendants.has(r.pid)&&r.command.endsWith('workerd')).reduce((sum,r)=>sum+r.rss,0);if(rss){memory.samples++;memory.baseline_kib ||= rss;memory.peak_kib=Math.max(memory.peak_kib,rss)}}catch{}}
const memoryTimer=setInterval(memorySample,1000)
const pageTimings=[]
const runs=[],publicProof=process.argv.includes('--public')
let childEnv=process.env,fixturePath
if(publicProof){mkdirSync('.tmp/import-source-cache',{recursive:true});childEnv={...process.env}}
if(!publicProof){
  const at='2020-01-02T03:04:05.000Z',user={login:'source-user'},common={created_at:at,updated_at:at,user,labels:[{name:'bug'}],body:'See https://github.com/jonschlinkert/is-number/issues/1'}
  fixturePath=join(work,'source-api.json');writeFileSync(fixturePath,JSON.stringify({
    '/labels':[{id:1,name:'bug',color:'ff0000',description:'Bug'}],
    '/issues':[{...common,number:1,title:'Source issue',state:'closed',milestone:{id:5,title:'v1'}}],
    '/pulls':[{number:2},{number:3}],'/pulls/3':{...common,number:3,title:'Present head pull',state:'closed',base:{ref:'main'},head:{ref:'fixture-fork',sha:'b'.repeat(40),repo:{full_name:'fork/source'}}},'/pulls/2':{...common,number:2,title:'Source pull',state:'closed',base:{ref:'main'},head:{ref:'feature',sha:'a'.repeat(40),repo:{full_name:'fork/source'}}},
    '/issues/1/comments':[{...common,id:11,body:'Source comment'}],'/issues/2/comments':[{...common,id:12,body:'Pull comment'}],
    '/pulls/2/reviews':[{...common,id:13,body:'Approved',submitted_at:at,state:'APPROVED'}],'/pulls/2/comments':[{...common,id:14,body:'Inline',path:'README.md',line:1,side:'RIGHT'}]
  }));
  const sourceDir=join(gitRoot,'u-avatest','glance-test.git');git(sourceDir,'switch','--detach','main');writeFileSync(join(sourceDir,'import-head.txt'),'New source pull head');git(sourceDir,'add','.');git(sourceDir,'-c','commit.gpgsign=false','commit','-m','Fixture PR head');git(sourceDir,'update-ref','refs/pull/3/head','HEAD');git(sourceDir,'switch','main');
  const config=join(work,'source-git.config');writeFileSync(config,`[fetch]\n unpackLimit = 1\n[url "${`http://127.0.0.1:${f.server.address().port}`}/git/u-avatest/glance-test.git"]\n  insteadOf = https://github.com/jonschlinkert/is-number.git\n`);childEnv={...process.env,GIT_CONFIG_GLOBAL:config}
  // Like is-number: the source default is master and has no main branch.
  git(sourceDir,'branch','-m','main','master')
}
try {
  for(let attempt=0;;attempt++) {
    try{const response=await fetch(origin+'/api/v1/openapi.json',{signal:AbortSignal.timeout(1000)});if(response.ok)break}catch{}
    if(attempt>90)throw Error('Import fixture did not start: '+f.logs.slice(-3000));await new Promise(r=>setTimeout(r,250))
  }
  // A completed pre-migration job inherits import/pr but owns no refs now.
  const legacy=join(gitRoot,'o-settingstest','demo.git')
  git(legacy,'branch','import/pr/source','main')
  assert.equal((await fetch(origin+'/__fixture/legacy-import')).status,200)
  assert.equal((await fetch(origin+'/__fixture/refresh?owner=settingstest&repo=demo')).status,200)
  let legacyBranches
  const readinessEvidence=[]
  for(let attempt=0;;attempt++) {
    const response=await fetch(origin+'/api/v1/repos/settingstest/demo/branches',{headers:{authorization:'Bearer '+tokens.avatest}})
    if(readinessOnly)readinessEvidence.push({attempt,status:response.status,body:await response.clone().text(),calls:JSON.parse(response.headers.get('x-fixture-calls'))})
    if(response.ok){legacyBranches=await response.json();break}
    assert.ok([404,503].includes(response.status) && attempt<120,'fixture repository ACL/index must become ready: '+await response.text())
    await new Promise(resolve=>setTimeout(resolve,500))
  }
  assert.ok(legacyBranches.some(b=>b.name==='import/pr/source'),'completed legacy imports preserve real import/pr source branches')
  if(readinessOnly){
    writeFileSync('.tmp/import-readiness-compiled.json',JSON.stringify({work,readinessEvidence},null,2))
    const calls=readinessEvidence.at(-1).calls
    for(const key of ['render','queue','publication'])assert.equal(calls[key],0,'prepared import branches GET must not call '+key)
    assert.deepEqual(calls.doMethods,['API_CONTROL.rate','API_CONTROL.rate'],'only existing rate guards, no repository producer RPC')
    writeFileSync('.tmp/import-readiness-compiled.json',JSON.stringify({work,readinessEvidence},null,2))
    throw Object.assign(new Error('Readiness preflight complete'),{readinessOnly:true})
  }
  for(const protocol of ['0','2']) {
    const discovery=await promisify(execFile)('git',['-c','protocol.version='+protocol,'ls-remote',origin+'/settingstest/demo.git','refs/heads/import/pr/source'],{timeout:60000})
    assert.ok(discovery.stdout.includes('refs/heads/import/pr/source'),'native discovery sees completed legacy source branches')
  }
  const gitTimings=[]
  for(let attempt=0;attempt<2;attempt++) {
    const started=performance.now(),response=await fetch(origin+'/settingstest/demo.git/info/refs?service=git-upload-pack')
    assert.equal(response.status,200)
    assert.equal(response.headers.get('x-fixture-namespace-reads'),'0','ordinary Git discovery must not add a standalone D1 namespace query')
    await response.arrayBuffer();gitTimings.push(performance.now()-started)
  }
  console.log('Git discovery first/repeated ms: '+gitTimings.map(t=>t.toFixed(2)).join('/'))
  // The CLI routes an explicit user owner/name through /orgs/:owner/imports.
  // The server intentionally resolves the kind from storage, preserving ACLs.
  const explicitUser=await call('/orgs/avatest/imports',{url:'https://github.com/jonschlinkert/is-number.git',name:'explicit-user',private:true},tokens.avatest,202)
  assert.equal(explicitUser.repository,'avatest/explicit-user')
  const explicitTarget=join(gitRoot,'u-avatest','explicit-user.git')
  assert.deepEqual(JSON.parse(git(explicitTarget,'show','_meta:.gild/acl.json')).owners,['@avatest'])
  assert.equal(git(explicitTarget,'for-each-ref','--format=%(refname)','refs/heads'),'refs/heads/_meta','bootstrap must not create synthetic main')
  const emptyClone=join(work,'empty-import-clone')
  await promisify(execFile)('git',['clone',origin+'/avatest/explicit-user.git',emptyClone],{env:{...process.env,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_VALUE_0:'Authorization: Bearer '+tokens.avatest},timeout:60000})
  assert.notEqual(git(emptyClone,'symbolic-ref','--short','HEAD'),'_meta','before Git arrives, an import clones empty rather than checking out metadata')
  assert.equal(git(emptyClone,'for-each-ref','--format=%(refname)','refs/remotes'),'')
  const explicitLease=await call('/repos/avatest/explicit-user/import/claim',{})
  await call('/repos/avatest/explicit-user/import/finish',{warnings:[],error:'fixture'},explicitLease.token)
  await call('/orgs/avatest/imports',{url:'https://github.com/jonschlinkert/is-number.git',name:'denied-user'},tokens.second,403)
  // Private status/patch and the scoped lease must use the shared read policy.
  const orgImport=await call('/orgs/settingstest/imports',{url:'ssh://git@github.com:22/jonschlinkert/is-number.git',name:'org-import',private:true,source_token:'disposable-fixture-source'} ,tokens.avatest,202)
  assert.ok(orgImport.source.startsWith('ssh://'),'SSH Git sources may use a separate HTTPS metadata token')
  const orgJob=await call('/repos/settingstest/org-import/import/claim',{})
  assert.equal(orgJob.source_token,'disposable-fixture-source')
  await call('/repos/settingstest/org-import/import/heartbeat',{progress:{phase:'git',completed:0,message:'Fixture heartbeat'}},orgJob.token)
  // A command that points at an already stored object sends an empty pack.
  // An unchanged ref command must also return an ordinary success report.
  const existing=git(join(gitRoot,'o-settingstest','org-import.git'),'rev-parse','_meta'),emptyPack=Buffer.from('5041434b0000000200000000','hex')
  for(const before of ['0'.repeat(40),existing]) {
    const line=`${before} ${existing} refs/heads/test-head\0report-status\n`,commands=Buffer.from((Buffer.byteLength(line)+4).toString(16).padStart(4,'0')+line+'0000')
    const response=await fetch(origin+'/settingstest/org-import.git/git-receive-pack',{method:'POST',headers:{authorization:'Bearer '+orgJob.token,'content-type':'application/x-git-receive-pack-request'},body:Buffer.concat([commands,emptyPack,createHash('sha1').update(emptyPack).digest()]),signal:AbortSignal.timeout(60000)})
    assert.equal(response.status,200,await response.clone().text());assert.match(await response.text(),/ok refs\/heads\/test-head/)
  }

  // Native Git skips HTTP receive-pack for an up-to-date push. Its large
  // request auth probe is the real flush-only POST: force a small postBuffer
  // with an incompressible pack and prove Git accepts the empty 200 before
  // uploading the pack and updating the destination ref.
  // Assert decoded response bytes independently of Git/libcurl's trace format.
  const flush=await fetch(origin+'/settingstest/org-import.git/git-receive-pack',{method:'POST',headers:{authorization:'Bearer '+orgJob.token,'content-type':'application/x-git-receive-pack-request'},body:'0000',signal:AbortSignal.timeout(60000)})
  assert.equal(flush.status,200)
  assert.equal((await flush.arrayBuffer()).byteLength,0,'flush-only result must have an empty decoded body')
  const noopClone=join(work,'native-noop-clone'),nativeEnv={...process.env,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_VALUE_0:'Authorization: Bearer '+orgJob.token}
  await promisify(execFile)('git',['clone','-b','test-head',origin+'/settingstest/org-import.git',noopClone],{env:nativeEnv,timeout:60000})
  const nativeNoop=await promisify(execFile)('git',['push','origin','test-head'],{cwd:noopClone,env:{...nativeEnv,GIT_TRACE_CURL:'1'},timeout:60000})
  assert.match(nativeNoop.stderr,/Everything up-to-date/)
  assert.doesNotMatch(nativeNoop.stderr,/=> Send header: POST .*git-receive-pack/,'native up-to-date pushes need no receive-pack POST')
  writeFileSync(join(noopClone,'native-probe.bin'),randomBytes(256*1024))
  git(noopClone,'add','native-probe.bin');git(noopClone,'-c','commit.gpgsign=false','commit','-m','Fixture native HTTP probe')
  const nativeProbe=await promisify(execFile)('git',['-c','http.postBuffer=65520','push','origin','HEAD:refs/heads/native-probe'],{cwd:noopClone,env:{...nativeEnv,GIT_TRACE_CURL:'1'},timeout:60000,maxBuffer:4*1024*1024})
  const firstPost=nativeProbe.stderr.indexOf('=> Send header: POST'),secondPost=nativeProbe.stderr.indexOf('=> Send header: POST',firstPost+1)
  assert.ok(firstPost>=0 && secondPost>firstPost,'native Git must probe before uploading its pack')
  const probe=nativeProbe.stderr.slice(firstPost,secondPost)
  assert.match(probe,/=> Send header: content-length: 4/i,'native Git must send its four-byte flush-only auth probe')
  assert.match(probe,/=> Send data: 0000/)
  assert.match(probe,/<= Recv header: HTTP\/1\.1 200/)
  if(!/<= Recv header: content-length: 0/i.test(probe)) {
    assert.match(probe,/<= Recv header: transfer-encoding: chunked/i)
    // Git/libcurl may decode chunk framing before tracing received data.
    // Accept no data or the lone framing terminator; never accept payload.
    const data=[...probe.matchAll(/<= Recv data: (.*)/g)].map(m=>m[1])
    assert.ok(data.length===0 || (data.length===1 && data[0]==='0....'),'chunked probe trace must contain no payload bytes: '+JSON.stringify(data))
  }
  assert.equal(git(join(gitRoot,'o-settingstest','org-import.git'),'rev-parse','native-probe'),git(noopClone,'rev-parse','HEAD'),'native push must finish the real ref update after the probe')
  console.log('PASS native git push: flush-only auth probe, empty HTTP 200, real packed ref update; up-to-date push also succeeds')

  const fence=await (await fetch(origin+'/__fixture/import-fence',{method:'POST',body:JSON.stringify({repository:'settingstest/org-import'})})).json()
  try {
    await call('/repos/settingstest/org-import/import/heartbeat',{progress:{phase:'git',completed:0,message:'Heartbeat through ACL fence'}},orgJob.token)
    for(const token of [tokens.second,'gi_wrong'])assert.equal((await fetch(origin+'/api/v1/repos/settingstest/org-import/import/heartbeat',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:'{}'})).status,404)
  }finally{assert.equal((await fetch(origin+'/__fixture/import-fence',{method:'POST',body:JSON.stringify({repository:'settingstest/org-import',restore:fence})})).status,200)}
  const workflow=await call('/repos/settingstest/org-import/import/workflow',{file:'ci.yml',text:'on: schedule\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: unsupported/action@v1\n'},orgJob.token)
  assert.ok(workflow.warnings.some(w=>w.includes('schedule')))
  const unsupportedActions=await call('/repos/settingstest/org-import/import/workflow',{file:'unsupported-actions.yml',text:'on: push\njobs:\n  test:\n    runs-on: self-hosted\n    steps:\n      - uses: actions/upload-artifact@v4\n        with: {name: build, path: dist}\n      - uses: actions/cache@v4\n        with: {key: deps, path: node_modules}\n      - uses: actions/setup-node@v6\n        with: {node-version: "24", cache: npm}\n      - uses: actions/setup-go@v5\n        with: {go-version: "1.24", cache: true}\n'},orgJob.token)
  for(const error of ['actions/upload-artifact is unsupported: this runner has no artifact upload backend','actions/cache is unsupported: this runner has no dependency cache backend','actions/setup-node dependency caching is unsupported: remove the cache input to run without caching','actions/setup-go dependency caching is unsupported: remove the cache input to run without caching'])
    assert.ok(unsupportedActions.warnings.includes('unsupported-actions.yml: '+error),'real import HTTP response reports '+error)
  assert.ok(unsupportedActions.warnings.every(w=>!w.includes('no-op')))
  const withoutCache=await call('/repos/settingstest/org-import/import/workflow',{file:'without-cache.yml',text:'on: push\njobs:\n  test:\n    runs-on: self-hosted\n    steps:\n      - uses: actions/setup-node@v6\n        with: {node-version: "24", cache: false}\n'},orgJob.token)
  assert.deepEqual(withoutCache.warnings,[],'explicitly disabled caching remains supported through the import HTTP contract')
  console.log('PASS generated Actions contract: real import HTTP diagnostics reject artifact/cache requests; disabled cache remains supported')
  await call('/repos/settingstest/org-import/import/finish',{warnings:[],error:'fixture'},orgJob.token)
  assert.equal((await fetch(origin+'/api/v1/repos/settingstest/org-import/import',{headers:{authorization:'Bearer '+orgJob.token}})).status,404)
  assert.equal((await fetch(origin+'/api/v1/repos/settingstest/org-import/import',{headers:{authorization:'Bearer '+tokens.second}})).status,404)
  const orgMachine=await call('/orgs/settingstest/actions/runners',{name:'org-import-runner',os:'linux',arch:'x64',labels:[]},tokens.avatest,201)
  await call('/repos/settingstest/org-import/import/retry',{source_token:'disposable-fixture-retry'})
  const orgAssigned=await call('/orgs/settingstest/imports/poll',{},orgMachine.token);assert.equal(orgAssigned.source_token,'disposable-fixture-retry')
  await call('/repos/settingstest/org-import/import/finish',{warnings:[]},orgAssigned.token)
  const machine=await call('/users/avatest/actions/runners',{name:'import-runner',os:'linux',arch:'x64',labels:[]},tokens.avatest,201)
  for(const [name,url] of [['small','https://github.com/jonschlinkert/is-number.git'],...(publicProof?[['mid','https://github.com/ivmai/bdwgc.git']]:[])]) {
    const repository='avatest/import-'+name,status=await call('/user/imports',{url,name:'import-'+name,private:true,mirror:true},tokens.avatest,202)
    assert.equal(status.state,'queued');const times=[];for(let attempt=0;attempt<2;attempt++){const started=performance.now();assert.equal((await call('/repos/'+repository+'/import')).state,'queued');times.push(performance.now()-started)}pageTimings.push({repository,first_ms:times[0],repeated_ms:times[1]})
    const job=await call('/users/avatest/imports/poll',{},machine.token),jobFile=join(work,name+'-job.json'),evidence=join(work,name+'-evidence.json'),log=join(work,name+'-log.txt')
    writeFileSync(jobFile,JSON.stringify(job),{mode:0o600})
    const child=spawn(process.platform==='darwin'?'/usr/bin/time':'time',[...(process.platform==='darwin'?['-l']:['-v']),'bun',resolve('scripts/import-public-runner.ts'),origin,jobFile,work,evidence,...(fixturePath?[fixturePath]:['',resolve('.tmp/import-source-cache')])],{env:{...childEnv,GILD_IMPORT_READER_TOKEN:tokens.avatest},stdio:['ignore','pipe','pipe']})
    let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output+=b;writeFileSync(log,output)})
    const timer=setInterval(()=>console.log(name+': '+output.trim().split('\n').at(-1)),30000)
    const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)});clearInterval(timer)
    assert.equal(exit,0,output.slice(-3000))
    const data=JSON.parse(readFileSync(evidence,'utf8'));for(const id of data.covered??[])covered.add(id);const target=join(gitRoot,'u-avatest','import-'+name+'.git'),index=JSON.parse(git(target,'show','_meta:.gild/index.json'))
    assert.equal(index.issues.length,data.sourceCounts.issues);assert.equal(index.pulls.length,data.sourceCounts.pulls)
    const files=git(target,'ls-tree','-r','--name-only','_meta','.gild').split('\n')
    assert.equal(files.filter(p=>/\/(?:issue|pr)\/c-/.test(p)).length,data.sourceCounts.comments)
    assert.equal(files.filter(p=>/\/pr\/r-/.test(p)).length,data.sourceCounts.reviews)
    assert.ok(index.issues.every(i=>i.author.startsWith('github:')));assert.ok(index.pulls.every(p=>p.approvals.length===0 && p.changesRequested.length===0),'source review authority must not become gild approval')
    assert.ok(data.maxRequestBytes<=256*1024);assert.equal(data.status.state,'mirroring')
    if(!publicProof){assert.equal(data.status.summary.records,11,'PR Git progress must not reset metadata count');assert.ok(files.some(p=>p.includes('/3/pr/pr.json')));const sealedHead=JSON.parse(git(target,'show','_meta:.gild/3/pr/pr.json')).head;assert.match(sealedHead,/^[a-f0-9]{40}$/);git(target,'merge-base','--is-ancestor',sealedHead,'_meta');assert.equal(git(target,'for-each-ref','--format=%(refname)','refs/heads/import'),'');assert.equal(files.filter(p=>p.startsWith('.gild/events/')).length,0,'historical metadata must not emit fresh activity');const counters=await (await fetch(origin+'/__fixture/import-counters?repository='+repository)).json();assert.equal(data.importChangesBeforeReader,0,'imported pushes must not expand historical diffs before a reader explicitly requests them');assert.equal(counters.pending,0)}
    const targetRefs=new Map(git(target,'for-each-ref','--format=%(objectname) %(refname)','refs/heads','refs/tags').split('\n').map(line=>line.split(' ').reverse())),cache=join(work,'imports')
    // The native importer itself verifies every source ref before completion.
    assert.ok(targetRefs.has('refs/heads/_meta'));assert.ok(data.status.summary.commits>0)
    if(!publicProof){
      assert.equal(targetRefs.has('refs/heads/main'),false,'finished imports must have no synthetic main')
      assert.equal((await call('/repos/'+repository)).default_branch,'master')
      for(let attempt=0;;attempt++) {
        const page=await fetch(origin+'/'+repository,{headers:{cookie:'gild_session='+f.cookie('avatest')}})
        if(page.ok){assert.ok((await page.text()).includes('README.md'),'finished import page shows source code');break}
        assert.equal(page.status,409,'only pending indexing may delay the code page')
        assert.ok(attempt<60,'finished import code page must finish indexing')
        await new Promise(resolve=>setTimeout(resolve,500))
      }
      for(const protocol of ['0','2']) {
        const clone=join(work,'clone-'+name+'-v'+protocol)
        const discovery=await promisify(execFile)('git',['-c','protocol.version='+protocol,'ls-remote','--symref',origin+'/'+repository+'.git','HEAD'],{env:{...process.env,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_VALUE_0:'Authorization: Bearer '+tokens.avatest},timeout:60000})
        assert.ok(discovery.stdout.includes('ref: refs/heads/master\tHEAD'),'HEAD-only discovery must advertise master')
        await promisify(execFile)('git',['-c','protocol.version='+protocol,'clone',origin+'/'+repository+'.git',clone],{env:{...process.env,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_VALUE_0:'Authorization: Bearer '+tokens.avatest},timeout:60000})
        assert.equal(git(clone,'symbolic-ref','--short','HEAD'),'master')
        assert.equal(git(clone,'rev-parse','HEAD'),targetRefs.get('refs/heads/master'))
        assert.equal(readFileSync(join(clone,'README.md'),'utf8'),git(target,'show','master:README.md')+'\n')
      }
    }
    if(!publicProof){
      covered.add('importPatch');const patch=await fetch(origin+'/api/v1/repos/'+repository+'/import/pulls/2/patch',{headers:{authorization:'Bearer '+tokens.avatest}});assert.equal(patch.status,200);assert.ok((await patch.text()).includes('+new'))
      const denied=await fetch(origin+'/api/v1/repos/'+repository+'/import/pulls/2/patch',{headers:{authorization:'Bearer '+tokens.second}});assert.equal(denied.status,404)
    }
    const replay=await call('/repos/'+repository+'/import/retry',{}),again=await call('/repos/'+repository+'/import/claim',{})
    assert.equal(replay.state,'queued');assert.ok(again)
    // Re-run one saved issue batch through the real forge writer to prove stable paths and no duplicate comments.
    const first=index.issues[0]
    if(first){const item=JSON.parse(git(target,'show',`_meta:.gild/${first.number}/issue/issue.json`)),before=git(target,'rev-parse','_meta'),{author,schema,claim,updatedAt,...record}=item
      await call('/repos/'+repository+'/import/batch',{records:[{kind:'issue',...record}],progress:{phase:'metadata',completed:1,message:'Replay proof'}},again.token)
      assert.equal(git(target,'rev-parse','_meta'),before)}
    await call('/repos/'+repository+'/import/finish',{warnings:data.status.warnings},again.token)
    await call('/repos/'+repository+'/import/cutover',{})
    assert.equal((await call('/repos/'+repository+'/import')).state,'cutover')
    assert.equal(JSON.parse(git(target,'show','_meta:.gild/import/source.json')).readOnly,true)
    runs.push({...data,worker_rss:{...memory},time_output:output.split('\n').filter(line=>/real|user|sys|resident|maximum|page fault|faults|bytes/.test(line)).join('\n'),worker_request_max_bytes:data.maxRequestBytes})
    console.log(JSON.stringify({name,counts:data.sourceCounts,summary:data.status.summary,elapsed_ms:data.elapsed_ms,max_rss_kib:data.max_rss_kib,worker_request_max_bytes:data.maxRequestBytes}))
  }
  if(!publicProof){
    const browser=await launchChrome();mkdirSync('docs/import/screenshots',{recursive:true})
    try{for(const width of [400,1400])for(const theme of ['light','dark']){
      const context=await browser.newContext({viewport:{width,height:1000}});await context.addCookies([{name:'gild_session',value:f.cookie('avatest'),url:origin}]);await context.addInitScript(t=>localStorage.setItem('gild.theme',t),theme);const page=await context.newPage();
      for(const [name,path] of [['form','/import'],['summary','/avatest/import-small/import']]){await page.goto(origin+path);await page.getByRole('heading',{name:name==='form'?'Import repository':'Import avatest/import-small',exact:true}).waitFor();if(name==='form')await page.waitForFunction(()=>document.querySelector('select')?.options.length>0);if(name==='summary')await page.getByRole('status').filter({hasText:'cutover'}).waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');await page.screenshot({path:`docs/import/screenshots/${name}-${width}-${theme}.png`})}
      if(width===1400 && theme==='light'){
        await page.goto(origin+'/avatest/import-small/pulls/2');const downloading=page.waitForEvent('download');await page.getByRole('link',{name:'Download its original patch'}).click();const downloaded=await downloading;assert.ok(readFileSync(await downloaded.path(),'utf8').includes('+new'),'browser session authorizes private patch download')
        const outsider=await browser.newContext();await outsider.addCookies([{name:'gild_session',value:f.cookie('second'),url:origin}]);assert.equal((await outsider.request.get(origin+'/api/repos/avatest/import-small/import/pulls/2/patch')).status(),404);assert.equal((await outsider.request.get(origin+'/avatest/import-small/import')).status(),404);await outsider.close()
        await page.goto(origin+'/avatest/import-small/issues/1');await page.getByText('imported from @source-user on GitHub',{exact:false}).first().waitFor();await page.goto(origin+'/import');await page.getByLabel('Source URL').fill('https://github.com/jonschlinkert/is-number.git');await page.getByLabel('Repository name (optional)').fill('browser-import');await page.getByLabel('Private destination').check();await page.getByRole('button',{name:'Import repository',exact:true}).click();await page.waitForURL('**/avatest/browser-import/import');await page.getByRole('status').filter({hasText:'queued'}).waitFor();assert.equal((await call('/repos/avatest/browser-import')).private,true)
        const lease=await call('/repos/avatest/browser-import/import/claim',{})
        await fetch(origin+'/__fixture/import-index-pause?repository=avatest/browser-import&paused=1')
        try{
          await call('/repos/avatest/browser-import/import/heartbeat',{progress:{phase:'metadata',completed:123,message:'Import continues while projection is pending'}},lease.token)
          let statusRequests=0
          await page.route('**/api/repos/avatest/browser-import/import',route=>++statusRequests===1?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary status outage'})}):route.continue())
          assert.ok((await page.reload()).ok());await assert.doesNotReject(page.getByRole('status').filter({hasText:'running'}).waitFor({timeout:15000}),'progress must render while indexing is pending and recover after a temporary status failure');await page.getByText('Import continues while projection is pending',{exact:false}).waitFor()
          assert.ok(statusRequests>=2,'progress polling must recover after a transient failure');await page.unroute('**/api/repos/avatest/browser-import/import')
        }finally{await fetch(origin+'/__fixture/import-index-pause?repository=avatest/browser-import&paused=0');await call('/repos/avatest/browser-import/import/finish',{warnings:[],error:'fixture'},lease.token)}
      }
      await context.close()
    }}finally{await browser.close()}
  }
  if(!publicProof)assert.deepEqual(routes.filter(r=>r.id.startsWith('import')).map(r=>r.id).filter(id=>!covered.has(id)),[],'every import API operation must execute in integration')
  mkdirSync(publicProof?'docs/import':work,{recursive:true});writeFileSync(publicProof?'docs/import/public-evidence.json':join(work,'evidence.json'),JSON.stringify({at:new Date().toISOString(),local_worker:true,remote_writes:false,runs,pageTimings,wall_ms:Date.now()-start},null,2))
} catch(error){if(!error?.readinessOnly)throw error;console.log('PASS compiled import readiness preflight with no request-side producers')} finally {clearInterval(memoryTimer);f.worker.kill('SIGTERM');await new Promise(r=>f.server.close(r))}
