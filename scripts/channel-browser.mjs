import { flushChannelFixture } from './channel-fixture.mjs'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { launchChrome } from './chrome.mjs'
import assert from 'node:assert/strict'
export async function verifyChannel({origin,token,tokens,request,work}) {
  const dir=join(work,'channel-browser');mkdirSync(dir)
  await build({entryPoints:['scripts/channel-browser-entry.tsx'],outdir:dir,bundle:true,format:'esm',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'navigation-fixture',setup(b){
    b.onResolve({filter:/^next\/link$/},()=>({path:'link',namespace:'fixture-link'}))
    b.onLoad({filter:/.*/,namespace:'fixture-link'},()=>({contents:"import React from 'react';export default function Link({href,children,...props}){return React.createElement('a',{href,...props},children)}",loader:'js',resolveDir:process.cwd()}))
    b.onResolve({filter:/^next\/navigation$/},()=>({path:'navigation',namespace:'fixture'}))
    b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export function usePathname(){return location.pathname}export function useSearchParams(){return new URLSearchParams(location.search)}export function useRouter(){return {push(url){history.pushState({},'',url);dispatchEvent(new Event('fixture-navigation'))},replace(url){history.replaceState({},'',url);dispatchEvent(new Event('fixture-navigation'))},back(){history.back()},refresh(){dispatchEvent(new Event('fixture-navigation'))}}}`,loader:'js'}))
  }}]})
  const globalCSS=readFileSync('app/globals.css','utf8').replace(/@import[^;]+;/g,'')
  const server=createServer(async(req,res)=>{
    if(req.url==='/app.js'||req.url==='/app.css'){res.setHeader('content-type',req.url.endsWith('css')?'text/css':'text/javascript');res.end(readFileSync(join(dir,'channel-browser-entry.'+(req.url.endsWith('css')?'css':'js'))));return}
    const headers={authorization:req.headers.authorization ?? 'Bearer '+token}
    const [page,people]=await Promise.all(['messages','participants'].map(async path=>{const r=await fetch(origin+'/api/v1/repos/acme/demo/channel/'+path,{headers});assert.ok(r.ok);return r.json()}))
    const initial=JSON.stringify({...people,page,viewer_resolved:true}).replaceAll('<','\\u003c')
    res.setHeader('content-type','text/html');res.end(`<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${globalCSS}:root{--font-mono:'JetBrains Mono',monospace;--font-sans:Arial,sans-serif}body{margin:0;padding:20px;}</style><link rel="stylesheet" href="/channel-browser/app.css"></head><body><div id="app"></div><script>window.__channelInitial=${initial}</script><script type="module" src="/channel-browser/app.js"></script></body></html>`)
  })
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  await request('/channel-ui-fixture','POST',{url:'http://127.0.0.1:'+server.address().port})
  const browser=await launchChrome(),contexts=[],errors=[],shots=[]
  try {
    for(const auth of [token,tokens.legacyWriter])contexts.push(await browser.newContext({extraHTTPHeaders:{authorization:'Bearer '+auth},viewport:{width:1280,height:900}}))
    const [a,b]=await Promise.all(contexts.map(c=>c.newPage()))
    for(const page of [a,b])page.on('pageerror',e=>errors.push(e.message))
    await Promise.all([a,b].map(p=>p.goto(origin+'/channel-browser?view=channel')))
    await Promise.all([a,b].map(p=>p.getByRole('status',{name:'Channel connection'}).filter({hasText:/^live/}).waitFor({timeout:15000})))
    await a.locator('aside li').filter({hasText:/^\+writer$/}).getByLabel('Online').waitFor({timeout:15000})
    await a.getByRole('textbox',{name:'Channel message',exact:true}).fill('client one live proof')
    await a.getByRole('textbox',{name:'Channel message',exact:true}).press('Enter')
    await b.getByText('client one live proof',{exact:true}).waitFor()
    await b.getByRole('textbox',{name:'Channel message',exact:true}).fill('client two live proof')
    await b.getByRole('textbox',{name:'Channel message',exact:true}).press('Enter')
    await a.getByText('client two live proof',{exact:true}).waitFor()
    const nicks=await a.locator('aside[aria-label="Participants"] li').allTextContents()
    const human=await a.locator('aside li[data-kind="human"]').count()
    assert.ok(nicks.slice(0,human).every(n=>!n.includes('/')))
    assert.ok(nicks.slice(human).every(n=>n.includes('/')))
    assert.ok(nicks.includes('@acme'));assert.ok(nicks.includes('+writer'));assert.ok(nicks.includes('+acme/channelbot'));assert.ok(nicks.includes('acme/channelread'))
    assert.equal(await a.locator('aside li').filter({hasText:/^@acme$/}).getByLabel('Online').count(),1)
    const admin=await request('/privacy-fixture','POST',{actor:'acme/channeladmin',token:'gf_channelAdminFixture',scopes:['repo:read','admin']});assert.equal(admin.status,200)
    // Admin prefix is also checked through the production participant source.
    const acl={schema:1,owners:['@acme'],write:['@writer'],read:['@reader'],agents:{'@acme/channelbot':['pr'],'@acme/channelread':['review'],'@acme/channelspecial':['review'],'@acme/channeladmin':['review']}}
    await request('/privacy-fixture','POST',{acl});await flushChannelFixture(request)
    const p=await (await request('/api/v1/repos/acme/demo/channel/participants')).json();assert.equal(p.participants.find(x=>x.name==='acme/channeladmin').prefix,'@')
    // Refreshes on the next genuine presence update, not fixture messages.
    // The API merge of #2 ("Fixes #1") closed issue 1; reopen it to close it from the modal.
    assert.equal((await request('/api/v1/repos/acme/demo/issues/1','PATCH',{state:'open'})).status,200)
    await a.getByRole('link',{name:'issue #1 "Seed issue"',exact:true}).first().click()
    await a.getByRole('dialog').waitFor();assert.ok(new URL(a.url()).searchParams.get('object')?.includes('/issues/1'))
    await a.getByRole('textbox',{name:'Comment',exact:true}).fill('modal comment production proof')
    const posted=a.waitForResponse(r=>r.url().endsWith('/issues/1/comments')&&r.request().method()==='POST')
    await a.getByRole('button',{name:'Comment',exact:true}).click()
    assert.equal((await posted).status(),201)
    await a.getByRole('dialog').getByText('modal comment production proof',{exact:true}).waitFor()
    const comments=await (await request('/api/v1/repos/acme/demo/issues/1/comments')).json()
    assert.ok(comments.some(c=>c.body==='modal comment production proof'))
    await a.getByRole('button',{name:'Close issue',exact:true}).click()
    await a.getByRole('button',{name:'Reopen issue',exact:true}).waitFor()
    assert.equal((await (await request('/api/v1/repos/acme/demo/issues/1')).json()).state,'closed')
    await a.goBack();await a.getByRole('dialog').waitFor({state:'detached'});assert.equal(a.url(),origin+'/channel-browser?view=channel','Back restores the channel URL')
    for(const [theme,width] of [['light',1280],['dark',1280],['dark',390]]) {
      await a.setViewportSize({width,height:900});await a.evaluate(theme=>document.documentElement.dataset.theme=theme,theme)
      if(width<640){await a.getByRole('button',{name:/Participants/}).click();assert.equal(await a.getByRole('complementary',{name:'Participants'}).isVisible(),true);await a.getByRole('button',{name:/Participants/}).click()}
      assert.ok(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
      const path=join(dir,`${theme}-${width}.png`);await a.screenshot({path,fullPage:true});shots.push(path)
    }
    // Warm the socket authorization cache, so only the access-change notification
    // (not the 5 s expiry or timer) can revoke inside the window that follows.
    await request('/api/v1/repos/acme/demo/channel/messages','POST',{body:'cache warm-up'})
    await b.getByText('cache warm-up',{exact:true}).waitFor()
    // An existing private socket loses access before any newly posted text is sent.
    const revoked=await request('/privacy-fixture','POST',{acl:{...acl,visibility:'private',write:[],read:[]}})
    assert.equal((await revoked.json()).accessNotifications,1,'ACL write notifies cached sockets before acknowledgment')
    await flushChannelFixture(request)
    await request('/api/v1/repos/acme/demo/channel/messages','POST',{body:'private revocation proof'})
    await b.waitForTimeout(200);assert.equal(await b.getByText('private revocation proof',{exact:true}).count(),0)
    assert.deepEqual(errors,[])
    console.log('Channel browser: two live clients, participant order/prefix/presence, modal comment and close, Back, phone toggle, private revocation passed')
    return shots
  } catch(error) {console.error('Channel browser failure:',JSON.stringify({errors,pages:await Promise.all(contexts.map(async c=>Promise.all(c.pages().map(async p=>({url:p.url(),body:await p.locator('body').innerText()})))))}));throw error
  } finally {for(const c of contexts)await c.close();await browser.close();await new Promise(r=>server.close(r))}
}
