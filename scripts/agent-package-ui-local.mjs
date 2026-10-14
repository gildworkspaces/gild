import {forgeFixture} from './forge-fixture.mjs'
import {launchChrome} from './chrome.mjs'
import {execFileSync} from 'node:child_process'
import {writeFileSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
import assert from 'node:assert/strict'
const f=await forgeFixture({renderBuild:false,agentPackage:true}),base='/settingstest/demo',api='/api/repos/settingstest/demo',dir=join(f.work,'git/o-settingstest/demo.git'),out=join(f.work,'package-ui')
mkdirSync(out,{recursive:true})
const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:'pipe'}).trim()
const head=()=>git('rev-parse','refs/heads/main')
const file=()=>JSON.parse(git('show','refs/heads/main:gild.json'))
let browser,passed=false
const call=async(path,name,method='GET',body,headers={})=>fetch(f.origin+path,{method,headers:{...(name?{cookie:'gild_session='+f.cookie(name)}:{}),'content-type':'application/json',origin:f.origin,...headers},body:body===undefined?undefined:JSON.stringify(body)})
const expect=async(r,status)=>{assert.equal(r.status,status,await r.clone().text());return r}
try {
 const deadline=Date.now()+90000
 for(;;){try{const r=await fetch(f.origin+'/api/v1/repos/settingstest/demo/contents/gild.json?ref=main',{headers:{authorization:'Bearer '+f.tokens.writer},signal:AbortSignal.timeout(3000)});if(r.ok)break}catch{}assert.ok(Date.now()<deadline,'Owned private fixture initialization');await new Promise(r=>setTimeout(r,250))}
 const before=head(),original=file(),input={branch:'main',expected_head:before,text:JSON.stringify({...original,agents:{...original.agents,ava:{...original.agents.ava,model:'saved-fixture',requestedPermissions:['repo:read','repo:write']}}})}
 await expect(await call(api+'/contents/gild.json?ref=main','reader'),200)
 await expect(await call(api+'/contents/gild.json?ref=main','outsider'),404)
 await expect(await call(api+'/contents/gild.json?ref=main',null),404)
 await expect(await call(api+'/agent-package','reader','PUT',input),403)
 await expect(await call(api+'/agent-package','outsider','PUT',input),404)
 await expect(await call(api+'/agent-package','writer','PUT',input,{origin:'https://foreign.example'}),403)
 await expect(await call(base+'.git/git-receive-pack','writer','POST'),401)
 await expect(await call(api+'/agent-package','writer','PUT',{...input,path:'README.md'}),422)
 await expect(await call(api+'/agent-package','writer','PUT',{...input,text:JSON.stringify({...original,credentials:{token:'fake-forbidden'}})}),422)
 assert.equal(head(),before,'Denied/invalid/CSRF attempts must not move Git HEAD')
 browser=await launchChrome();const context=await browser.newContext({viewport:{width:1440,height:1100}})
 await context.addCookies([{name:'gild_session',value:f.cookie('writer'),domain:'127.0.0.1',path:'/',httpOnly:true}])
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto(f.origin+base+'/agents');const link=page.getByRole('link',{name:'Package profiles',exact:true});await link.waitFor();assert.equal(await link.count(),1,'Agents must expose the functional package profiles editor');await link.click();await page.waitForURL('**/agents/package');await page.getByRole('button',{name:'Open manifest',exact:true}).click()
 await page.getByRole('status').filter({hasText:'Committed package loaded'}).waitFor()
 const members=page.locator('[aria-label="Declared agent members"] article');assert.equal(await members.count(),3)
 await page.getByText('Reference:',{exact:false}).waitFor();await page.getByRole('link',{name:'https://gild.gg/example/team.git',exact:true}).waitFor()
 await page.getByRole('button',{name:'Edit manifest',exact:true}).click()
 const editor=page.getByRole('textbox',{name:'Manifest JSON',exact:true});await editor.fill('{"invalid":true}');await page.getByRole('button',{name:'Validate edits',exact:true}).click();await page.locator('[aria-label="Agent package"]').getByRole('alert').waitFor()
 assert.equal(head(),before,'Invalid local edit must not write')
 await page.getByRole('button',{name:'Cancel edits',exact:true}).click();await page.getByRole('button',{name:'Edit manifest',exact:true}).click();assert.equal(JSON.parse(await editor.inputValue()).agents.ava.model,'before','Cancel restores committed bytes')
 await editor.fill(input.text)
 const savedResponse=page.waitForResponse(r=>r.url().endsWith('/agent-package')&&r.request().method()==='PUT')
 await page.getByRole('button',{name:'Save manifest',exact:true}).click();const result=await savedResponse;assert.equal(result.status(),200,await result.text());const saved=await result.json()
 await page.getByRole('status').filter({hasText:'Saved gild.json to main'}).waitFor()
 assert.equal(head(),saved.commit,'Save must reach actual Git receive-pack/CAS')
 assert.equal(file().agents.ava.model,'saved-fixture')
 assert.deepEqual(file().agents.ava.requestedPermissions,['repo:read','repo:write'])
 assert.deepEqual(git('diff','--name-only',before,saved.commit).split('\n'),['gild.json'],'Only the canonical manifest changes')
 await expect(await call(api+'/agent-package','writer','PUT',input),409)
 assert.equal(head(),saved.commit,'A stale expected HEAD must not overwrite the committed edit')
 const reader=await browser.newContext();await reader.addCookies([{name:'gild_session',value:f.cookie('reader'),domain:'127.0.0.1',path:'/',httpOnly:true}]);const rp=await reader.newPage();await rp.goto(f.origin+base+'/agents/package');await rp.getByRole('button',{name:'Open manifest',exact:true}).click();await rp.getByRole('status').filter({hasText:'Committed package loaded'}).waitFor();assert.equal(await rp.getByRole('button',{name:'Edit manifest',exact:true}).count(),0,'Read access must not expose write controls')
 await page.screenshot({path:out+'/saved-package.png',fullPage:true});await rp.screenshot({path:out+'/reader-package.png',fullPage:true});assert.deepEqual(errors,[])
 writeFileSync(out+'/result.json',JSON.stringify({actualCompiledWorker:true,privateFixture:true,multipleInlineReferenceMembers:true,authorizedReadEditSave:true,canonicalValidationAndCancel:true,deniedReaderWriter:true,unauthorizedReadWrite:true,csrfDenied:true,externalCookieGitPushDenied:true,onlyGildJsonChanged:true,staleHeadConflict:true,requestedPermissionsOnlyData:true,pageErrors:errors,commit:saved.commit,fixtureWork:f.work,productionOrRealHttpsTarget:false},null,2)+'\n');passed=true;console.log(JSON.stringify({passed,fixtureWork:f.work,evidence:out}))
} finally {await browser?.close();if(f.worker.exitCode===null){f.worker.kill('SIGTERM');await new Promise(r=>f.worker.once('exit',r))}f.server.closeAllConnections();await new Promise(r=>f.server.close(r));writeFileSync(out+'/wrangler.log',f.logs);if(!passed)console.error('Owned evidence retained at '+out)}
