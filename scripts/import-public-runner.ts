/** Child of import-local.mjs: actual importer and public REST data. `gh api`
 * uses its existing read credential; no token is read/copied into this test. */
import { pathToFileURL } from 'node:url'
import { readFile,writeFile,mkdir,readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { match } from '../lib/api/routing.ts'
// Match the compiled CLI fixture override while keeping CI's sibling default.
const { executeImport } = await import(pathToFileURL(resolve(process.env.GILD_TEST_CLI_DIR || '../gild-cli', 'src/import/execute.ts')).href) as typeof import('../../gild-cli/src/import/execute.ts')
const covered=new Set<string>()
const [server,jobPath,root,out,fixturePath,publicCache]=process.argv.slice(2),job=JSON.parse(await readFile(jobPath,'utf8')),rawFetch=globalThis.fetch
const counts={issues:new Set<number>(),pulls:new Set<number>(),comments:new Set<string>(),reviews:new Set<number>(),labels:new Set<string>()}
let calls=0,cacheHits=0,maxRequestBytes=0,readerChanges=0,importChangesBeforeReader=0
const sourceCache=publicCache||join(root,'source-cache')
await mkdir(sourceCache,{recursive:true})
globalThis.fetch=async(input:any,init?:any)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.toString():input.url)
  if(url.hostname!=='api.github.com'){const route=match(init?.method??'GET',url.pathname.replace(/^\/api\/v1/,''))?.route;if(route)covered.add(route.id);if(init?.body)maxRequestBytes=Math.max(maxRequestBytes,Buffer.byteLength(String(init.body)));return rawFetch(input,init)}
  if(fixturePath && url.pathname.endsWith('/pulls/3/reviews')) {
    const reader=process.env.GILD_IMPORT_READER_TOKEN
    if(!reader)throw Error('Missing disposable reader fixture')
    const before=await (await rawFetch(server+'/__fixture/import-counters?repository='+job.repository)).json() as any
    importChangesBeforeReader=before.changes
    if(before.changes!==0)throw Error('Imported pushes expanded historical diffs before any reader')
    const headers={authorization:'Bearer '+reader}
    let branches:Response
    for(let attempt=0;;attempt++) {
      branches=await rawFetch(server+'/api/v1/repos/'+job.repository+'/branches',{headers,signal:AbortSignal.timeout(60000)})
      if(branches.ok)break
      if(![409,503].includes(branches.status)||attempt>=120)throw Error('Reader branch listing failed: '+branches.status)
      await branches.body?.cancel()
      await new Promise(resolve=>setTimeout(resolve,500))
    }
    const listing=await branches.text()
    if(listing.includes('import/pr/'))throw Error('Internal PR branch leaked to readers')
    for(const protocol of ['0','2']) {
      const clone=join(root,'during-import-v'+protocol)
      await promisify(execFile)('git',['-c','protocol.version='+protocol,'clone',server+'/'+job.repository+'.git',clone],{env:{...process.env,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_VALUE_0:'Authorization: Bearer '+reader},timeout:60000})
      const head=await promisify(execFile)('git',['symbolic-ref','--short','HEAD'],{cwd:clone})
      if(head.stdout.trim()!=='master')throw Error('Mid-import clone did not select master')
      const refs=await promisify(execFile)('git',['for-each-ref','--format=%(refname)','refs/remotes'],{cwd:clone})
      if(refs.stdout.includes('import/pr/') || /(?:^|\n)refs\/remotes\/origin\/_meta\n/.test(refs.stdout))throw Error('Internal refs leaked into a clone')
    }
    readerChanges=((await (await rawFetch(server+'/__fixture/import-counters?repository='+job.repository)).json()) as any).changes
    console.log('Mid-import readers: branch list and v0/v2 clones select master and hide internal refs')
  }
  const accept=init.headers.accept,key=createHash('sha256').update(url.toString()+'\0'+accept).digest('hex'),file=join(sourceCache,key+'.json')
  let saved=fixturePath?JSON.stringify({status:200,body:fixture(new URL(url),accept)}):await readFile(file,'utf8').catch(()=>null)
  if(saved)cacheHits++
  else {
    const args=['api','--include',url.toString(),'-H','Accept: '+accept,'-H','X-GitHub-Api-Version: 2026-03-10']
    const {stdout}=await promisify(execFile)('gh',args,{maxBuffer:32*1024*1024})
    const delimiter=/\r?\n\r?\n/.exec(stdout);if(!delimiter)throw Error('Missing source REST headers')
    const head=stdout.slice(0,delimiter.index),remaining=Number(/x-ratelimit-remaining:\s*(\d+)/i.exec(head)?.[1]??1000)
    if(remaining<500)throw Error('Public proof stopped with 500 shared GitHub requests reserved')
    const status=Number(/^HTTP\/[^ ]+ (\d+)/.exec(head)?.[1]??500),body=stdout.slice(delimiter.index+delimiter[0].length)
    saved=JSON.stringify({status,body});await writeFile(file,saved);calls++
  }
  const {status,body}=JSON.parse(saved!)
  if(accept!=='application/vnd.github.patch') {
    const data=JSON.parse(body),path=url.pathname
    if(Array.isArray(data))for(const item of data) {
      if(path.endsWith('/issues')){if(!item.pull_request)counts.issues.add(item.number)}
      else if(path.endsWith('/pulls'))counts.pulls.add(item.number)
      else if(path.endsWith('/labels'))counts.labels.add(item.name)
      else if(path.endsWith('/reviews')){if(item.submitted_at)counts.reviews.add(item.id)}
      else if(path.endsWith('/comments'))counts.comments.add(path.includes('/pulls/')?'inline:'+item.id:'note:'+item.id)
    }
  }
  return new Response(body,{status,headers:{'content-type':accept==='application/vnd.github.patch'?'text/plain':'application/json'}})
}
const fixtureData=fixturePath?JSON.parse(await readFile(fixturePath,'utf8')):null
function fixture(url:URL,accept:string) {
  if(accept==='application/vnd.github.patch') return 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n'
  if(url.searchParams.has('page') && url.searchParams.get('page')!=='1')return '[]'
  const path=url.pathname.replace('/repos/jonschlinkert/is-number','')
  return JSON.stringify(fixtureData[path]??[])
}
// On a resumed proof, include public REST responses read before the checkpoint.
// These are the same immutable test snapshot used by the earlier attempt.
if(publicCache) {
  const project=new URL(job.source).pathname.replace(/^\//,'').replace(/\.git$/,'')
  const info=await (await globalThis.fetch('https://api.github.com/repos/'+project,{headers:{accept:'application/vnd.github+json'}})).json() as any
  const prefixes=['https://api.github.com/repos/'+info.full_name+'/','https://github.com/'+info.full_name+'/']
  for(const file of await readdir(sourceCache))try {
    const data=JSON.parse(JSON.parse(await readFile(join(sourceCache,file),'utf8')).body)
    if(!Array.isArray(data))continue
    for(const item of data) {
      const url=item.url??item.html_url??''
      if(!prefixes.some(prefix=>url.startsWith(prefix)))continue
      if(item.submitted_at)counts.reviews.add(item.id)
      else if(item.number) (item.pull_request||url.includes('/pulls/')?counts.pulls:counts.issues).add(item.number)
      else if(url.includes('/issues/comments/'))counts.comments.add('note:'+item.id)
      else if(url.includes('/pulls/comments/'))counts.comments.add('inline:'+item.id)
      else if(url.includes('/labels/'))counts.labels.add(item.name)
    }
  }catch{}
}
const started=performance.now(),status=await executeImport(server,job,root,new AbortController().signal,message=>{if(!message.startsWith('Receiving'))console.log(message)},globalThis.fetch)
await writeFile(out,JSON.stringify({source:job.source,status,covered:[...covered],sourceCounts:Object.fromEntries(Object.entries(counts).map(([key,value])=>[key,value.size])),calls,cacheHits,maxRequestBytes,readerChanges,importChangesBeforeReader,elapsed_ms:performance.now()-started,max_rss_kib:process.resourceUsage().maxRSS},null,2))
