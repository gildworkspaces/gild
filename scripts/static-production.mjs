import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { forgeFixture } = await import(process.argv.includes('--before') ? pathToFileURL(resolve('scripts/forge-fixture.mjs')).href : './forge-fixture.mjs')
import { staticPerformance } from './static-performance.mjs'
import { mkdirSync,writeFileSync } from 'node:fs'
import { launchChrome } from './chrome.mjs'
import assert from 'node:assert/strict'
const f=await forgeFixture({staticReview:true,privacy:true})
const get=path=>fetch(f.origin+path)
async function published(route) {
 const end=Date.now()+60000
 while(true){
  const response=await get('/__fixture/public-pages?route='+encodeURIComponent(route))
  assert.equal(response.status,200)
  if((await response.json()).published)return
  assert.ok(Date.now()<end,'publication settles: '+route)
  await new Promise(r=>setTimeout(r,200))
 }
}
async function ready() {
 const end=Date.now()+60000
 while(Date.now()<end) {
  try {if((await get('/api/v1/openapi.json')).ok)return}catch{}
  await new Promise(r=>setTimeout(r,100))
 }
 throw Error('Full worker startup timeout')
}
try {
 await ready()
 await get('/__fixture/scheduled')
 for(const repo of ['avatest/glance-test','settingstest/demo']) {
  const end=Date.now()+60000
  while(true) {
   const response=await get('/'+repo)
   if(response.ok && (await response.text()).includes('id="gild-pointer"'))break
   if(Date.now()>end)throw Error(repo+': '+response.status)
   await new Promise(r=>setTimeout(r,100))
  }
 }
 const dispatch=await fetch(f.origin+'/api/v1/repos/settingstest/demo/actions/workflows/ci.yml/dispatches',{method:'POST',headers:{authorization:'Bearer '+f.tokens.avatest,'content-type':'application/json'},body:JSON.stringify({ref:'main'})})
 assert.ok(dispatch.ok,await dispatch.clone().text())
 const action=await dispatch.json()
 if(!process.argv.includes('--before')) {
  for(let i=0;i<3;i++){
   const r=await get('/__fixture/public-pages')
   assert.equal(r.status,200,await r.clone().text())
  }
 }
 const paths=['/','/explore','/avatest','/settingstest','/settingstest?tab=people','/settingstest?tab=repositories','/settingstest/demo','/settingstest/demo/issues','/settingstest/demo/issues/1','/settingstest/demo/pulls','/settingstest/demo/pulls/2','/settingstest/demo/pulls/2?tab=files','/settingstest/demo/pulls/2?tab=glance','/settingstest/demo/agents','/settingstest/demo/actions','/settingstest/demo/actions/'+action.id,'/settingstest/demo/score','/settingstest/demo/health','/settingstest/demo/commit/'+f.orgSha,'/search?q=fixture','/settingstest/demo/search?q=fixture']
 if(!process.argv.includes('--before'))paths.push('/new','/new/org','/import','/settingstest/demo/import','/settingstest/demo/issues/new','/settingstest/demo/pulls/new')
 paths.push('/docs/api','/docs/api/sessions')
 if(!process.argv.includes('--before'))paths.push('/auth/device','/auth/claim')
 if(process.argv.includes('--before'))paths.splice(paths.indexOf('/explore'),1)
 const label=process.argv.includes('--before')?'before-production':'after-production'
 const evidence=await staticPerformance(f.origin,paths,label)
 let approval
 if(!process.argv.includes('--before')) {
  const response=await fetch(f.origin+'/api/v1/agents/requests',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+f.tokens.outsider},body:JSON.stringify({sponsor:'avatest',label:'static-review',publicKey:'ed25519:'+Buffer.alloc(32,9).toString('base64'),repo:'settingstest/demo',grants:[]})})
  assert.equal(response.status,201,await response.clone().text());approval=(await response.json()).id
 }
 const privatePaths=['/dashboard','/settings/profile','/settings/tokens','/agents','/settings/keys','/settings/runners','/new','/new/org','/import','/settingstest/demo/issues/new','/settingstest/demo/pulls/new','/settingstest/demo/settings/general','/settingstest/demo/settings/webhooks','/orgs/settingstest/settings/general']
 if(!process.argv.includes('--before')) privatePaths.push('/settings','/keys','/runners','/settings/organizations','/settings/agents','/settings/invitations','/settings/runner-groups','/settingstest/demo/settings','/settingstest/demo/settings/access','/settingstest/demo/settings/actions','/settingstest/demo/settings/runners','/orgs/settingstest/settings','/orgs/settingstest/settings/members','/orgs/settingstest/settings/webhooks','/orgs/settingstest/settings/runners','/orgs/settingstest/settings/runner-groups','/agents/approve/'+approval)
 const privateEvidence=await staticPerformance(f.origin,privatePaths,label+'-viewer',[{name:'gild_session',value:f.cookie('avatest'),url:f.origin}])
 evidence.push(...privateEvidence.map(row=>({...row,viewer:'avatest'})))
 if(!process.argv.includes('--before')) {
  const browser=await launchChrome()
  let activePage
  try {
   const ctx=await browser.newContext()
   await ctx.addCookies([{name:'gild_session',value:f.cookie('avatest'),url:f.origin}])
   const page=activePage=await ctx.newPage()
   // The one-router application may warm visible tabs during idle before hover.
   // Observe from entry so an already completed prefetch cannot race this gate.
   const prefetched=page.waitForResponse(r=>new URL(r.url()).pathname==='/settingstest/demo/issues'&&['intent','repo-tab'].includes(r.request().headers()['x-gild-prefetch']))
   await page.goto(f.origin+'/settingstest/demo')
   const issueList=page.locator('a[data-tab="issues"]')
   await issueList.hover()
   assert.equal((await prefetched).status(),200,'Code tab prefetches stored HTML')
   await issueList.click()
   await page.getByRole('link',{name:'Settings fixture issue',exact:true}).click()
   const portal=page.getByRole('navigation',{name:'Portal',exact:true})
   await portal.waitFor()
   assert.equal(await portal.count(),1,'signed-in issue detail retains one account sidebar')
   assert.equal(await page.locator('.site-header').count(),0,'signed-in issue detail uses the account shell')
   await page.getByRole('button',{name:'Expand',exact:true}).click()
   const identity=page.locator('.sidebar-identity')
   assert.equal(await identity.getAttribute('data-tip'),'@avatest','account shell carries the authorized viewer')
   assert.ok((await identity.innerText()).includes('@avatest'),'expanded account menu shows the signed-in identity')
   assert.equal(await portal.locator('a[href="/dashboard"]').isVisible(),true,'account navigation remains usable on issue details')
   await page.getByRole('button',{name:'Collapse',exact:true}).click()
   await page.getByPlaceholder('Leave a comment. Markdown works.').waitFor()
   const marker='static-comment-'+Date.now()
   await page.getByPlaceholder('Leave a comment. Markdown works.').fill(marker)
   const commented=page.waitForResponse(r=>r.url().endsWith('/issues/1/comments') && r.request().method()==='POST')
   await page.getByRole('button',{name:'Comment',exact:true}).click()
   assert.equal((await commented).status(),201)
   await page.locator('article').getByText(marker,{exact:true}).waitFor({timeout:60000})
   assert.equal(await portal.count(),1,'posting a comment retains the signed-in account sidebar')
   await published('/settingstest/demo/issues/new')
   await page.goto(f.origin+'/settingstest/demo/issues')
   await page.getByRole('link',{name:'New issue',exact:true}).click()
   // A publication racing the preceding comment can enter the authorized
   // form layout. Wait for the input handler in either layout, not one header.
   const titleInput=page.getByLabel('Title',{exact:true})
   await titleInput.waitFor()
   await page.waitForFunction(el=>Object.keys(el).some(k=>k.startsWith('__reactProps$')),await titleInput.elementHandle())
   const created='static-created-'+Date.now()
   await page.getByLabel('Title',{exact:true}).fill(created)
   await page.getByRole('button',{name:'Open issue',exact:true}).click()
   await page.getByRole('heading',{name:new RegExp('^'+created+' #\\d+$')}).waitFor({timeout:60000})
   await published('/settingstest/demo/pulls/new')
   await published('/settingstest/demo/pulls')
   await page.goto(f.origin+'/settingstest/demo/pulls')
   await page.getByRole('link',{name:'New pull request',exact:true}).waitFor()
   await page.getByRole('link',{name:'New pull request',exact:true}).click()
   await page.goto(f.origin+'/settingstest/demo/pulls/new?head=feature')
   await page.waitForFunction(()=>document.querySelector('[aria-label="Branch to merge"]')?.value==='feature')
   assert.equal(await page.getByLabel('Base branch').inputValue(),'main','stored new-PR shell preserves the query branch selection')
   await page.getByRole('link',{name:'Settings',exact:true}).waitFor()
   const personalized=await ctx.request.get(f.origin+'/settingstest/demo/issues/new')
   assert.match(personalized.headers()['cache-control'],/\bno-store\b/,'signed-in forms cannot enter the shared cache')
   assert.doesNotMatch(personalized.headers()['cache-control'],/\bpublic\b/,'signed-in forms keep viewer state private')
   await ctx.clearCookies()
   const anonymous=await ctx.request.get(f.origin+'/settingstest/demo/issues/new')
   assert.equal(anonymous.headers()['cache-control'],'public, max-age=0, must-revalidate','anonymous form artifacts retain the shared cache path')
   assert.ok(!(await anonymous.text()).includes('data-tip="@avatest"'),'anonymous form artifacts never contain the previous account identity')
   await page.goto(f.origin+'/search?q=fixture')
   await page.waitForFunction(() => /[1-9][0-9]* file results/.test(document.querySelector('.search-count')?.textContent??''))
   assert.ok((await page.locator('.search-count').innerText()).match(/[1-9][0-9]* file results/),'static search shell loads real indexed results after paint')
   mkdirSync('.tmp/static-review',{recursive:true})
   await page.screenshot({path:'.tmp/static-review/search-after.png'})
   await ctx.addCookies([{name:'gild_session',value:f.cookie('avatest'),url:f.origin}])
   await page.goto(f.origin+'/new/org')
   const org='static-org-'+Date.now()
   await page.getByPlaceholder('org name',{exact:true}).fill(org)
   await page.getByRole('button',{name:'create org',exact:true}).click()
   await page.waitForURL('**/'+org)
   await page.locator('summary').filter({hasText:org}).waitFor({timeout:60000})
   assert.equal(await page.getByRole('navigation',{name:'Organization',exact:true}).isVisible(),true,'the created organization has usable navigation')
   assert.equal((await ctx.request.get(f.origin+'/'+org)).status(),200,'new organization is stored before creation acknowledgement')
  }catch(error){
   mkdirSync('.tmp/static-review',{recursive:true})
   if(activePage){writeFileSync('.tmp/static-review/browser-failure.html',await activePage.content());await activePage.screenshot({path:'.tmp/static-review/browser-failure.png',fullPage:true});console.log('Browser failure URL: '+activePage.url())}
   throw error
  }finally{await browser.close()}
  // Public aggregates cannot retain private rows after a real visibility write.
  const revoke=await fetch(f.origin+'/api/v1/repos/settingstest/demo/visibility',{method:'PATCH',headers:{authorization:'Bearer '+f.tokens.avatest,'content-type':'application/json'},body:JSON.stringify({visibility:'private'})})
  assert.equal(revoke.status,200,await revoke.clone().text())
  for(const path of ['/','/settingstest','/settingstest/demo/issues/1']) {
   const response=await get(path),html=await response.text()
   assert.ok(!html.includes('private-FULL-WORKER-9122'),path+' must never expose a revoked dependency')
  }
 }
 writeFileSync('.tmp/static-review/'+label+'-summary.json',JSON.stringify(evidence,null,2))
 console.log('PASS full OpenNext static pages, identity/comment/search islands, and aggregate privacy')
} catch(error) {
 writeFileSync('.tmp/static-review/production-worker.log',f.logs)
 throw error
}finally{f.worker.kill('SIGTERM');f.server.closeAllConnections();await new Promise(r=>f.server.close(r))}
