import {build} from 'esbuild'
import {launchChrome} from './chrome.mjs'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {resolve} from 'node:path'
import {createHmac} from 'node:crypto'
import {pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
const root=process.cwd(),origin=process.argv[2],stage=process.argv[3],fixtureWork=process.argv[4],stock=process.argv.includes('--stock')
assert.ok(origin?.startsWith('http://127.0.0.1:') && stage,'Use an owned forgeFixture origin and completed build stage')
const out=resolve('.tmp/search-runtime-visual');mkdirSync(out,{recursive:true})
const assets=JSON.parse(readFileSync(stage+'/.render/assets.json','utf8'))
const changed=['components/RepoSearch.tsx','components/repo/RuntimeObservation.tsx','packages/render/router.ts','packages/render/tab-client.tsx']
if(!stock){
 process.chdir(stage)
 const {cssModules}=await import(pathToFileURL(stage+'/scripts/render-build.mjs').href)
 const overlay={name:'exact-candidate-client-source',setup(b){b.onLoad({filter:/\.(tsx|ts)$/},a=>{const relative=a.path.slice(stage.length+1);if(changed.includes(relative))return {contents:readFileSync(resolve(root,relative),'utf8'),loader:a.path.endsWith('tsx')?'tsx':'ts'}})}}
 await build({absWorkingDir:stage,entryPoints:['packages/render/tab-client.tsx'],outfile:out+'/tab-client.js',bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,jsx:'automatic',alias:{'next/navigation':resolve('packages/render/tab-navigation.ts'),'next/link':resolve('packages/render/link.tsx'),'@/components/Link':resolve('packages/render/link.tsx')},plugins:[overlay,cssModules({manifest:{urls:{},hash:''}})],define:{'process.env.NODE_ENV':'"production"'}})
 await build({absWorkingDir:stage,entryPoints:['packages/render/router.ts'],outfile:out+'/router.js',bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,plugins:[overlay,cssModules()],define:{'process.env.NODE_ENV':'"production"'}})
 process.chdir(root)
}
assert.ok(fixtureWork?.startsWith(stage+'/.tmp/settings-e2e-'),'Use the disposable owned forgeFixture work folder')
const fixtureConfig=JSON.parse(readFileSync(fixtureWork+'/wrangler.json','utf8'))
assert.equal(fixtureConfig.name,'gild-settings-fixture')
assert.equal(fixtureConfig.assets.directory,stage+'/.open-next/assets')
const payload=Buffer.from(JSON.stringify({publicKey:'ed25519:avatest',name:'avatest',at:new Date().toISOString()})).toString('base64url')
const fixtureCookie=payload+'.'+createHmac('sha256',fixtureConfig.vars.SESSION_SECRET).update(payload).digest('base64url')
const browser=await launchChrome(),errors=[]
async function pageWithAssets(hold=false,signed=false){
 const context=await browser.newContext({viewport:{width:1440,height:1050}})
 if(signed)await context.addCookies([{name:'gild_session',value:fixtureCookie,domain:'127.0.0.1',path:'/',httpOnly:true}])
 const page=await context.newPage()
 let release
 const gate=hold?new Promise(r=>release=r):Promise.resolve()
 if(!stock){for(const name of ['router.js','tab-client.js'])await page.route(origin+assets.urls[name],async route=>{if(name==='tab-client.js')await gate;await route.fulfill({contentType:'text/javascript',body:readFileSync(out+'/'+name),headers:{'cache-control':'no-store'}})})}
 page.on('pageerror',e=>errors.push(e.message))
 return {context,page,release}
}
const ready=page=>page.waitForFunction(()=>Array.from(document.querySelectorAll('.search-trigger')).some(el=>Object.keys(el).some(k=>k.startsWith('__reactProps$'))))
const one=async(page,label)=>assert.equal(await page.locator('.search-dialog:visible').count(),1,label)
try {
 const first=await pageWithAssets(),page=first.page
 await page.goto(origin+'/settingstest/demo/agents');await ready(page)
 // IntentNavigation boots the same router on Next-owned pages, which do not
 // carry the standalone pointer/wrapper. Rebind that real production boundary.
 await page.evaluate(async url=>{for(const el of document.querySelectorAll('span[data-search-island]'))el.removeAttribute('data-search-island');document.querySelector('#gild-pointer')?.remove();(await import(url)).boot(()=>{})},origin+assets.urls['router.js'])
 await page.getByRole('button',{name:'Search code',exact:true}).click()
 await page.getByRole('combobox',{name:'Search query',exact:true}).waitFor()
 await page.screenshot({path:out+(stock?'/stock-duplicate.png':'/search-fixed.png'),fullPage:true})
 await one(page,'rich search owner must prevent a second fallback dialog')
 await page.getByRole('combobox',{name:'Search query',exact:true}).fill('README')
 await page.getByRole('option').first().waitFor({timeout:15000})
 await page.keyboard.press('Escape')
 await page.getByRole('dialog',{name:'Search code',exact:true}).waitFor({state:'hidden'})
 assert.equal(await page.getByRole('button',{name:'Search code',exact:true}).evaluate(el=>el===document.activeElement),true,'Escape restores search trigger focus')
 await page.keyboard.press('/');await page.getByRole('combobox').waitFor();await one(page,'slash opens one rich palette')
 await page.keyboard.press('Escape')
 await first.context.close()
 const early=await pageWithAssets(true),p=early.page
 await p.goto(origin+'/settingstest/demo/agents',{waitUntil:'domcontentloaded'})
 await p.waitForFunction(()=>document.documentElement.dataset.fragmentRouter==='ready')
 await p.getByRole('button',{name:'Search code',exact:true}).click()
 early.release()
 await p.waitForSelector('[data-search-ready]')
 await p.getByRole('combobox',{name:'Search query',exact:true}).waitFor()
 await one(p,'an early click opens the rich palette once it commits')
 await p.keyboard.press('Escape')
 await early.context.close()
 const signed=await pageWithAssets(false,true),view=signed.page
 await view.goto(origin+'/settingstest/demo/agents');await ready(view)
 await view.locator('[data-sidebar-client-ready]').waitFor()
 await view.getByRole('button',{name:'Expand',exact:true}).click()
 await view.getByRole('button',{name:'Collapse',exact:true}).waitFor({timeout:10000})
 await view.screenshot({path:out+'/menu-expanded.png',fullPage:true})
 await view.locator('nav[aria-label="Repository"] a[data-tab="issues"]').click();await view.getByText('Settings fixture issue',{exact:true}).waitFor()
 await view.locator('nav[aria-label="Repository"] a[data-tab="agents"]').click();await ready(view)
 await view.getByRole('button',{name:'Search code',exact:true}).click();await view.getByRole('combobox').waitFor();await one(view,'repository navigation retains one search owner');await view.keyboard.press('Escape')
 const row=view.locator('aside[aria-label="Participants"] li').filter({hasText:'avatest/codex'})
 await row.getByText('Runtime profile',{exact:true}).waitFor();await row.locator('summary').click()
 const profile=row.locator('[aria-label="Agent runtime profile"]')
 assert.ok(await profile.evaluate(el=>el.closest('aside').getBoundingClientRect().width<420),'Actual styled participant pane must be narrow before wrapping is measured')
 const overflow=await profile.evaluate(el=>{const right=el.closest('aside').getBoundingClientRect().right;return [...el.querySelectorAll('code,time')].flatMap(node=>{const r=document.createRange();r.selectNodeContents(node);return [...r.getClientRects()].filter(box=>box.right>right-10).map(box=>node.textContent)})})
 assert.deepEqual(overflow,[],'full runtime machine ID and timestamps must fit the participant pane')
 await view.screenshot({path:out+'/runtime-fields-wrapped.png',fullPage:true})
 assert.deepEqual(errors,[])
 writeFileSync(out+'/result.json',JSON.stringify({sourceOverrideFiles:changed,controlledClientFixture:true,actualCompletedOpenNextBackend:true,nextStyleCoownership:true,openTypeFocusEscapeNavigation:true,earlyFallbackQueryAndFocusPreserved:true,menuExpanded:true,runtimeFieldsNotClipped:true,pageErrors:errors,productionSpeedOrDeployment:false},null,2)+'\n')
 console.log('Search ownership, early fallback query/focus, Escape, repository navigation, actual Menu and full runtime field wrapping passed')
} catch(e) {writeFileSync(out+'/failure-state.json',JSON.stringify({message:e.message,pages:await Promise.all(browser.contexts().flatMap(c=>c.pages()).map(async page=>({url:page.url(),bodyInert:await page.evaluate(()=>document.body.inert),documentState:await page.evaluate(()=>({viewport:innerWidth,html:getComputedStyle(document.documentElement).display,body:getComputedStyle(document.body).display,htmlStyle:document.documentElement.getAttribute('style'),bodyStyle:document.body.getAttribute('style'),bodyHidden:document.body.hidden,children:[...document.body.children].map(e=>({tag:e.tagName,class:e.className,display:getComputedStyle(e).display,visibility:getComputedStyle(e).visibility,style:e.getAttribute('style')})),links:[...document.querySelectorAll('link[rel=stylesheet]')].map(e=>({href:e.href,loaded:!!e.sheet}))})),sidebars:await page.locator('aside.sidebar').evaluateAll(es=>es.map(e=>({class:e.className,html:e.outerHTML.slice(-1500)}))),buttons:await page.getByRole('button').allTextContents()})))},null,2));throw e} finally {await browser.close()}
