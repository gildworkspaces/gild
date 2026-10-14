import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
mkdirSync('.tmp',{recursive:true})
const cases=[
 ['active-namespace','lib/import/visibility.ts'," AND state IN ('queued','running','mirroring','failed')",'','Git ACL reads carry only active','lib/import-visibility.test.ts'],
 ['acl-namespace','lib/drivers/d1.ts','(${internalPrefixQuery})','CASE WHEN ? IS NULL THEN NULL ELSE NULL END','Git ACL reads carry only active','lib/import-visibility.test.ts'],
 ['rate-limits','lib/import/source.ts','if(reset!==null) {','if(false) {','source rate limits','lib/import.test.ts'],
 ['advertisement','lib/git-default.ts','if(internalPrefix)','if(false)','import readers see source HEAD','lib/git-default.test.ts'],
 ['unrestricted-discovery','lib/git-default.ts'," || !body.includes('ref-prefix HEAD\\n')",'','unrestricted v2 ref discovery','lib/git-default.test.ts'],
 ['branch-list','lib/repo-refs.ts','&& visibleImportRef(r.ref.slice(11),internalPrefix)','&& true','branch listings hide only','lib/git-default.test.ts'],
]
for(const [name,path,before,after,pattern,test] of cases){
 const original=readFileSync(path,'utf8')
 try {
  assert.ok(original.includes(before));writeFileSync(path,original.replace(before,after))
  const r=spawnSync(process.execPath,['--test','--test-name-pattern='+pattern,test],{encoding:'utf8',timeout:60000})
  writeFileSync('.tmp/revert-'+name+'.log',r.stdout+r.stderr)
  assert.notEqual(r.status,0);assert.match(r.stdout+r.stderr,name==='rate-limits'?/Error: Source API 403/:/AssertionError|ERR_ASSERTION/);assert.doesNotMatch(r.stdout+r.stderr,/SyntaxError/)
  console.log('PASS revert '+name)
 } finally {writeFileSync(path,original)}
}
const migration='migrations/0019_import_internal_refs.sql',colliding='migrations/0018_import_internal_refs.sql'
try {
 renameSync(migration,colliding)
 const r=spawnSync(process.execPath,['--test','--test-name-pattern=import migration upgrades','lib/import-visibility.test.ts'],{encoding:'utf8',timeout:60000})
 writeFileSync('.tmp/revert-migration-number.log',r.stdout+r.stderr)
 assert.notEqual(r.status,0);assert.match(r.stdout+r.stderr,/no such column: internal_prefix/)
 console.log('PASS revert migration-number: live-schema upgrade cannot add the import column')
} finally {renameSync(colliding,migration)}
if(process.argv.includes('--worker') || process.argv.includes('--review')) {
 const cases=[
  ['per-request-query','lib/gitproxy.ts','const internalPrefix = policy.internalPrefix',"const internalPrefix = await (await import('./import/visibility')).internalPrefix(((await getCloudflareContext()).env as unknown as {DB:import('./import/fence').FenceDB}).DB, `${params.owner}/${repoName}`)"],
  ['flush-only','lib/gitproxy.ts','if (!pushed.updates.length)','if (false)'],
  ['cleanup','lib/import/finish.ts','  for(const ref of refs) {\n    const fs=new','  if(false) for(const ref of refs) {\n    const fs=new'],
  ['retain-heads','lib/import/finish.ts','historical:true,parents','historical:true'],
 ]
 const run=(name,args)=>{const r=spawnSync(args[0],args.slice(1),{encoding:'utf8',timeout:300000,maxBuffer:8*1024*1024});writeFileSync('.tmp/revert-'+name+'.log',r.stdout+r.stderr);return r}
 for(const [name,path,before,after] of cases.filter(c=>!process.argv.includes('--review') || ['per-request-query','flush-only'].includes(c[0]))) {
  const original=readFileSync(path,'utf8')
  try {
   assert.ok(original.includes(before));writeFileSync(path,original.replace(before,after))
   assert.equal(run(name+'-build',['bun','run','build:cloudflare']).status,0)
   const r=run(name,[process.execPath,'scripts/import-local.mjs'])
   assert.notEqual(r.status,0);assert.match(r.stdout+r.stderr,/AssertionError|ERR_ASSERTION|Command failed: git.*(?:merge-base|push)/);assert.doesNotMatch(r.stdout+r.stderr,/SyntaxError/)
   console.log('PASS Worker revert '+name)
  } finally {writeFileSync(path,original)}
 }
 assert.equal(run('restored-build',['bun','run','build:cloudflare']).status,0)
 assert.equal(run('restored-worker',[process.execPath,'scripts/import-local.mjs']).status,0)
 console.log('PASS restored Worker import, branch list and native v0/v2 clones')
}
