import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemFS } from './memfs.ts'
import { DIR,readJson } from './meta-files.ts'
import { applyImportBatch } from './import/apply.ts'
import { ImportJob } from './import/job.ts'
import { sourceURL,metadata,authorLabel,rewriteLinks } from './import/source.ts'
import { importRecord,importInput } from './api/import-contract.ts'
const at='2020-01-02T03:04:05.000Z', imported={forge:'github' as const,id:'issue:1',url:'https://github.com/x/y/issues/1',author:'alice',updatedAt:at}
function storage(){const data=new Map<string,unknown>();return {data,alarm:0,async get<T>(key:string){return data.get(key) as T|undefined},async put(key:string,value:unknown){data.set(key,structuredClone(value))},async setAlarm(at:number){this.alarm=at},async deleteAlarm(){this.alarm=0}}}
test('metadata writes preserve attribution, time, states, comments and deterministic replay without touching ACL',async()=>{
  const fs=new MemFS();await fs.writeFile(DIR+'/.gild/next','1\n');await fs.writeFile(DIR+'/.gild/acl.json','{"visibility":"private"}')
  const records=[importRecord.parse({kind:'issue',number:1,title:'Imported',body:'body',createdAt:at,state:'closed',labels:['bug'],imported}),importRecord.parse({kind:'comment',number:1,target:'issue',id:'note:100',body:'reply',createdAt:at,imported:{...imported,id:'note:100'}})]
  assert.equal(await applyImportBatch(fs,records),true)
  const issue=await readJson<any>(fs,DIR+'/.gild/1/issue/issue.json')
  assert.equal(issue.author,'github:alice');assert.equal(authorLabel(issue.author),'imported from @alice on GitHub');assert.equal(issue.createdAt,at);assert.equal(issue.state,'closed');assert.equal(await fs.readFile(DIR+'/.gild/next',{encoding:'utf8'}),'2\n')
  assert.equal(await applyImportBatch(fs,records),false);assert.equal((await fs.readdir(DIR+'/.gild/1/issue')).filter(f=>f.startsWith('c-')).length,1)
  assert.equal(await fs.readFile(DIR+'/.gild/acl.json',{encoding:'utf8'}),'{"visibility":"private"}')
  await assert.rejects(applyImportBatch(fs,[{...records[0],imported:{...imported,id:'issue:2'}} as any]),/conflicts/)
})
test('expired leases resume checkpoints; one-shot tokens are encrypted and destroyed; mirror alarm and cutover stop sync',async()=>{
  const st=storage(),env={ACTIONS_SECRET_KEY:Buffer.alloc(32,4).toString('base64')};let now=1000
  let job=new ImportJob(st,env,()=>now)
  await job.create('owner/repo',importInput.parse({url:'https://github.com/x/y',source_token:'private-marker'}))
  assert.ok(!JSON.stringify([...st.data]).includes('private-marker'))
  const claimed=await job.claim();assert.equal(claimed?.source_token,'private-marker');assert.equal(await job.claim(),null)
  await assert.rejects(job.authorize('wrong'),/revoked/)
  await job.beginBatch(claimed!.token);await assert.rejects(job.beginBatch(claimed!.token),/already/)
  await job.endBatch(claimed!.token,{phase:'metadata',completed:5,message:'Imported',checkpoint:'checkpoint'})
  now+=120001;await job.alarm();job=new ImportJob(st,env,()=>now)
  const resumed=await job.claim();assert.equal(resumed?.checkpoint,'checkpoint');await assert.rejects(job.authorize(claimed!.token),/revoked/)
  await job.finish(resumed!.token,[]);assert.equal((await job.read()).cipher,null);assert.equal(st.alarm,0)
  const mirror=new ImportJob(storage(),env,()=>now);await mirror.create('owner/mirror',importInput.parse({url:'https://github.com/x/y',mirror:true,source_token:'mirror-marker'}))
  let lease=await mirror.claim();await assert.rejects(mirror.cutover(),/running/);await mirror.finish(lease!.token,[])
  assert.equal((await mirror.status()).state,'mirroring');now+=3600001;await mirror.alarm();lease=await mirror.claim();assert.equal(lease?.source_token,'mirror-marker');await mirror.finish(lease!.token,[])
  await mirror.cutover();now+=7200000;await mirror.alarm();assert.equal(await mirror.claim(),null);assert.equal((await mirror.read()).cipher,null)
})
test('GitHub REST imports issues, fork head PR, reviews, labels and milestones; resumes idempotently',async()=>{
  const paths:string[]=[],src=sourceURL('https://github.com/x/y'),fetcher=async(input:any,init:any)=>{
    const url=new URL(input);assert.equal(url.origin,'https://api.github.com');assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,'Bearer token-marker');paths.push(url.pathname)
    let data:any=[]
    if(url.searchParams.get('page') && url.searchParams.get('page')!=='1')return Response.json([])
    if(url.pathname.endsWith('/labels'))data=[{id:9,name:'bug',color:'ff0000',description:'Bug'}]
    else if(url.pathname.endsWith('/issues'))data=[{number:1,title:'Problem',body:'https://github.com/x/y/pull/2',created_at:at,updated_at:at,state:'closed',user:{login:'alice'},labels:[{name:'bug'}],milestone:{id:3,title:'v1'}}]
    else if(url.pathname.endsWith('/pulls'))data=[{number:2}]
    else if(url.pathname.endsWith('/pulls/2'))data={number:2,title:'Fix',body:'fix',created_at:at,updated_at:at,state:'open',user:{login:'bob'},base:{ref:'main'}}
    else if(url.pathname.endsWith('/reviews'))data=[{id:30,user:{login:'reviewer'},state:'APPROVED',body:'Yes',submitted_at:at,commit_id:'a'.repeat(40)}]
    else if(url.pathname.endsWith('/comments'))data=[{id:31,user:{login:'commenter'},body:'Hello',created_at:at,updated_at:at}]
    return Response.json(data)
  }
  const records:any[]=[];let checkpoint=''
  for await(const event of metadata({source:src,token:'token-marker',destination:'https://gild.gg/o/r',fetcher:fetcher as any,head:async()=> 'import/pr/2'})){records.push(...event.records);checkpoint=event.checkpoint??checkpoint}
  assert.equal(records.find(r=>r.kind==='issue').body,'https://gild.gg/o/r/pulls/2');assert.equal(records.find(r=>r.kind==='pull').head,'import/pr/2');assert.equal(records.find(r=>r.kind==='review').verdict,'approve');assert.ok(records.some(r=>r.name==='milestone:v1'))
  for(const record of records) importRecord.parse(record)
  let replayed=0;for await(const event of metadata({source:src,checkpoint,destination:'https://gild.gg/o/r',fetcher:fetcher as any,head:async()=>null}))replayed+=event.records.length
  assert.equal(replayed,0);assert.ok(paths.some(p=>p.endsWith('/pulls/2/comments')))
})
test('GitLab separate issue and merge request numbers, historical review notes, and missing-head patches',async()=>{
  const src=sourceURL('https://gitlab.com/team/sub/repo.git'),fetcher=async(input:any)=>{
    const u=new URL(input);if(u.searchParams.has('page') && u.searchParams.get('page')!=='1')return Response.json([])
    const common={iid:1,title:'item',description:'see https://gitlab.com/team/sub/repo/-/issues/1',created_at:at,updated_at:at,author:{username:'sam'},labels:[],state:'opened',target_branch:'main'}
    let data:any=[]
    if(u.pathname.endsWith('/issues'))data=[common]
    if(u.pathname.endsWith('/merge_requests'))data=[common]
    if(u.pathname.endsWith('/merge_requests/1'))data=common
    if(u.pathname.endsWith('/diffs'))data=[{old_path:'a',new_path:'a',diff:'@@ -1 +1 @@\n-old\n+new\n'}]
    if(u.pathname.endsWith('/notes'))data=[{id:9,body:'approved this merge request',system:true,created_at:at,updated_at:at,author:{username:'sam'}}]
    if(u.pathname.endsWith('/discussions'))data=[{notes:[{id:9,body:'approved this merge request',system:true,created_at:at,updated_at:at,author:{username:'sam'}}]}]
    return Response.json(data)
  }
  const records:any[]=[];for await(const event of metadata({source:src,destination:'https://gild.gg/o/r',fetcher:fetcher as any,head:async()=>null}))records.push(...event.records)
  assert.equal(records.find(r=>r.kind==='issue').number,1);assert.equal(records.find(r=>r.kind==='pull').number,2);assert.equal(records.filter(r=>r.kind==='pull').at(-1).patchParts,1);assert.equal(records.find(r=>r.kind==='patch').text.includes('+new'),true);assert.equal(records.find(r=>r.kind==='review').verdict,'approve')
  for(const r of records)importRecord.parse(r)
  assert.equal(rewriteLinks('https://gitlab.com/team/sub/repo/-/merge_requests/1',src,'https://gild.gg/o/r'),'https://gild.gg/o/r/pulls/2')
})
test('source URLs reject embedded credentials and unsafe Git transports',()=>{
  for(const url of ['ext::sh','file:///etc','https://x:secret@github.com/o/r','http://localhost/x','https://github.com/o/r?token=secret'])assert.throws(()=>sourceURL(url))
  assert.equal(sourceURL('git@gitlab.com:org/repo.git').api,'https://gitlab.com/api/v4/projects/org%2Frepo')
  const ssh=sourceURL('ssh://git@gitlab.example:2222/team/repo.git','gitlab')
  assert.equal(ssh.api,'https://gitlab.example/api/v4/projects/team%2Frepo')
  assert.equal(rewriteLinks('https://gitlab.example/team/repo/-/issues/3',ssh,'https://gild.gg/o/r'),'https://gild.gg/o/r/issues/5')
})
test('renamed forge API projects follow bounded same-origin redirects without forwarding tokens elsewhere',async()=>{
  const paths:string[]=[],src=sourceURL('https://github.com/old/repo')
  const fetcher=async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input));paths.push(url.pathname)
    assert.equal(url.origin,'https://api.github.com');assert.equal((init?.headers as any).authorization,'Bearer source-marker')
    if(url.pathname.startsWith('/repos/old/'))return new Response(null,{status:301,headers:{location:'https://api.github.com/repositories/123'+url.pathname.replace('/repos/old/repo','')}})
    return Response.json(url.pathname==='/repositories/123/issues'?[{number:1,title:'Moved issue',body:'https://github.com/new/repo/issues/1',created_at:at,updated_at:at,state:'open',user:{login:'alice'},labels:[],html_url:'https://github.com/new/repo/issues/1'}]:[])
  }
  const records:any[]=[]
  await assert.doesNotReject(async()=>{for await(const event of metadata({source:src,token:'source-marker',destination:'https://gild.gg/o/r',head:async()=>null,fetcher})){records.push(...event.records)}})
  assert.equal(records.find(r=>r.kind==='issue').body,'https://gild.gg/o/r/issues/1')
  assert.ok(paths.includes('/repositories/123/labels'))
  let calls=0
  const unsafe=async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://other.test/api/v4/projects/secret'}})}
  await assert.rejects(async()=>{for await(const _ of metadata({source:src,token:'source-marker',destination:'https://gild.gg/o/r',head:async()=>null,fetcher:unsafe})){}},/same forge API origin/)
  assert.equal(calls,1)
})

test('Git pack forwarding is lazy, preserves bytes across split packets, and bounds command headers',async()=>{
  const {streamPush}=await import('./git-push-stream.ts')
  const line=`${'0'.repeat(40)} ${'a'.repeat(40)} refs/heads/main\0report-status\n`,header=new TextEncoder().encode((line.length+4).toString(16).padStart(4,'0')+line+'0000')
  let reads=0,packChunks=0
  const stream=new ReadableStream<Uint8Array>({pull(c){reads++;if(reads===1)c.enqueue(header.slice(0,3));else if(reads===2)c.enqueue(header.slice(3));else if(packChunks++<2048)c.enqueue(new Uint8Array(65536));else c.close()}},{highWaterMark:0})
  const request=new Request('https://gild.gg/o/r.git/git-receive-pack',{method:'POST',body:stream,duplex:'half'} as any)
  const pushed=await streamPush(request)
  assert.ok(reads<10,'128 MiB pack must not be read before authorization');assert.deepEqual(pushed.refs,['refs/heads/main'])
  const reader=pushed.body.getReader();let bytes=0;while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.length}
  assert.equal(bytes,header.length+128*1024*1024)
  await assert.rejects(streamPush(new Request('https://gild.gg',{method:'POST',body:'0005x0000'})),/Invalid Git ref/)
})

test('large source bodies materialize from bounded batches and remain unchanged on replay',async()=>{
  const src=sourceURL('https://gitlab.com/team/repo'),body='large description '.repeat(40000),fetcher=async(input:any)=>{
    const u=new URL(input);return Response.json(u.pathname.endsWith('/issues')?[{iid:1,title:'Large',description:body,created_at:at,updated_at:at,state:'opened',author:{username:'alice'},labels:[]}]:[])
  }
  const records:any[]=[];for await(const event of metadata({source:src,destination:'https://gild.gg/o/r',fetcher:fetcher as any,head:async()=>null}))records.push(...event.records)
  const fs=new MemFS();for(const r of records){importRecord.parse(r);assert.ok(JSON.stringify(r).length<33000);await applyImportBatch(fs,[r])}
  assert.equal((await readJson<any>(fs,DIR+'/.gild/1/issue/issue.json')).body,body)
  for(const r of records)assert.equal(await applyImportBatch(fs,[r]),false)
})
test('a token import is private unless the caller asks for public',async()=>{
  const { destinationPrivate }=await import('./import/fence.ts')
  assert.equal(destinationPrivate(importInput.parse({url:'https://github.com/x/y',source_token:'t'})),true)
  assert.equal(destinationPrivate(importInput.parse({url:'https://github.com/x/y',source_token:'t',private:false})),false)
  assert.equal(destinationPrivate(importInput.parse({url:'https://github.com/x/y'})),false)
  assert.equal(destinationPrivate(importInput.parse({url:'https://github.com/x/y',private:true})),true)
})
test('pushes are refused while an import or mirror owns the refs, and allowed after cutover',async()=>{
  const { importOwnsRefs }=await import('./import/fence.ts')
  const rows=new Map<string,string>()
  const db={prepare:(q:string)=>({bind:(repo:unknown)=>({first:async<T>()=>{const state=rows.get(String(repo).toLowerCase());const owning=[...q.matchAll(/'(\w+)'/g)].map(m=>m[1]);return (state&&owning.includes(state)?{state}:null) as T|null}})})}
  for(const state of ['queued','running','mirroring','failed']){rows.set('owner/repo',state);assert.equal(await importOwnsRefs(db,'Owner/Repo'),true,state)}
  for(const state of ['complete','cutover']){rows.set('owner/repo',state);assert.equal(await importOwnsRefs(db,'owner/repo'),false,state)}
  rows.clear();assert.equal(await importOwnsRefs(db,'owner/repo'),false)
})
test('a mirror that synced once can be cut over after its source fails; a never-synced one cannot',async()=>{
  const env={ACTIONS_SECRET_KEY:Buffer.alloc(32,4).toString('base64')};let now=1000
  const summary={branches:1,tags:0,commits:3,records:0,elapsed_ms:10}
  const mirror=new ImportJob(storage(),env,()=>now);await mirror.create('owner/mirror',importInput.parse({url:'https://github.com/x/y',mirror:true,source_token:'m'}))
  let lease=await mirror.claim();await mirror.finish(lease!.token,[],undefined,summary)
  now+=3600001;await mirror.alarm();lease=await mirror.claim();await mirror.finish(lease!.token,[],'source down')
  assert.equal((await mirror.status()).state,'failed')
  await mirror.cutover();assert.equal((await mirror.status()).state,'cutover');assert.equal((await mirror.read()).cipher,null)
  const fresh=new ImportJob(storage(),env,()=>now);await fresh.create('owner/fresh',importInput.parse({url:'https://github.com/x/y',mirror:true}))
  lease=await fresh.claim();await fresh.finish(lease!.token,[],'source down')
  await assert.rejects(fresh.cutover(),/Complete an import/)
})

test('source rate limits wait up to fifteen minutes, report a countdown, stop beyond it and abort safely',async()=>{
  const {rateLimitReset}=await import('./import/source.ts')
  const start=Date.parse('2026-10-09T12:00:00Z')
  assert.equal(rateLimitReset(new Response(null,{status:403,headers:{'x-ratelimit-remaining':'1'}}),start),null)
  for(const status of [403,429]) {
    let now=start,calls=0;const logs:string[]=[],waits:number[]=[]
    for await(const _ of metadata({source:sourceURL('https://github.com/x/y'),destination:'https://gild.gg/o/r',head:async()=>null,now:()=>now,wait:async ms=>{waits.push(ms);now+=ms},log:m=>logs.push(m),fetcher:async()=>++calls===1?new Response(null,{status,headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':String((start+900000)/1000)}}):Response.json([])})){}
    assert.equal(waits.reduce((a,b)=>a+b,0),900000);assert.ok(logs[0].includes('900s'));assert.ok(logs.at(-1)?.includes('1s'));assert.equal(calls,4)
  }
  let waits=0
  await assert.rejects(async()=>{for await(const _ of metadata({source:sourceURL('https://github.com/x/y'),destination:'x',head:async()=>null,now:()=>start,wait:async()=>{waits++},fetcher:async()=>new Response(null,{status:429,headers:{'retry-after':'901'}})})){}},/2026-10-09T12:15:01.000Z.*gh auth login.*resume/)
  assert.equal(waits,0)
  const controller=new AbortController();let logged=false
  await assert.rejects(async()=>{for await(const _ of metadata({source:sourceURL('https://github.com/x/y'),destination:'x',head:async()=>null,signal:controller.signal,log:()=>{logged=true;controller.abort()},fetcher:async()=>new Response(null,{status:403,headers:{'retry-after':'1'}})})){}},/abort|cancel/i)
  assert.equal(logged,true)
})
