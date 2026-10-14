import { flushChannelFixture } from './channel-fixture.mjs'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { randomBytes } from 'node:crypto'
import { join,resolve } from 'node:path'
export async function channelSuite({origin,request,work,token,browser=true}) {
  await build({entryPoints:['lib/api/contract.ts'],outfile:join(work,'channel-contract.mjs'),bundle:true,platform:'node',format:'esm'})
  const {routes}=await import(join(work,'channel-contract.mjs'))
  const base='/api/v1/repos/acme/demo/channel',tokens={owner:token}
  const checked=async(id,path,method='GET',body,headers={})=>{
    const r=await request(path,method,body,headers);assert.ok(r.ok,`${id}: ${r.status} ${await r.clone().text()}`)
    const d=await r.json();routes.find(r=>r.id===id).output.parse(d);return d
  }
  for(const [name,actor,scopes] of [['writer','writer',['repo:read','repo:write']],['reader','reader',['repo:read']],['bot','acme/channelbot',['repo:read','repo:write','issues:write','pulls:write']],['readonly','acme/channelread',['repo:read']],['special','acme/channelspecial',['repo:read','channel:write']]]) {
    tokens[name]='gf_'+randomBytes(16).toString('hex')
    const r=await request('/privacy-fixture','POST',{actor,token:tokens[name],scopes});assert.equal(r.status,200)
  }
  tokens.legacyWriter='gf_'+randomBytes(16).toString('hex')
  assert.equal((await request('/privacy-fixture','POST',{actor:'writer',token:tokens.legacyWriter,legacy:true,scopes:['repo:read','repo:write']})).status,200)
  const acl={schema:1,owners:['@acme'],write:['@writer'],read:['@reader'],agents:{'@acme/channelbot':['pr'],'@acme/channelread':['review'],'@acme/channelspecial':['review']}}
  await request('/privacy-fixture','POST',{acl});await flushChannelFixture(request)
  const as=name=>({authorization:`Bearer ${tokens[name]}`})
  const events=async(name,since='0')=>(await (await request('/api/v1/events?repos=acme/demo&wait=0&since='+since,'GET',undefined,as(name))).json())
  const anon={authorization:'','cf-connecting-ip':'192.0.2.50'}
  // Empty auth header is rejected, so use native fetch for anonymous requests.
  // The channel is contributors-only even on a public repository: anonymous readers get the private 404.
  const publicRead=await fetch(origin+base+'/messages',{headers:{'cf-connecting-ip':'192.0.2.50'}});assert.equal(publicRead.status,404)
  assert.equal((await fetch(origin+base+'/messages',{method:'POST',headers:{'content-type':'application/json','cf-connecting-ip':'192.0.2.50'},body:JSON.stringify({body:'anonymous'})})).status,401)
  for(const name of ['reader','readonly'])assert.equal((await request(base+'/messages','POST',{body:'forbidden'},as(name))).status,403)
  const parts=await checked('channelParticipants',base+'/participants')
  assert.equal(parts.can_post,true)
  assert.deepEqual(parts.participants.map(p=>p.kind),[...parts.participants.map(p=>p.kind)].sort((a,b)=>Number(a==='agent')-Number(b==='agent')))
  assert.equal(parts.participants.find(p=>p.name==='acme').prefix,'@')
  assert.equal(parts.participants.find(p=>p.name==='writer').prefix,'+')
  assert.equal(parts.participants.find(p=>p.name==='acme/channelbot').prefix,'+')
  assert.equal(parts.participants.find(p=>p.name==='acme/channelread').prefix,'')
  await checked('channelPost',base+'/messages','POST',{body:'writer speaks'},as('writer'))
  // Agents may start conversations: an unprompted post tags another agent exactly once.
  const unpromptedStart=(await events('readonly')).cursor
  const unprompted=await checked('channelPost',base+'/messages','POST',{body:'@acme/channelread heads up: external build failed'},as('bot'))
  assert.equal(unprompted.reply_to,null)
  const unpromptedEvents=(await events('readonly',unpromptedStart)).events.filter(e=>e.event==='channel.mention')
  assert.equal(unpromptedEvents.length,1);assert.equal(unpromptedEvents[0].payload.agent,'acme/channelread');assert.equal(unpromptedEvents[0].payload.history_cursor,unprompted.cursor)
  assert.equal((await request(base+'/messages','POST',{body:'bad reply',reply_to:'99999999'},as('bot'))).status,422)
  const invitation=await checked('channelPost',base+'/messages','POST',{body:'@channelbot @channelspecial answer please'})
  await checked('channelPost',base+'/messages','POST',{body:'agent replies',reply_to:invitation.cursor},as('bot'))
  await checked('channelPost',base+'/messages','POST',{body:'channel scope replies',reply_to:invitation.cursor},as('special'))
  await checked('channelPost',base+'/messages','POST',{body:'second answer to the same mention',reply_to:invitation.cursor},as('bot'))
  const all=await checked('channelMessages',base+'/messages?limit=2')
  assert.equal(all.messages.length,2);assert.ok(all.before)
  const older=await checked('channelMessages',base+'/messages?before='+all.before+'&limit=1')
  assert.equal(older.messages.length,1);assert.ok(Number(older.messages[0].cursor)<Number(all.messages[0].cursor))
  const newer=await checked('channelMessages',base+'/messages?after='+older.messages[0].cursor+'&limit=1')
  assert.equal(newer.messages[0].cursor,all.messages[0].cursor);assert.ok(newer.after)
  assert.equal((await request(base+'/messages?before=2&after=1')).status,422)
  assert.equal((await request(base+'/messages?after=999999999')).status,422)
  const start=(await events('bot')).cursor
  const mention=await checked('channelPost',base+'/messages','POST',{body:'@channelbot @acme/channelbot @channelbot please check; @missing is absent'})
  const notified=(await events('bot',start)).events.filter(e=>e.event==='channel.mention')
  assert.equal(notified.length,1)
  assert.equal(notified[0].payload.agent,'acme/channelbot');assert.equal(notified[0].payload.message.id,mention.id);assert.equal(notified[0].payload.history_cursor,mention.cursor)
  assert.equal((await events('readonly',start)).events.filter(e=>e.event==='channel.mention').length,0)
  const history=await checked('channelMessages',base+'/messages?before='+(Number(mention.cursor)+1))
  assert.ok(history.messages.some(m=>m.id===mention.id))
  // The tagged agent's own token reads the history around the event and answers it.
  const cursor=notified[0].payload.history_cursor
  const botHistory=await checked('channelMessages',base+'/messages?before='+(Number(cursor)+1)+'&limit=10','GET',undefined,as('bot'))
  assert.ok(botHistory.messages.some(m=>m.cursor===cursor&&m.id===mention.id&&m.body.includes('please check')))
  const answer=await checked('channelPost',base+'/messages','POST',{body:'on it',reply_to:cursor},as('bot'))
  assert.equal(answer.reply_to,cursor);assert.deepEqual(answer.author,{name:'acme/channelbot',kind:'agent'})
  await checked('channelPost',base+'/messages','POST',{body:'and a follow-up',reply_to:cursor},as('bot'))
  const event={id:'channel-system-proof-'+randomBytes(8).toString('hex'),event:'pull_request',repository:'acme/demo',payload:{sender:{login:'acme/channelbot'},action:'opened',pull_request:{number:2,title:'Seed PR'}}}
  await request('/emit-fixture','POST',event);await request('/emit-fixture','POST',event)
  await flushChannelFixture(request)
  const system=(await checked('channelMessages',base+'/messages')).messages.filter(m=>m.id===event.id)
  assert.equal(system.length,1);assert.equal(system[0].author.kind,'agent');assert.deepEqual(system[0].link,{href:'/acme/demo/pulls/2',label:'PR #2 "Seed PR"'})
  const issueEvent={...event,id:event.id+'issue',event:'issues',payload:{sender:{login:'acme/channelbot'},action:'opened',issue:{number:1,title:'Seed issue'}}}
  await request('/emit-fixture','POST',issueEvent)
  await flushChannelFixture(request)
  // The real issue writer must share the same emission path.
  const real=await request('/api/v1/repos/acme/demo/issues','POST',{title:'Channel action proof'},as('bot'))
  assert.equal(real.status,201,await real.clone().text());const created=await real.json();await flushChannelFixture(request)
  const realNotes=(await checked('channelMessages',base+'/messages?limit=200')).messages.filter(m=>m.kind==='system'&&m.author.name==='acme/channelbot'&&m.link?.href===`/acme/demo/issues/${created.number}`)
  assert.equal(realNotes.length,1)
  await request('/privacy-fixture','POST',{acl:{...acl,visibility:'private'}});await flushChannelFixture(request)
  assert.equal((await fetch(origin+base+'/messages',{headers:{'cf-connecting-ip':'192.0.2.50'}})).status,404)
  assert.equal((await request(base+'/messages','GET',undefined,as('reader'))).status,200)
  assert.equal((await request(base+'/messages','GET',undefined,{authorization:'Bearer invalid'})).status,401)
  await request('/privacy-fixture','POST',{acl});await flushChannelFixture(request)
  let screenshots=[]
  if(browser) {
    const {verifyChannel}=await import('./channel-browser.mjs')
    screenshots=await verifyChannel({origin,token,tokens,request,work})
  }
  const rateActor='rateuser',rateToken='gf_'+randomBytes(16).toString('hex')
  await request('/privacy-fixture','POST',{actor:rateActor,token:rateToken,scopes:['repo:read','repo:write']})
  await request('/privacy-fixture','POST',{acl:{...acl,write:[...acl.write,'@'+rateActor]}});await flushChannelFixture(request)
  // Keep this fixed-window assertion inside one minute, even on a busy host.
  const offset=Date.now()%60000
  if(offset>30000)await new Promise(resolve=>setTimeout(resolve,60000-offset+20))
  const rateMinute=Math.floor(Date.now()/60000)
  const rates=await Promise.all(Array.from({length:30},(_,i)=>request(base+'/messages','POST',{body:'rate '+i},{authorization:'Bearer '+rateToken})))
  for(const response of rates)assert.equal(response.status,201)
  assert.equal(Math.floor(Date.now()/60000),rateMinute,'rate check stays in its fixed minute window')
  assert.equal((await request(base+'/messages','POST',{body:'too many'},{authorization:'Bearer '+rateToken})).status,429)
  await request('/privacy-fixture','POST',{acl:{schema:1,owners:['@acme'],agents:{'@acme/bot':['pr','review','queue'],'@acme/requested':['pr','review','queue']}}});await flushChannelFixture(request)
  console.log('Channel: post, cursors, permissions, private parity, scoped agents, targeted mention, deduplicated real system notes, rate limit passed')
  return {covered:['channelMessages','channelPost','channelParticipants','channelStream'],screenshots}
}
