import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { mkdirSync,readFileSync,readdirSync,writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
mkdirSync('.tmp/static-review',{recursive:true})
const reverted=process.argv.includes('--reverted-pages')
await build({entryPoints:['scripts/public-pages-test-worker.ts'],outfile:'.tmp/static-review/pages.mjs',bundle:true,platform:'browser',format:'esm',external:['cloudflare:workers','node:*'],plugins:[{name:'revert-pages',setup(b){
if(process.argv.includes('--reverted-search-cache')||process.argv.includes('--reverted-search-scope'))b.onLoad({filter:/lib\/public-search\.ts$/},args=>{let contents=readFileSync(args.path,'utf8');if(process.argv.includes('--reverted-search-cache'))contents=contents.replace('const cached=await edge?.match(key)','const cached=undefined').replace("const object=await env.FRAGMENTS.get('search/'+hash)",'const object=null');if(process.argv.includes('--reverted-search-scope'))contents=contents.split('\n').filter(line=>!line.includes("headers.set('x-gild-public-repos'")).join('\n');return {contents,loader:'ts'}})
if(process.argv.includes('--reverted-form-shells'))b.onLoad({filter:/lib\/public-page-route\.ts$/},args=>({contents:readFileSync(args.path,'utf8').replace("parts[3]==='new' && ['issues','pulls'].includes(page)",'false'),loader:'ts'}))
if(reverted)b.onLoad({filter:/lib\/public-pages\.ts$/},args=>({contents:readFileSync(args.path,'utf8').replace('publicLeases(request, ctx, edge, now)','publicLeases(request, undefined, edge, now)'),loader:'ts'}))}}]})
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'.tmp/static-review/pages.mjs',compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['FRAGMENTS'],inspectorPort:0}))
const request=(path,host='gild.gg',time=100,headers={})=>mf.dispatchFetch('https://'+host+path,{headers:{'x-time':String(time),...headers}})
const calls=r=>JSON.parse(r.headers.get('x-fixture-calls'))
try {
 const db=await mf.getD1Database('DB')
 let schema=readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort().map(f=>readFileSync('migrations/'+f,'utf8')).join('\n').replace(/--[^\n]*/g,'').trim()
 while(schema) {
   const end=/^CREATE TRIGGER/i.test(schema)?schema.indexOf('END;')+4:schema.indexOf(';')+1
   assert.ok(end>0,'complete SQL statement')
   await db.prepare(schema.slice(0,end)).run()
   schema=schema.slice(end).trim()
 }
 await db.prepare("INSERT INTO repo_access VALUES ('acme/demo',NULL,'{}',0)").run()
 const routes=['/','/explore','/acme','/acme?tab=people','/acme/demo/issues','/acme/demo/issues/1','/acme/demo/pulls','/acme/demo/pulls/1?tab=files','/acme/demo/agents','/acme/demo/actions','/acme/demo/actions/1','/search','/acme/demo/search','/new','/new/org','/import','/acme/demo/import','/acme/demo/issues/new','/acme/demo/pulls/new']
 const bucket=await mf.getR2Bucket('FRAGMENTS')
 await bucket.put('next-assets/_next/static/chunks/old.js','retained deployment bytes',{httpMetadata:{contentType:'text/javascript'}})
 const oldAsset=await request('/_next/static/chunks/old.js')
 assert.equal(oldAsset.headers.get('cache-control'),'public, max-age=31536000, immutable')
 assert.equal(await oldAsset.text(),'retained deployment bytes','a cold PoP serves prior deployment chunks')
 const budgets=[]
 for(const route of routes) {
  assert.equal((await (await request('/fixture/publish?route='+encodeURIComponent(route))).json()).result,true,route)
  const cold=await request(route)
  assert.equal(cold.status,200,route+' cold')
  assert.equal(cold.headers.get('cache-control'),'public, max-age=0, must-revalidate')
  await cold.text()
  // waitUntil cache puts are async; drain work without waiting out the lease.
  for(let i=0;i<5;i++)await request('/api/not-a-page')
  const warm=await request(route,'gild.gg',101,{cookie:'gild_session=different-viewer'})
  assert.equal(warm.status,200)
  assert.deepEqual(calls(warm),{do:0,d1:0,r2:0,render:0},'warm public page must make zero origin calls: '+route)
  assert.ok((await warm.text()).includes('public stored page'))
  const reused=await (await request('/fixture/publish?route='+encodeURIComponent(route))).json()
  assert.equal(reused.renders,0,'unchanged immutable input never rerenders '+route)
  budgets.push({route,cold:calls(cold),warm:calls(warm)})
 }
 // A real stored channel shell must never replace a viewer's live modal.
 for (const headers of [{}, {rsc:'1',cookie:'gild_session=viewer'}]) {
  const modal=await request('/acme/demo/agents?object=%2Facme%2Fdemo%2Fissues%2F1','gild.gg',101,headers)
  assert.equal(modal.status,404,'channel object navigation must bypass stored anonymous HTML')
  assert.deepEqual(calls(modal),{do:0,d1:0,r2:0,render:0})
 }
 await db.prepare('INSERT INTO fragment_heads VALUES (?,?,?,?)').bind('acme/demo','main',JSON.stringify({repository:'acme/demo',meta:null,tip:'1'.repeat(40),ref:'main'}),'{}').run()
 await db.prepare("INSERT INTO repo_access VALUES ('unprojected/new',NULL,'{}',0)").run()
 for(const route of ['/api/search?q=fixture','/api/repos/acme/demo/search?q=fixture']) {
  const cold=await request(route);assert.equal(cold.status,200,await cold.clone().text());await cold.text()
  for(let i=0;i<5;i++)await request('/api/not-a-page')
  const warm=await request(route,'gild.gg',101)
  assert.equal(warm.status,200)
  assert.deepEqual(calls(warm),{do:0,d1:0,r2:0,render:0},'warm immutable search results must make zero origin calls')
  assert.equal((await warm.json()).count,1)
  assert.equal((await request(route,'gild.gg',101,{cookie:'gild_session=viewer'})).status,404,'viewer searches never use shared results')
  budgets.push({route,cold:calls(cold),warm:calls(warm)})
 }
 // A second origin simulates a remote PoP whose local invalidation never runs.
 const remote=await request('/','remote.gild.gg');assert.equal(remote.status,200);await remote.text()
 for(let i=0;i<5;i++)await request('/api/not-a-page','remote.gild.gg')
 await db.prepare("DELETE FROM repo_access WHERE id='unprojected/new'").run()
 await db.prepare("UPDATE repo_access SET acl='{\"private\":true}' WHERE id='acme/demo'").run()
 await request('/fixture/invalidate')
 assert.equal((await request('/')).status,404,'local mutation immediately revokes aggregate HTML')
 assert.equal((await request('/','remote.gild.gg',1099)).status,200,'remote grant may live until its exact deadline')
 assert.equal((await request('/','remote.gild.gg',1100)).status,404,'remote aggregate revocation bound is 1000ms')
 await db.prepare("UPDATE repo_access SET acl='{}' WHERE id='acme/demo'").run()
 await db.prepare("INSERT INTO profiles VALUES ('acme','{}')").run()
 assert.equal((await (await request('/fixture/publish?route=/&race')).json()).result,false,'publication racing a revoke fails closed')
 // Older public pages never resurrect after lifecycle delete/rename.
 await db.prepare("UPDATE repo_access SET acl='{}' WHERE id='acme/demo'").run()
 await db.prepare("INSERT INTO settings_entities(key,id,deleted_at) VALUES ('acme','acme',123)").run()
 assert.equal((await request('/acme','gild.gg',2100)).status,404)
 assert.equal((await request('/','remote.gild.gg',2100)).status,404)
 writeFileSync('.tmp/static-review/page-budgets.json',JSON.stringify(budgets,null,2))
 console.log('PASS published public pages: 19 warm pages with zero DO/D1/R2/render calls; producer reuse; 1000ms aggregate revocation; publication race; owner deletion')
} finally {await mf.dispose()}
