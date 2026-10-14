// Actual compiled OpenNext pages and immutable gild-render fragments, backed by
// disposable local Git/D1/DOs. All browsers are headless.
import { build } from 'esbuild'
import { cssModules } from './render-build.mjs'
import { cornerHits } from './corner-probe.mjs'
import { forgeFixture } from './forge-fixture.mjs'
import { launchChrome } from './chrome.mjs'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'

// The server selects account chrome before paint. Within each viewer identity,
// direct routes and hydrated transitions must keep the same geometry.
const f = await forgeFixture({ renderBuild:false }), base = '/avatest/shell-test'
f.seedRepo('u-avatest', 'shell-test', [
  { path: 'README.md', text: '# Shell fixture\n\n[Read a file](?path=long.ts)\n\n' + Array.from({length:100}, (_,i) => `## Section ${i}\n\nRepository README paragraph ${i}.\n\n`).join('') },
  { path: 'long.ts', text: Array.from({length:200}, (_,i) => `export const line${i} = ${i}\n`).join('') },
])
const evidenceDir = '.tmp/repo-shell-review'
mkdirSync(evidenceDir, { recursive:true })
let browser
const evidence = []
try {
  const deadline = Date.now()+90000
  while (true) {
    try { if ((await fetch(f.origin+base,{signal:AbortSignal.timeout(2000)})).status===200) break } catch {}
    if (Date.now()>deadline) throw Error('Fixture startup: '+f.logs.slice(-3000))
    await new Promise(r=>setTimeout(r,250))
  }
  // Seed the presentation sample before publishing immutable public documents.
  // Raw fixture SQL bypasses the production writer's publication queue.
  assert.equal((await fetch(f.origin+'/__fixture/shell-stars')).status,200)
  for(let i=0;i<3;i++)await fetch(f.origin+'/__fixture/public-pages')
  browser = await launchChrome()
  // Capture shifts from first paint, including font and late island loads.
  // CLS excludes shifts caused by recent user input; exact box comparisons
  // separately require the shared chrome to stay fixed during those clicks.
  const probe = () => {
    window.__shifts = []
    new PerformanceObserver(list => window.__shifts.push(...list.getEntries().map(e => ({value:e.value,at:e.startTime,recent:e.hadRecentInput,sources:e.sources?.map(s=>s.node?.outerHTML?.slice(0,200))})))).observe({type:'layout-shift',buffered:true})
  }
  const boxes = page => page.evaluate(() => {
    const selectors = {
      portal:'.portal-bar', site:'.site-header', logo:'.site-logo', search:'.search-trigger', siteNav:'.site-nav', identity:'[data-identity]',
      repo:'[data-repo-header], main header:not(.portal-bar)', title:'[data-repo-header] h1, main header:not(.portal-bar) h1', tabs:'nav[aria-label=Repository]', actions:'[data-repo-actions], [class*=repoActions]', star:'[data-star-slot], [data-star], [class*=star]:not(button)', clone:'[data-clone], [class*=clone]:not([class*=Panel]):not([class*=Line])',
    }
    const round = n => Math.round(n*100)/100
    const result = {}
    for(const [key,selector] of Object.entries(selectors)) {
      const node=document.querySelector(selector)
      if(!node || ['none','contents'].includes(getComputedStyle(node).display) || !node.getClientRects().length)continue
      const r=node.getBoundingClientRect();result[key]=[r.x,r.y,r.width,r.height].map(round)
    }
    result.links=[...document.querySelectorAll('nav[aria-label=Repository] > a')].filter(e=>getComputedStyle(e).display!=='none').map(e=>{
      const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height].map(round)
    })
    return result
  })
  async function settled(page) {
    await page.locator('nav[aria-label=Repository]').waitFor()
    await page.waitForFunction(()=>document.documentElement.dataset.fragmentRouter==='ready')
    await page.evaluate(()=>document.fonts.ready)
    if (!process.argv.includes('--before')) await page.waitForFunction(() => document.querySelector('[data-star-count]')?.textContent.includes('12345'))
    await page.waitForTimeout(1200)
  }
  const before = process.argv.includes('--before'), scrollOnly = process.argv.includes('--scroll-only'), headersOnly=process.argv.includes('--headers-only'), quick=process.argv.includes('--quick'), valuesOnly=process.argv.includes('--values-only')
  for (const width of valuesOnly ? [] : scrollOnly || before ? [1400] : [400,1400]) for (const longHandle of scrollOnly || before || quick ? [false] : [false,true]) for(const signedIn of before||scrollOnly||quick?[false]:longHandle?[true]:[false,true]) for(const theme of scrollOnly?['dark']:quick?['light']:['light','dark']) {
    const ctx=await browser.newContext({viewport:{width,height:1000}})
    if(signedIn)await ctx.addCookies([{name:'gild_session',value:f.cookie('avatest', longHandle ? 'ava.samifou.ad' : 'avatest'),url:f.origin}])
    await ctx.addInitScript(t=>localStorage.setItem('gild.theme',t),theme)
    await ctx.addInitScript(probe)
    const page=await ctx.newPage(), errors=[]
    page.on('pageerror',e=>{errors.push(e.message);console.log('BROWSER ERROR',e.message)})
    // Deliberately delay islands so the first painted frame precedes hydration.
    await page.route('**/islands*',async route=>{await new Promise(r=>setTimeout(r,350));await route.continue()})
    const paths=before||quick?['','/issues']:['','/issues','/pulls','/actions','/agents','/score']
    let reference
    if(!scrollOnly) for(const path of paths) {
      // Freeze the router on Code: inspect real SSR chrome before identity.
      let release
      if (!path && !before) {
        const gate = new Promise(r => { release = r })
        await page.route('**/router.js', async route => { await gate; await route.continue() })
      }
      await page.goto(f.origin+base+path, { waitUntil: path ? 'load' : 'commit' })
      if (!path && !before) {
        await page.locator('nav[aria-label=Repository]').waitFor()
        await page.waitForFunction(() => { const link=document.querySelector('link[rel=stylesheet][href$="/presentation.css"]'); return !link || !!link.sheet })
        await page.evaluate(() => document.fonts.ready)
        const cold = await boxes(page)
        assert.ok(cold.portal, `cold Code has .portal-bar at ${width}px`)
        if (signedIn) assert.deepEqual(await page.evaluate(cornerHits), [], `cold Code corner clear at ${width}px`)
        release()
        await page.unroute('**/router.js')
        await settled(page)
        assert.deepEqual(await boxes(page), cold, `cold/hydrated chrome at ${width}px`)
      } else await settled(page)
      const measured=await boxes(page)
      // Baseline renderers don't have semantic markers; snapshot them too.
      if(before)await page.screenshot({path:`${evidenceDir}/before-${signedIn?'owner':'anonymous'}-${path===''?'code':path.split('/')[1]}-${theme}.png`})
      else {
        if(!reference)reference=measured
        assert.deepEqual(measured,reference,`shared chrome: direct ${signedIn?'owner':'anonymous'} ${path||'Code'} ${theme}`)
        const active=await page.getByRole('navigation',{name:'Repository',exact:true}).locator('[aria-current=page]').innerText()
        assert.ok(active.startsWith(path ? ({'/pulls':'Pull requests','/settings/general':'Settings'}[path] ?? path.slice(1)[0].toUpperCase()+path.slice(2)) : 'Code'),'active underline follows route: '+active)
        const fit = await page.evaluate(() => {
          const count = document.querySelector('[data-star-count]')
          const controls = [...document.querySelectorAll('[data-repo-actions] button, [data-repo-actions] a, [data-clone] summary, nav[aria-label=Repository] > a')].filter(e => e.getClientRects().length)
          return { count: count.textContent.trim(), countFits: count.scrollWidth <= count.clientWidth,
            controlsFit: controls.every(e => { const r=e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth }),
            pageFits: document.documentElement.scrollWidth <= innerWidth }
        })
        assert.match(fit.count, /12345/, 'five digit star count rendered')
        assert.ok(fit.countFits, `five digit star count fits at ${width}px`)
        assert.ok(fit.controlsFit && fit.pageFits, `chrome stays inside ${width}px viewport: ${JSON.stringify(fit)}`)
        const shifts=await page.evaluate(()=>window.__shifts)
        const cls=shifts.filter(e=>!e.recent).reduce((n,e)=>n+e.value,0)
        assert.ok(cls<0.01,`CLS ${cls}: ${JSON.stringify(shifts)}`)
        evidence.push({width,longHandle,signedIn,theme,navigation:'direct',path,boxes:measured,cls})
        if(['','/issues'].includes(path))await page.screenshot({path:`${evidenceDir}/after-${width}-${longHandle?'long-':''}${signedIn?'owner':'anonymous'}-${path===''?'code':'issues'}-${theme}.png`})
      }
    }
    if(before){await ctx.close();continue}
    await page.goto(f.origin+base);await settled(page)
    if(!scrollOnly) for(const path of paths.slice(1)) {
      await page.getByRole('navigation',{name:'Repository',exact:true}).locator(`a[data-tab="${path.split('/')[1]}"]`).click()
      await page.waitForURL(url=>url.pathname===base+path);await settled(page)
      assert.deepEqual(await boxes(page),reference,`shared chrome: in-site ${path} ${theme}`)
      assert.ok((await page.evaluate(()=>window.__shifts.filter(e=>!e.recent).reduce((n,e)=>n+e.value,0)))<0.01,`in-site CLS < 0.01 ${path} ${theme} ${width} ${signedIn} ${longHandle}: ${JSON.stringify(await page.evaluate(()=>window.__shifts))}`)
      // Each return exercises Next -> fragment handoff (Score -> Code stays in fragments).
      await page.getByRole('navigation',{name:'Repository',exact:true}).getByRole('link',{name:'Code',exact:true}).click()
      await page.waitForURL(url=>url.pathname===base)
      await settled(page)
      assert.deepEqual(await boxes(page),reference,`shared chrome: return Code from ${path}`)
      assert.ok((await page.evaluate(()=>window.__shifts.filter(e=>!e.recent).reduce((n,e)=>n+e.value,0)))<0.01,'return Code CLS < 0.01')
      evidence.push({width,longHandle,signedIn,theme,navigation:'in-site',path,cls:await page.evaluate(()=>window.__shifts.filter(e=>!e.recent).reduce((n,e)=>n+e.value,0))})
    }
    console.log(`PASS chrome ${width}px ${signedIn?'owner':'anonymous'} ${longHandle?'long handle ':''}${theme}`)
    if(headersOnly || width===400 || longHandle){await ctx.close();continue}
    // README -> file -> Code, with distinct positions in each history entry.
    await page.evaluate(()=>window.scrollTo(0,640));await page.waitForTimeout(80)
    await page.locator('[data-file-pane] a[href="?path=long.ts"]').evaluate(a=>a.click())
    await page.waitForFunction(()=>document.documentElement.dataset.navigationReady?.includes('path=long.ts'))
    assert.equal(await page.evaluate(()=>scrollY),0,'push file scrolls to top')
    await page.evaluate(()=>window.scrollTo(0,420));await page.waitForTimeout(80)
    await page.getByRole('navigation',{name:'Repository',exact:true}).getByRole('link',{name:'Code',exact:true}).evaluate(a=>a.click())
    await page.waitForFunction(()=>!document.documentElement.dataset.navigationReady?.includes('path=long.ts'))
    assert.equal(await page.evaluate(()=>scrollY),0,'push Code scrolls to top')
    await page.goBack();await page.waitForFunction(()=>document.documentElement.dataset.navigationReady?.includes('path=long.ts'))
    assert.equal(await page.evaluate(()=>scrollY),420,'back restores file entry')
    await page.goBack();await page.waitForFunction(()=>!document.documentElement.dataset.navigationReady?.includes('path=long.ts'))
    assert.equal(await page.evaluate(()=>scrollY),640,'back restores README entry')
    await page.goForward();await page.waitForFunction(()=>document.documentElement.dataset.navigationReady?.includes('path=long.ts'))
    assert.equal(await page.evaluate(()=>scrollY),420,'forward restores file entry')
    // Hash targets must work on pushes without overriding background refresh.
    await page.evaluate(base=>{const a=document.createElement('a');a.href=base+'?path=long.ts#L80';document.body.append(a);a.click();a.remove()},base)
    await page.waitForFunction(()=>document.documentElement.dataset.navigationReady?.endsWith('#L80'))
    assert.ok(await page.evaluate(()=>Math.abs(document.getElementById('L80').getBoundingClientRect().top-32)<2),'push follows hash target')
    await page.evaluate(()=>window.scrollTo(0,550));await page.waitForTimeout(80)
    // Change the real Git tip; refreshing through the actual DO republishes
    // immutable fragments. A window focus runs the production refreshTip path.
    const dir=join(f.gitRoot,'u-avatest','shell-test.git')
    writeFileSync(join(dir,'tip.txt'),theme+'-'+signedIn+'-'+Date.now())
    f.git(dir,'add','.');f.git(dir,'-c','commit.gpgsign=false','commit','-m','Fixture tip refresh')
    const refreshedTree=f.git(dir,'rev-parse','HEAD^{tree}')
    const response=await fetch(f.origin+'/__fixture/refresh?owner=avatest&repo=shell-test')
    assert.equal(response.status,200,await response.text())
    const nextTip=f.git(dir,'rev-parse','HEAD'), refreshDeadline=Date.now()+60000
    while(true){
      const r=await fetch(f.origin+'/api/fragments/avatest/shell-test?ref=main&path=long.ts',{signal:AbortSignal.timeout(5000)})
      if(r.ok && (await r.json()).tip===nextTip)break
      if(Date.now()>refreshDeadline)throw Error('New Git tip did not finish indexing')
      await new Promise(r=>setTimeout(r,100))
    }
    await page.evaluate(()=>{
      window.__tipChanged=false
      document.addEventListener('gild:tip-changed',()=>{window.__tipChanged=true},{once:true})
      window.dispatchEvent(new Event('focus'))
    })
    await page.waitForFunction(()=>window.__tipChanged)
    await page.waitForFunction(tree=>document.documentElement.dataset.sourceReady===tree,refreshedTree)
    assert.equal(await page.evaluate(()=>scrollY),550,'tip refresh preserves reader position even with hash')
    assert.deepEqual(errors,[],'no browser errors')
    evidence.push({width,longHandle,signedIn,theme,scroll:{pushTop:true,back:true,forward:true,hash:true,tipPreserved:true}})
    console.log(`PASS scroll ${signedIn?'owner':'anonymous'} ${theme}`)
    await ctx.close()
  }
  if (!before && !scrollOnly) {
    await build({entryPoints:['scripts/repo-shell-values.tsx'],outfile:'.tmp/repo-shell-values.mjs',bundle:true,platform:'node',format:'esm',packages:'external',plugins:[cssModules()]})
    const { headerHTML } = await import('../.tmp/repo-shell-values.mjs')
    for (const width of [1400,400]) {
      const ctx = await browser.newContext({viewport:{width,height:1000}}), page = await ctx.newPage()
      await page.goto(f.origin+base)
      await page.setContent(`<link rel="stylesheet" href="${f.origin}${JSON.parse(readFileSync('.render/assets.json','utf8')).urls['presentation.css']}">${headerHTML(null)}`)
      await page.evaluate(() => { delete document.documentElement.dataset.portal; return document.fonts.ready })
      const before = await page.locator('[data-identity]').boundingBox()
      await page.locator('[data-identity]').evaluate((e,html) => { e.innerHTML=html }, headerHTML('ava.samifou.ad').match(/<span data-identity="">(.*?)<\/span><\/nav>/s)[1])
      assert.deepEqual(await page.locator('[data-identity]').boundingBox(),before,`long handle preserves identity well at ${width}px`)
      const fit = await page.locator('.site-identity').evaluate(e => {
        const r=e.getBoundingClientRect(), label=e.querySelector('.identity-label')
        return {fits:r.left>=0 && r.right<=innerWidth && e.scrollWidth<=e.clientWidth, ellipsis:getComputedStyle(label).textOverflow, name:label.textContent}
      })
      assert.ok(fit.fits,`long handle stays inside identity well at ${width}px: ${JSON.stringify(fit)}`)
      assert.equal(fit.ellipsis,'ellipsis','long handle has accessible ellipsis')
      assert.equal(fit.name,'@ava.samifou.ad')
      evidence.push({width,longHandlePublicHeader:fit})
      await ctx.close()
    }
  }
  if(!before && !headersOnly && !valuesOnly) {
    const ctx=await browser.newContext({viewport:{width:1400,height:1000}}), page=await ctx.newPage()
    let release
    const gate=new Promise(r=>{release=r})
    await page.route('**/router.js',async route=>{await gate;await route.continue()})
    await page.goto(f.origin+base,{waitUntil:'commit'})
    await page.locator('[data-file-pane]').waitFor()
    await page.evaluate(()=>document.fonts.ready)
    await page.evaluate(()=>window.scrollTo(0,620))
    release()
    await page.waitForFunction(()=>document.documentElement.dataset.fragmentRouter==='ready' && (document.documentElement.dataset.sourceReady || document.documentElement.dataset.sourceError))
    await page.waitForTimeout(150)
    assert.equal(await page.evaluate(()=>scrollY),620,'late boot preserves reader position')
    // Push through the Next -> fragment handoff path from a scrolled
    // Next page, and restore that Next entry on back.
    await page.goto(f.origin+base+'/issues');await settled(page)
    await page.setViewportSize({width:1400,height:300})
    await page.evaluate(()=>window.scrollTo(0,100));await page.waitForTimeout(80)
    const nextY=await page.evaluate(()=>scrollY)
    assert.ok(nextY>0,'Next page is scrolled')
    await page.getByRole('navigation',{name:'Repository',exact:true}).getByRole('link',{name:'Code',exact:true}).evaluate(a=>a.click())
    await page.waitForURL(url=>url.pathname===base);await settled(page)
    assert.equal(await page.evaluate(()=>scrollY),0,'Next -> fragment push lands at top')
    await page.goBack();await page.waitForURL(url=>url.pathname===base+'/issues');await settled(page)
    assert.equal(await page.evaluate(()=>scrollY),nextY,'back restores the Next entry after the framework handoff')
    evidence.push({lateBootPreserved:true,nextToFragmentPush:true,nextBackRestored:true})
    await ctx.close()
  }
  if(!before && !headersOnly && !valuesOnly) {
    // A portal 404 outside /[owner] (here: settings asked for signed out)
    // must draw the site chrome once, not the portal layout's plus the root
    // not-found page's.
    const ctx=await browser.newContext({viewport:{width:1280,height:800}}), page=await ctx.newPage()
    // (Missing owners and repos are answered before Next since #61; see #64.)
    for (const path of ['/settings/runners', '/orgs/avatest/settings']) {
      await page.goto(f.origin+path)
      await page.getByRole('heading',{name:'Nothing lives here'}).waitFor()
      const chrome=await page.evaluate(()=>({headers:document.querySelectorAll('.site-header').length,footers:document.querySelectorAll('.site-footer-grid').length,missing:document.querySelectorAll('h1').length}))
      assert.deepEqual(chrome,{headers:1,footers:1,missing:1},`one header and footer on the ${path} 404`)
      evidence.push({portal404:path,...chrome})
    }
    await ctx.close()
  }
  writeFileSync(`${evidenceDir}/evidence.json`,JSON.stringify(evidence,null,2))
  console.log(before?'Captured baseline screenshots':'PASS direct/in-site shared chrome + CLS < 0.01 in both themes; README/file/Code, back/forward, hash, real tip refresh')
} catch (error) {
  for(const [i,p]of (browser?.contexts().flatMap(c=>c.pages())??[]).entries()){writeFileSync(`${evidenceDir}/failure-${i}.html`,await p.content());writeFileSync(`${evidenceDir}/failure-${i}-state.json`,JSON.stringify(await p.evaluate(()=>({url:location.href,y:scrollY,ready:document.documentElement.dataset.navigationReady,target:document.getElementById('L80')?.getBoundingClientRect().toJSON(),containers:[...document.querySelectorAll('[data-file-pane], main, [data-file-pane] pre, [data-file-pane] .shiki')].map(e=>({cls:e.className,height:e.clientHeight,scrollHeight:e.scrollHeight,scrollTop:e.scrollTop}))})),null,2));await p.screenshot({path:`${evidenceDir}/failure-${i}.png`}).catch(()=>{})}
  writeFileSync(`${evidenceDir}/failure.json`,JSON.stringify({message:error.message,evidence},null,2))
  throw error
} finally {
  await browser?.close()
  f.worker.kill('SIGTERM')
  await new Promise(r=>f.worker.exitCode!==null?r():f.worker.once('exit',r))
  await new Promise(r=>f.server.close(r))
}
