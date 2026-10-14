import {forgeFixture} from './forge-fixture.mjs'
import {publishFixturePage} from './nav-fixture.mjs'
import {chromium} from 'playwright-core'
import assert from 'node:assert/strict'
import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
const f=await forgeFixture({privacy:true}),repo='settingstest/demo',base='/'+repo,api='/api/v1/repos/'+repo
const call=async(path,method='GET',body,actor='avatest')=>{const r=await fetch(f.origin+path,{method,headers:{authorization:'Bearer '+f.tokens[actor],'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)});assert.ok(r.ok,await r.clone().text());return r}
let browser
try {
  for(let i=0;i<240;i++){try{if((await fetch(f.origin+'/api/v1/openapi.json')).ok)break}catch{}await new Promise(r=>setTimeout(r,250))}
  await call('/__fixture/refresh?key='+encodeURIComponent(repo))
  for(let i=0;i<100;i++){const r=await fetch(f.origin+base+'/agents');if(r.ok)break;await new Promise(r=>setTimeout(r,200))}
  await publishFixturePage(f,base+'/agents')
  for(let i=0;i<54;i++)await call(api+'/channel/messages','POST',{body:'Initial history '+i},i%2?'adminuser':'avatest')
  await call(api+'/channel/messages','POST',{body:'Channel first paint proof'})
  let finalPublished=false,declinedPublication=false
  const prepare=async(url)=>{
    // Deterministically exercise the real publisher's declined result without
    // changing app rendering, storing private data, or fabricating HTML.
    const decline=process.argv.includes('--declined-publication')&&!declinedPublication
    const target=decline ? f.origin+'/__fixture/public-pages?route='+encodeURIComponent('/__not_a_public_route__') : url
    const response=await fetch(target),result=await response.clone().json()
    if(decline){assert.equal(result.published,false);declinedPublication=true}
    finalPublished=!decline&&result.published===true
    return response
  }
  await publishFixturePage(f,base+'/agents',Date.now()+60000,prepare)
  assert.equal(finalPublished,true,'channel document capture requires successful current-route publication')
  const document=await (await fetch(f.origin+base+'/agents')).text()
  browser=await chromium.launch({channel:'chrome',headless:true})
  const context=await browser.newContext({viewport:{width:1280,height:1000}})
  await context.addCookies([{name:'gild_session',value:f.cookie('avatest'),domain:new URL(f.origin).hostname,path:'/',httpOnly:true}])
  const page=await context.newPage(),errors=[],requests=[]
  page.on('pageerror',e=>errors.push(e.message))
  page.on('request',r=>{if(r.url().includes('/api/'))requests.push(r.url())})
  // Every REST API is delayed. Server props must be visible before the socket's
  // constructor is called, so even a fast WebSocket cannot conceal a waterfall.
  await page.route('**/api/**',async route=>{await new Promise(r=>setTimeout(r,300));await route.continue()})
  await page.addInitScript(()=>{
    window.__channelCLS=0
    new PerformanceObserver(list=>{for(const e of list.getEntries())if(!e.hadRecentInput)window.__channelCLS+=e.value}).observe({type:'layout-shift',buffered:true})
    const visible=()=>{
      const log=document.querySelector('[aria-label="Channel messages"]'),people=document.querySelector('aside[aria-label="Participants"]')
      if(log?.getBoundingClientRect().height && people?.getBoundingClientRect().height && log.textContent.includes('Channel first paint proof') && people.textContent.includes('avatest') && document.querySelector('input[aria-label="Channel message"]'))window.__channelVisibleAt ??= performance.now()
      if(!window.__channelVisibleAt)requestAnimationFrame(visible)
    }
    requestAnimationFrame(visible)
    const Native=WebSocket
    window.WebSocket=class extends Native {
      constructor(url,...args){
        if(String(url).includes('/channel/stream') && !window.__channelFirst) {
          const paint=performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? performance.now()
          window.__channelFirst={at:performance.now(),afterPaintMs:Math.max(0,(window.__channelVisibleAt ?? performance.now())-paint),messageRows:document.querySelectorAll('[aria-label="Channel messages"] > [data-kind]').length,messages:document.querySelector('[aria-label="Channel messages"]')?.textContent,participants:document.querySelector('aside[aria-label="Participants"]')?.textContent,viewerRow:!![...document.querySelectorAll('aside li')].find(li=>li.textContent.includes('avatest')),input:!!document.querySelector('input[aria-label="Channel message"]'),url:String(url)}
        }
        super(url,...args)
      }
    }
  })
  await page.goto(f.origin+base+'/agents')
  await page.getByRole('status',{name:'Channel connection'}).filter({hasText:/^live/}).waitFor({timeout:30000})
  const first=await page.evaluate(()=>window.__channelFirst)
  assert.ok(first.messages.includes('Channel first paint proof'),'messages render before WebSocket connects')
  assert.ok(first.participants.includes('avatest') && first.participants.includes('adminuser'),'participants render with messages before WebSocket connects')
  assert.equal(first.messageRows,50,'first render contains exactly the initial 50 messages')
  assert.ok(first.viewerRow && first.input,'signed-in viewer and permissions render in the first HTML')
  // Assert the first-render effect before the independent warm API budget,
  // so reverting server props fails at the behavior this regression proves.
  const samples=[]
  for(let i=0;i<6;i++) {
    const at=performance.now(),response=await call('/api/repos/'+repo+'/islands?channel=1')
    samples.push({elapsedMs:performance.now()-at,timing:response.headers.get('server-timing')})
    const data=await response.json()
    assert.equal(data.channel.viewer,'avatest');assert.equal(data.channel.can_post,true)
    assert.ok(data.channel.participants.some(p=>p.name==='avatest'))
  }
  const participantSamples=[]
  for(let i=0;i<6;i++) {
    const response=await call(api+'/channel/participants'),timing=response.headers.get('server-timing')
    assert.ok(timing?.includes('participants;dur='))
    const total=Number(timing.match(/(?:^|,\s*)total;dur=([\d.]+)/)?.[1])
    if(i>0)assert.ok(Number.isFinite(total) && total<50,'warm participant server time '+timing)
    participantSamples.push(timing)
  }
  assert.ok(document.includes('Channel first paint proof'),'published HTML includes messages')
  assert.ok(document.includes('data-kind="human"'),'published HTML includes participants')
  assert.ok(first.afterPaintMs<300,JSON.stringify(first))
  assert.ok(new URL(first.url).searchParams.get('after')!=='0','socket resumes from rendered cursor')
  await page.waitForTimeout(700)
  assert.equal(requests.filter(u=>/\/channel\/messages(?:\?|$)/.test(u)).length,0,'no initial GET messages')
  assert.equal(requests.filter(u=>u.includes('/channel/participants')).length,0,'no REST participant/presence waterfall')
  // Viewer, permission and own participant render on the server, in this page's response.
  assert.equal(requests.filter(u=>u.includes('/islands') || u.includes('/api/viewer')).length,0,'no viewer/islands fetch after load')
  assert.equal(requests.filter(u=>u.endsWith('/api/viewer')).length,0,'no separate identity call')
  const cls=await page.evaluate(()=>window.__channelCLS)
  assert.ok(cls<0.01,'channel CLS '+cls)
  assert.deepEqual(errors,[])
  const anonymous=await browser.newContext({javaScriptEnabled:false})
  const publicPage=await anonymous.newPage();await publicPage.goto(f.origin+base+'/agents')
  assert.equal(await publicPage.locator('[aria-label="Channel messages"] > [data-kind]').count(),50,'published HTML shows the first 50 messages with JavaScript disabled')
  assert.ok(await publicPage.locator('aside li[data-kind="human"]').count()>0)
  await anonymous.close()
  const reader=await browser.newContext({javaScriptEnabled:false})
  await reader.addCookies([{name:'gild_session',value:f.cookie('outsider'),domain:new URL(f.origin).hostname,path:'/',httpOnly:true}])
  const readerPage=await reader.newPage();await readerPage.goto(f.origin+base+'/agents')
  assert.equal(await readerPage.locator('aside li').filter({hasText:/^outsider$/}).count(),1,'the unlisted signed-in viewer is included in the initial server roster')
  assert.equal(await readerPage.getByRole('textbox',{name:'Channel message'}).count(),0,'a public reader is read-only on the initial render')
  await reader.close()
  const initialRequests=[...requests]
  await call(api+'/visibility','PATCH',{visibility:'private',confirm:repo})
  // HTML/RSC for a non-reader may never include either the log or roster.
  for(const headers of [{},{cookie:'gild_session='+f.cookie('outsider')},{cookie:'gild_session='+f.cookie('outsider'),rsc:'1'}]) {
    const r=await fetch(f.origin+base+'/agents',{headers}),body=await r.text()
    assert.equal(r.status,404)
    assert.ok(!body.includes('Channel first paint proof') && !body.includes('aria-label="Repository channel"'))
  }
  const denied=await fetch(f.origin+'/api/repos/'+repo+'/islands?channel=1',{headers:{cookie:'gild_session='+f.cookie('outsider')}})
  assert.equal(denied.status,404)
  await page.reload()
  if (await page.locator('[data-artifact-pending]').count()) {
    assert.equal(await page.getByRole('navigation', { name: 'Portal', exact: true }).count(), 1, 'private metadata preparation retains account navigation')
    const end = Date.now() + 60000
    for (;;) {
      const ready = await context.request.get(f.origin + base + '/agents')
      if (ready.status() === 200 && !(await ready.text()).includes('data-artifact-pending')) break
      assert.ok(Date.now() < end, 'private metadata producer finishes')
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    await page.getByRole('link', { name: 'Check again', exact: true }).click()
  }
  await page.getByRole('textbox',{name:'Channel message'}).waitFor()
  const evidence={publication:{declinedPublication,finalPublished},runtime:'real Worker/D1/DO/published HTML + signed SSR',injectedApiLatencyMs:300,first,cls,islands:samples,participants:participantSamples,requests:initialRequests}
  writeFileSync(join(f.work,'channel-fast-evidence.json'),JSON.stringify(evidence,null,2))
  console.log(JSON.stringify(evidence,null,2));console.log('Channel first paint/one viewer call/private parity passed: '+f.work)
} finally {await browser?.close();f.worker.kill('SIGTERM');await new Promise(r=>f.server.close(r))}
