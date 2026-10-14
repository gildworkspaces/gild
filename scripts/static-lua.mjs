// Manual timing evidence against the same complete public Lua tree.
// Build both trees first; baseline must be an archived checkout, not a new worktree.
// node scripts/static-lua.mjs --source <public Lua checkout> [--baseline <built #57 archive>]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const root=resolve('.')
const option=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1]}
const baseline=option('--baseline')
const before=!!baseline,base=before?resolve(baseline):root
const source=resolve(option('--source')??'.tmp/static-review/live-lua')
const git=(...args)=>execFileSync('git',args,{cwd:source})
const entries=git('ls-tree','-r','HEAD').toString().trim().split('\n').map(row=>{const [metadata,path]=row.split('\t');return {path,mode:metadata.split(' ')[0]}})
const paths=entries.map(row=>row.path)
const sources=entries.map(({path,mode})=>({path,mode,text:git('show','HEAD:'+path)}))
globalThis.__luaSources=sources
process.chdir(base)
let fixture=readFileSync('scripts/forge-fixture.mjs','utf8')
fixture=fixture.replace("'../lib/api/contract.ts'",JSON.stringify(base+'/lib/api/contract.ts')).replace("'../lib/api/routing.ts'",JSON.stringify(base+'/lib/api/routing.ts'))
fixture=fixture.replace("for (const f of sources) write(f.path, f.text)", "for (const f of sources) { write(f.path, f.text); if(f.mode==='100755')execFileSync('chmod',['755',join(dir,f.path)]) }")
fixture=fixture.replace("git(dir, 'add', '.')", "git(dir, 'add', '-f', '.')")
fixture=fixture.replace("const sha = seedRepo('u-avatest', 'glance-test'),", "seedRepo('u-avatest', 'lua', globalThis.__luaSources)\nconst sha = seedRepo('u-avatest', 'glance-test'),")
if (!before) {
 const marker=" if(u.pathname==='/__fixture/calls')"
 if (!fixture.includes(marker)) throw Error('Fixture producer insertion point missing')
 fixture=fixture.replace(marker, ` if(u.pathname==='/__fixture/lua-publish') { const st=(await import(${JSON.stringify(base+'/lib/drivers/d1.ts')})).d1Store(env.DB),entity=(await st.settings.state('avatest/lua')).id;const {publishPushBatches}=await import(${JSON.stringify(base+'/lib/push-presentation.ts')});await publishPushBatches(env.GILD_RENDER,{entity,repository:'avatest/lua'});return Response.json({ok:true}) }\n`+marker)
}
mkdirSync('.tmp/static-review',{recursive:true})
const filename=resolve('.tmp/static-review/lua-fixture.mjs')
writeFileSync(filename,fixture)
const {forgeFixture}=await import(pathToFileURL(filename))
const {staticPerformance}=await import(pathToFileURL(root+'/scripts/static-performance.mjs'))
const f=await forgeFixture({staticReview:true})
try {
 for(let attempt=0;;attempt++){
  try{if((await fetch(f.origin+'/api/v1/openapi.json')).ok)break}catch{}
  if(attempt>90)throw Error('Startup');await new Promise(r=>setTimeout(r,250))
 }
 await fetch(f.origin+'/__fixture/refresh?owner=avatest&repo=lua')
 for(let attempt=0;;attempt++){
  const r=await fetch(f.origin+'/api/fragments/avatest/lua')
  const text=await r.text()
  if(r.ok && text.includes('manifest')){const pointer=JSON.parse(text);const expected=git('rev-parse','HEAD^{tree}').toString().trim();if(pointer.manifest.hash!==expected)throw Error('Fixture tree differs: '+pointer.manifest.hash+' != '+expected);break}
  if(attempt>120)throw Error('Lua fragments: '+r.status+' '+text)
  await new Promise(r=>setTimeout(r,500))
 }
 if (!before) {
  // Direct fixture seeding bypasses Git receive-pack. Use its real publication
  // barrier, rather than allowing the first visitor to prepare presentation.
  const published=await fetch(f.origin+'/__fixture/lua-publish')
  if (!published.ok) throw Error('Lua publication: '+published.status+' '+await published.text())
  await published.arrayBuffer()
 }
 await new Promise(r=>setTimeout(r,5000))
 const label=(before?'before':'after')+'-real-lua'
 const result=await staticPerformance(f.origin,['/avatest/lua','/avatest/lua?ref=main&path=lvm.c'],label)
 for(const row of result)row.fixture={source:'https://gild.gg/avatest/lua.git',sourceCommit:git('rev-parse','HEAD').toString().trim(),sourceTree:git('rev-parse','HEAD^{tree}').toString().trim(),files:paths.length}
 writeFileSync(root+'/.tmp/static-review/'+label+'.json',JSON.stringify(result,null,2))
 console.log('PASS real Lua browser measurement',label)
}catch(error){writeFileSync(root+'/.tmp/static-review/lua-worker-'+(before?'before':'after')+'.log',f.logs);throw error}
finally{f.worker.kill('SIGTERM');f.server.closeAllConnections();await new Promise(r=>f.server.close(r))}
