import {build} from 'esbuild'
import {createServer} from 'node:http'
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {launchChrome} from './chrome.mjs'
import assert from 'node:assert/strict'
mkdirSync('.tmp/theme-review',{recursive:true})
await build({stdin:{contents:`import {renderToString,renderToStaticMarkup} from 'react-dom/server';import {ThemeScript,ThemeToggle} from './components/theme';export const boot=renderToStaticMarkup(<ThemeScript/>);export const toggle=renderToString(<ThemeToggle/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,jsx:'automatic',platform:'node',format:'esm',packages:'external',outfile:'.tmp/theme-review/ssr.mjs'})
const {boot,toggle}=await import('../.tmp/theme-review/ssr.mjs')
await build({stdin:{contents:`import {hydrateRoot} from 'react-dom/client';import {useEffect} from 'react';import {ThemeToggle} from './components/theme';function App(){useEffect(()=>{requestAnimationFrame(()=>{window.__hydrated=true})},[]);return <ThemeToggle/>}hydrateRoot(document.getElementById('root'),<App/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},outfile:'.tmp/theme-review/client.js'})
const probe=`window.__frames=[];window.__changes=[];window.__paints=[];new MutationObserver(rs=>{for(const r of rs)window.__changes.push({from:r.oldValue,to:document.documentElement.dataset.theme})}).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme'],attributeOldValue:true});function frame(){window.__frames.push({theme:document.documentElement.dataset.theme,bg:getComputedStyle(document.documentElement).backgroundColor,at:performance.now()});requestAnimationFrame(frame)}requestAnimationFrame(frame);new PerformanceObserver(list=>{for(const e of list.getEntries())window.__paints.push({name:e.name,theme:document.documentElement.dataset.theme,at:e.startTime})}).observe({type:'paint',buffered:true});`
const server=createServer((req,res)=>{
  if(req.url==='/client.js'){
    res.writeHead(200,{'content-type':'text/javascript'}).end(readFileSync('.tmp/theme-review/client.js'))
  } else res.writeHead(200,{'content-type':'text/html'}).end(`<!doctype html><html data-theme="dark"><head><meta charset="utf-8">${boot}<style>:root{--rule:#555;--ink-soft:currentColor}html[data-theme=dark]{background:#151515;color:#eee}html[data-theme=light]{background:#fff;color:#222}body{padding:24px;font-family:sans-serif}</style><script>${probe}</script></head><body><h1>Theme</h1><div id="root">${toggle}</div><script defer src="/client.js"></script></body></html>`)
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const url=`http://127.0.0.1:${server.address().port}`
const browser=await launchChrome()
const evidence=[]
try{
  for(const [stored,os] of [['light','dark'],['dark','light'],['system','light'],['system','dark'],[null,'light']]){
    const expected=stored==='system'?os:stored??'dark'
    const page=await browser.newPage({viewport:{width:400,height:500},colorScheme:os})
    // Hold hydration until the inline script and initial painted frames are
    // observed. A fixed network delay races a slow/loaded browser in CI.
    let releaseHydration
    const hydrationGate=new Promise(resolve=>{releaseHydration=resolve})
    await page.route('**/client.js',async route=>{await hydrationGate;await route.continue()})
    const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())})
    await page.addInitScript(value=>{if(value)localStorage.setItem('gild.theme',value);else localStorage.removeItem('gild.theme')},stored)
    await page.goto(url,{waitUntil:'commit'})
    await page.waitForFunction(()=>window.__frames?.length>=2 && document.documentElement.hasAttribute('data-theme') && window.__paints.some(p=>p.name==='first-contentful-paint'))
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),expected)
    assert.equal(await page.evaluate(()=>window.__hydrated===true),false,'first frame precedes hydration')
    await page.screenshot({path:`.tmp/theme-review/first-${stored??'default'}-${os}.png`})
    releaseHydration()
    await page.waitForFunction(()=>window.__hydrated && window.__frames.length>=20)
    await page.getByRole('button',{name:`theme: ${stored??'dark'} (click to change)`}).waitFor()
    const initial=await page.evaluate(()=>({frames:window.__frames,changes:window.__changes,paints:window.__paints}))
    assert.ok(initial.paints.some(p=>p.name==='first-contentful-paint'))
    assert.ok(initial.frames.length>=20)
    assert.ok(initial.frames.every(f=>f.theme===expected),`No palette flash in painted frames: ${JSON.stringify(initial.frames)}`)
    assert.ok(initial.changes.every(c=>c.from===expected && c.to===expected),`No hydration palette clobber: ${JSON.stringify(initial.changes)}`)
    assert.equal(initial.frames[0].bg,expected==='light'?'rgb(255, 255, 255)':'rgb(21, 21, 21)')
    assert.ok(initial.paints.every(p=>p.theme===expected),'first paint uses resolved palette')
    evidence.push({stored,os,firstFrame:initial.frames[0],paints:initial.paints,hydrationChanges:initial.changes})
    const changedOS=os==='dark'?'light':'dark'
    await page.emulateMedia({colorScheme:changedOS})
    const after=stored==='system'?changedOS:expected
    await page.waitForFunction(value=>document.documentElement.dataset.theme===value,after)
    await page.waitForTimeout(50)
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),after)
    for(let i=0;i<3;i++){
      await page.getByRole('button').click()
      const chosen=await page.evaluate(()=>localStorage.getItem('gild.theme'))
      await page.getByRole('button',{name:`theme: ${chosen} (click to change)`}).waitFor()
      assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),chosen==='system'?changedOS:chosen)
    }
    assert.deepEqual(errors,[])
    await page.close()
  }
  writeFileSync('.tmp/theme-review/evidence.json',JSON.stringify(evidence,null,2))
  console.log('SSR hydration: light/dark, system with both OS palettes and live switch, default, first paint + all root mutations/frames, choice/persistence: 5 scenarios passed')
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r))}
