import { forgeFixture } from './forge-fixture.mjs'
import { publishRepoTabs } from './nav-fixture.mjs'
import { launchChrome } from './chrome.mjs'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
const f=await forgeFixture(),repo='settingstest/demo',base='/'+repo,api='/api/v1/repos/'+repo
const call=async(path,method='GET',body)=>{const r=await fetch(f.origin+path,{method,headers:{authorization:'Bearer '+f.tokens.avatest,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)});assert.ok(r.ok,await r.clone().text());return r.json()}
let browser, pageForFailure
// React attaches its props to a DOM node when it hydrates that node.
const hydrated=async locator=>{await locator.waitFor();await locator.page().waitForFunction(el=>Object.keys(el).some(k=>k.startsWith('__reactProps$')),await locator.elementHandle())}
try {
  const deadline=Date.now()+60000
  while(true){try{if((await fetch(f.origin+'/api/v1/openapi.json',{signal:AbortSignal.timeout(1000)})).ok)break}catch{}if(Date.now()>deadline)throw Error(f.logs);await new Promise(r=>setTimeout(r,250))}
  // Prepare the anonymous shell through the real publisher before browsing.
  await call('/__fixture/public-pages?route='+encodeURIComponent(base+'/agents'))
  // Warm the actual page/index boundary before mutating the repo.
  let pageResponse
  for(let i=0;i<100;i++){pageResponse=await fetch(f.origin+base+'/agents',{headers:{cookie:'gild_session='+f.cookie('avatest')}});if(pageResponse.ok)break;if(pageResponse.status===503)await call('/__fixture/public-pages?route='+encodeURIComponent(base+'/agents'));await new Promise(r=>setTimeout(r,200))}
  assert.equal(pageResponse.status,200,await pageResponse.text())
  const timings=[]
  for(let i=0;i<6;i++){const start=performance.now();await call(api+'/channel/messages');timings.push(Math.round(performance.now()-start))}
  const historyTiming={firstRequestMs:timings[0],repeatMedianMs:timings.slice(1).sort((a,b)=>a-b)[2],cache:'no-store; repeated requests still read the DO'}
  // The browser must grant the previously unattached agent itself.
  await call('/__fixture/agent-request','POST',{id:'channel-pending',label:'channelpending'})
  const issue=await call(api+'/issues','POST',{title:'Channel modal proof',body:`Shared production issue page. [Browse code](${base})`})
  // The static router prefetches every root tab. Publish their post-mutation
  // documents first, matching a warm production repo instead of stressing
  // cold background publication while the channel/control assertions run.
  await publishRepoTabs(f,base)
  browser=await launchChrome()
  const aContext=await browser.newContext({viewport:{width:1280,height:1000}}),bContext=await browser.newContext({viewport:{width:1280,height:1000}})
  for(const [ctx,name] of [[aContext,'avatest'],[bContext,'adminuser']])await ctx.addCookies([{name:'gild_session',value:f.cookie(name),domain:new URL(f.origin).hostname,path:'/',httpOnly:true}])
  const [a,b]=await Promise.all([aContext.newPage(),bContext.newPage()]),errors=[]
  pageForFailure=a
  for(const page of [a,b])page.on('pageerror',e=>errors.push(e.message))
  await Promise.all([a,b].map(p=>p.goto(f.origin+base+'/agents')))
  await Promise.all([a,b].map(p=>p.getByRole('status',{name:'Channel connection'}).filter({hasText:/^live/}).waitFor({timeout:30000})))
  const cookieHeaders={cookie:'gild_session='+f.cookie('avatest'),'content-type':'application/json','x-gild-browser-intent':'same-origin'}
  for (const origin of [undefined, 'https://attacker.test', f.origin]) {
    const rejected=await fetch(f.origin+api+'/issues',{method:'POST',headers:{...cookieHeaders,...(origin?{origin}: {})},body:JSON.stringify({title:'Cookie-only v1 must be rejected'})})
    assert.ok([401,403].includes(rejected.status),'cookie-only non-channel v1 POST must reject browser-intent header: '+rejected.status)
  }
  const unsafeChannel=await fetch(f.origin+api+'/channel/messages',{method:'POST',headers:{...cookieHeaders,origin:'https://attacker.test'},body:JSON.stringify({body:'Cross-origin channel must reject'})})
  assert.ok([401,403].includes(unsafeChannel.status))
  await a.getByRole('link',{name:'Manage agents',exact:true}).click()
  await a.getByRole('heading',{name:/Waiting for your approval/}).waitFor()
  // "Manage agents" is a full navigation: the server HTML (heading, form) paints
  // before React hydrates it. A click before hydration submits the bare form as
  // a GET and never sends the grant POST, so wait for React to own the control.
  await hydrated(a.getByRole('button',{name:'Grant',exact:true}))
  await a.getByRole('combobox',{name:'Agent',exact:true}).selectOption('avatest/codex')
  const granted=a.waitForResponse(r=>r.url().endsWith('/api/repos/settingstest/demo/agents') && r.request().method()==='POST')
  await a.getByRole('button',{name:'Grant',exact:true}).click()
  assert.ok((await granted).ok())
  await a.getByRole('button',{name:'Save grants',exact:true}).waitFor()
  assert.deepEqual((await call(api+'/agents')).agents['@avatest/codex'],['pr'])
  // Settings → Agents: the owner makes it an orchestrator, then takes it offline and back.
  const codexCard=a.locator('article').filter({hasText:'@avatest/codex'})
  const orchestrated=a.waitForResponse(r=>r.url().endsWith('/api/repos/settingstest/demo/orchestrators')&&r.request().method()==='POST')
  // Controlled by the server state: the box ticks after the grant refreshes the page.
  await codexCard.getByRole('checkbox',{name:'orchestrator',exact:true}).click()
  assert.ok((await orchestrated).ok())
  await codexCard.getByText('% orchestrator',{exact:true}).waitFor()
  assert.equal(await codexCard.getByRole('checkbox',{name:'orchestrator',exact:true}).isChecked(),true)
  assert.deepEqual((await call(api+'/orchestrators')).orchestrators.map(o=>o.agent),['avatest/codex'])
  const suspended=a.waitForResponse(r=>r.url().endsWith('/api/repos/settingstest/demo/agents/avatest/codex/suspend'))
  await codexCard.getByRole('button',{name:'Suspend',exact:true}).click()
  assert.ok((await suspended).ok())
  await codexCard.getByRole('button',{name:'Resume',exact:true}).waitFor()
  assert.ok(!(await call(api+'/channel/participants')).participants.some(p=>p.name==='avatest/codex'),'a suspended agent leaves the channel')
  await a.screenshot({path:join(f.work,'agents-orchestrator-suspended.png'),fullPage:true})
  await codexCard.getByRole('button',{name:'Resume',exact:true}).click()
  await codexCard.getByRole('button',{name:'Suspend',exact:true}).waitFor()
  assert.equal((await call(api+'/channel/participants')).participants.find(p=>p.name==='avatest/codex').prefix,'%')
  const approved=a.waitForResponse(r=>r.url().endsWith('/api/agents/requests/channel-pending') && r.request().method()==='POST')
  await a.getByRole('button',{name:'Approve',exact:true}).click()
  const approvalResponse=await approved
  assert.ok(approvalResponse.ok(),await approvalResponse.text())
  await a.getByRole('button',{name:'Approve',exact:true}).waitFor({state:'detached'})
  assert.deepEqual((await call(api+'/agents')).agents['@avatest/channelpending'],['pr'])
  await a.goto(f.origin+base+'/agents')
  await a.getByRole('status',{name:'Channel connection'}).filter({hasText:/^live/}).waitFor()
  const agentToken=await call('/__fixture/channel-agent-token','POST',{agent:'avatest/codex'})
  let receiptId
  const started_at=new Date().toISOString()
  for (const [status,tool,label] of [['busy','Edit','● busy · Edit'],['waiting',undefined,'◐ waiting'],['idle',undefined,'○ idle']]) {
    const response=await fetch(f.origin+api+'/pulls/2/sessions',{method:'POST',headers:{authorization:'Bearer '+agentToken.token,'content-type':'application/json'},body:JSON.stringify({id:receiptId,model:'channel-proof',started_at,state:{status,tool,last_activity:new Date().toISOString()}})})
    assert.equal(response.status,201,await response.clone().text())
    const receipt=await response.json();receiptId=receipt.id
    assert.equal(receipt.state.status,status)

    await a.locator('aside li').filter({hasText:'avatest/codex'}).getByText(label,{exact:true}).waitFor()
  }
  await a.getByRole('textbox',{name:'Channel message',exact:true}).fill('@codex take a look at this issue')
  await a.getByRole('textbox',{name:'Channel message',exact:true}).press('Enter')
  await b.getByText('@codex take a look at this issue',{exact:true}).waitFor()
  await b.getByRole('textbox',{name:'Channel message',exact:true}).fill('I can review the change here.')
  await b.getByRole('textbox',{name:'Channel message',exact:true}).press('Enter')
  await a.getByText('I can review the change here.',{exact:true}).waitFor()
  const people=await a.locator('aside[aria-label="Participants"] li').allTextContents()
  assert.ok(people.indexOf('@avatest')<people.findIndex(p=>p.includes('avatest/codex')))
  assert.ok(people.some(p=>p.startsWith('%avatest/codex')),'the orchestrator carries % in the participants column')
  await a.getByRole('link',{name:`issue #${issue.number} "Channel modal proof"`,exact:true}).click()
  await a.getByRole('dialog').getByRole('heading',{name:/Channel modal proof/}).waitFor()
  const target=new URL(a.url()).searchParams.get('object');assert.equal(target,base+'/issues/'+issue.number)
  const posted=a.waitForResponse(r=>r.url().endsWith(`/issues/${issue.number}/comments`)&&r.request().method()==='POST')
  await a.getByRole('dialog').getByRole('textbox',{name:'Comment',exact:true}).fill('Commented in the shared issue page modal.')
  await a.getByRole('dialog').getByRole('button',{name:'Comment',exact:true}).click()
  assert.equal((await posted).status(),201)
  await a.getByRole('dialog').getByText('Commented in the shared issue page modal.',{exact:true}).waitFor()
  assert.ok((await call(api+`/issues/${issue.number}/comments`)).some(c=>c.body==='Commented in the shared issue page modal.'))
  const closedIssue=a.waitForResponse(r=>r.url().endsWith(`/issues/${issue.number}`)&&r.request().method()==='POST')
  await a.getByRole('dialog').getByRole('button',{name:'Close issue',exact:true}).click()
  assert.ok((await closedIssue).ok())
  await a.getByRole('dialog').getByRole('button',{name:'Reopen issue',exact:true}).waitFor()
  await a.getByRole('dialog').getByRole('link',{name:'Browse code',exact:true}).click()
  const treeLoaded=a.waitForResponse(r=>r.url().includes('/tree?hash=')&&r.request().method()==='GET')
  await a.getByRole('dialog').getByRole('button',{name:/lib$/}).click()
  assert.equal((await treeLoaded).status(),200)
  await a.getByRole('dialog').getByRole('link',{name:/pulls\.ts$/}).click()
  await a.getByRole('dialog').locator('pre code .line').filter({hasText:'export const createPull = () => "fixture"'}).waitFor()
  assert.equal(new URL(new URL(a.url()).searchParams.get('object'),f.origin).searchParams.get('path'),'lib/pulls.ts')
  await a.goBack();await a.getByRole('dialog').waitFor({state:'detached'});assert.equal(a.url(),f.origin+base+'/agents','Back restores the channel after nested object navigation')
  const pullTarget=base+'/pulls/2'
  await a.goto(f.origin+base+'/agents?object='+encodeURIComponent(pullTarget))
  await a.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).waitFor()
  const closedPull=a.waitForResponse(r=>r.url().endsWith('/pulls/2')&&r.request().method()==='POST')
  await a.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click()
  assert.ok((await closedPull).ok())
  await a.getByRole('dialog').getByRole('button',{name:'Reopen',exact:true}).waitFor()
  assert.equal((await call(api+'/pulls/2')).state,'closed')
  await a.getByRole('button',{name:'Close object'}).click()
  // Deep links render the same page and have a close path on a fresh tab.
  const share=await aContext.newPage();await share.goto(f.origin+base+'/agents?object='+encodeURIComponent(target));await share.getByRole('dialog').getByRole('heading',{name:/Channel modal proof/}).waitFor();await share.getByRole('button',{name:'Close object'}).click();await share.getByRole('dialog').waitFor({state:'detached'});await share.close()
  for(const [theme,width] of [['light',1280],['dark',1280],['dark',390]]) {
    await a.setViewportSize({width,height:1000});await a.evaluate(theme=>{localStorage.setItem('gild.theme',theme);document.documentElement.dataset.theme=theme},theme)
    if(width===390){await a.getByRole('button',{name:/Participants/}).click();assert.equal(await a.getByRole('complementary',{name:'Participants'}).isVisible(),true);await a.getByRole('button',{name:/Participants/}).click()}
    assert.ok(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
    const inputBox=await a.getByRole('textbox',{name:'Channel message',exact:true}).boundingBox();assert.ok(inputBox.y+inputBox.height<=1000,'input stays inside the phone viewport')
    await a.screenshot({path:join(f.work,`channel-${theme}-${width}.png`),fullPage:true})
  }
  // The private handshake must survive the outer production privacy wrapper.
  await call(api+'/visibility','PATCH',{visibility:'private',confirm:repo})
  await a.reload();await a.getByRole('status',{name:'Channel connection'}).filter({hasText:/^live/}).waitFor({timeout:30000})
  assert.deepEqual(errors,[])
  writeFileSync(join(f.work,'channel-evidence.json'),JSON.stringify({runtime:'compiled OpenNext Worker + real D1/DO/Git',repo,issue:issue.number,historyTiming,screenshots:['channel-light-1280.png','channel-dark-1280.png','channel-dark-390.png'],checks:['cookie-only non-channel v1 POST rejected','cross-origin channel POST rejected','Settings Agents grant persisted','Settings Agents orchestrator grant, suspend and resume','% orchestrator prefix','pending request approved with persisted grants','receipt state busy/Edit waiting idle','two cookie clients live','participant order','shared issue page modal','CSRF-checked comment persisted','close issue','close pull request','private-compatible browser tree expansion','shared file view','Back after nested navigation','deep link','phone','private WebSocket']},null,2))
  console.log('Full channel web: '+f.work+' — live cookie clients, grants and pending approval, cookie v1 rejection, busy/waiting/idle state, shared issue modal comment/close/Back/deep link, light/dark/phone, private handshake passed')
} catch(error) {
  console.error('Channel fixture: '+f.work)
  if(pageForFailure){writeFileSync(join(f.work,'channel-failure.html'),await pageForFailure.content());await pageForFailure.screenshot({path:join(f.work,'channel-failure.png'),fullPage:true})}
  throw error
} finally {await browser?.close();f.worker.kill('SIGTERM');await new Promise(r=>f.server.close(r))}
