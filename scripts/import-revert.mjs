import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
mkdirSync('.tmp',{recursive:true})
const cases=[
 ['pending-heartbeat','lib/privacy-http.ts','? await s.pendingImportRead?.(request, owner, repo)','? false','a metadata fence preserves'],
 ['api-redirect','lib/import/source.ts','if([301,302,307,308].includes(response.status))','if(false)','renamed forge API projects'],
 ['metadata','lib/import/apply.ts','  let changed=false','  return false\n  let changed=false','metadata writes preserve'],
 ['credential-cleanup','lib/import/job.ts','if(!j.mirror) j.cipher=null','if(false) j.cipher=null','expired leases resume'],
 ['streaming','lib/git-push-stream.ts','  const reader=stream.getReader()','  stream=new Response(await new Response(stream).arrayBuffer()).body!\n  const reader=stream.getReader()','Git pack forwarding is lazy'],
 ['unborn-head','lib/git-default.ts','  if (!head) {','  if (false) {','unborn physical HEAD','lib/git-default.test.ts'],
 ['metadata-head','lib/git-meta-http.ts','response.statusCode !== 200','true','metadata clones and immutable snapshot fetches','lib/git-meta-http.test.ts'],
]
for(const [name,path,before,after,pattern,file] of cases){const original=readFileSync(path,'utf8');try{assert.ok(original.includes(before));writeFileSync(path,original.replace(before,after));const result=spawnSync(process.execPath,['--test','--test-name-pattern='+pattern,file??(name==='pending-heartbeat'?'lib/privacy.test.ts':'lib/import.test.ts')],{encoding:'utf8',timeout:60000});writeFileSync('.tmp/import-revert-'+name+'.log',result.stdout+result.stderr);assert.notEqual(result.status,0);assert.match(result.stdout+result.stderr,name==='metadata-head'?/NotFoundError.*HEAD|Could not resolve reference "HEAD"/:/AssertionError|ERR_ASSERTION/);assert.doesNotMatch(result.stdout+result.stderr,/SyntaxError/);console.log('PASS revert '+name+': removing behavior fails effect test')}finally{writeFileSync(path,original)}}
const restored=spawnSync(process.execPath,['--test','lib/privacy.test.ts','lib/import.test.ts','lib/git-default.test.ts','lib/git-meta-http.test.ts'],{encoding:'utf8',timeout:60000});assert.equal(restored.status,0,restored.stdout+restored.stderr);console.log('PASS restored import suite')
if(process.argv.includes('--artifacts-default')) {
  const path='lib/repos-write.ts',original=readFileSync(path,'utf8')
  const run=(name,args)=>{const result=spawnSync(args[0],args.slice(1),{encoding:'utf8',timeout:300000,maxBuffer:8*1024*1024});writeFileSync('.tmp/import-revert-'+name+'.log',result.stdout+result.stderr);return result}
  try {
    const broken=original.replace("createRepo(owner, name, description, 'main')","createRepo(owner, name, description,seedCode?'main':'_meta')")
    assert.notEqual(broken,original)
    writeFileSync(path,broken)
    assert.equal(run('artifacts-broken-build',['bun','run','build:cloudflare']).status,0)
    const result=run('artifacts-default',[process.execPath,'scripts/import-local.mjs'])
    assert.notEqual(result.status,0,'strict fixture must reject the original _meta default')
    assert.match(result.stdout+result.stderr,/Invalid default_branch: Invalid branch name/)
    assert.match(result.stdout+result.stderr,/503 !== 202/)
    console.log('PASS revert Artifacts default: _meta fails creation with the live validation message and HTTP 503')
  } finally {writeFileSync(path,original)}
  assert.equal(run('artifacts-restored-build',['bun','run','build:cloudflare']).status,0)
  assert.equal(run('artifacts-restored',[process.execPath,'scripts/import-local.mjs']).status,0)
  console.log('PASS restored strict Artifacts Worker/browser/native-clone suite')
}
if(process.argv.includes('--progress-page')) {
  const page='app/(portal)/(imports)/[owner]/[repo]/import/page.tsx',old='app/(portal)/[owner]/[repo]/import/page.tsx'
  const run=(name,args)=>{const result=spawnSync(args[0],args.slice(1),{encoding:'utf8',timeout:240000,maxBuffer:8*1024*1024});writeFileSync('.tmp/import-revert-'+name+'.log',result.stdout+result.stderr);return result}
  try {
    mkdirSync('app/(portal)/[owner]/[repo]/import',{recursive:true});renameSync(page,old)
    assert.equal(run('progress-build',['bun','run','build:cloudflare']).status,0)
    const result=run('progress-page',[process.execPath,'scripts/import-local.mjs'])
    assert.notEqual(result.status,0,'putting progress back behind the repository index must fail')
    assert.match(result.stdout+result.stderr,/AssertionError|ERR_ASSERTION/)
    console.log('PASS revert progress page: paused indexing prevents the browser from showing the import')
  } finally {renameSync(old,page)}
  assert.equal(run('progress-restored-build',['bun','run','build:cloudflare']).status,0)
  assert.equal(run('progress-restored',[process.execPath,'scripts/import-local.mjs']).status,0)
  console.log('PASS restored Worker/browser import suite, including transient poll failure and private patch download')
}
