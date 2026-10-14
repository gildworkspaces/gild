import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { ChannelStore } from './channel/store.ts'
import { systemNote } from './channel/system.ts'
import { mentionedAgents } from './channel/participants.ts'
import { channelInput } from './api/channel-contract.ts'
import type { Emission } from './api/events-contract.ts'
function fixture() {
  const db=new DatabaseSync(':memory:')
  const sql={exec:(q:string,...args:any[])=>{if(!args.length&&q.includes(';')){db.exec(q);return []}return db.prepare(q).all(...args) as any}}
  return {db,log:new ChannelStore(sql)}
}
test('channel cursor windows are stable while new messages arrive and retry sources append once',()=>{
  const {db,log}=fixture()
  const append=(n:number)=>log.append('event-'+n,{id:'id-'+n,created_at:new Date(n).toISOString(),author:{name:'sami/codex',kind:'agent'},kind:'system',body:'opened',link:{href:'/owner/repo/issues/'+n,label:'issue #'+n},reply_to:null})
  for(let n=1;n<=5;n++)append(n)
  const first=log.page({limit:2});assert.deepEqual(first.messages.map(m=>m.id),['id-4','id-5'])
  append(6);append(6)
  const old=log.page({before:first.before!,limit:2});assert.deepEqual(old.messages.map(m=>m.id),['id-2','id-3'])
  const after=log.page({after:first.cursor,limit:2});assert.deepEqual(after.messages.map(m=>m.id),['id-6'])
  assert.equal(log.page({limit:200}).messages.length,6)
  assert.throws(()=>log.page({after:'9000',limit:50}),/Invalid channel cursor/)
  db.close()
})
test('channel rate is per account across tokens and resets at the minute boundary',()=>{
  const {db,log}=fixture()
  for(let n=0;n<30;n++)log.rate('account',120000)
  assert.throws(()=>log.rate('account',120000),/posting limit/)
  assert.doesNotThrow(()=>log.rate('other account',120000))
  assert.doesNotThrow(()=>log.rate('account',180000))
  db.close()
})
test('mentions match attached full names and unique short names once, with token boundaries',()=>{
  const names=['sami/codex','ava/codex','sami/claude']
  assert.deepEqual(mentionedAgents('@codex ambiguous, @claude @sami/claude @sami/codex',names),['sami/codex','sami/claude'])
  assert.deepEqual(mentionedAgents('email@sami/claude @sami/claude-extra @missing @sami/codex/child',names),[])
})
test('system notes link real issues, pulls, pushes, Actions and sessions and quiet humans by actor kind',()=>{
  const event=(type:Emission['event'],payload:Record<string,unknown>):Emission=>({id:type,repository:'sami/repo',event:type,payload:{sender:{login:'sami/codex'},...payload}})
  assert.equal(systemNote(event('issues',{action:'assigned',issue:{number:4,title:'Fix'}}))!.body,'claimed')
  assert.equal(systemNote(event('pull_request',{action:'closed',pull_request:{number:4,merged:true}}))!.body,'merged')
  assert.equal(systemNote(event('push',{after:'a'.repeat(40),ref:'refs/heads/topic'}))!.link!.href,'/sami/repo/commit/'+'a'.repeat(40))
  assert.equal(systemNote(event('workflow_run',{action:'completed',workflow_run:{id:8,name:'CI'}}))!.link!.href,'/sami/repo/actions/8')
  assert.equal(systemNote(event('session',{action:'ended',receipt:{id:'s',target:'pull:4'}}))!.link!.href,'/sami/repo/pulls/4')
  assert.equal(systemNote(event('session',{action:'updated',receipt:{id:'s',target:'pull:4'}})),null,'state updates belong to the roster')
  assert.equal(systemNote(event('issue_comment',{issue:{number:4,pull_request:{}},sender:{login:'sami'}}))!.author.kind,'human')
  assert.equal(systemNote(event('channel.mention',{})),null)
  assert.equal(systemNote(event('push',{ref:'refs/heads/_meta',after:'a'.repeat(40)})),null)
  assert.equal(systemNote(event('merge_queue',{number:4})),null,'the accompanying pull event owns the queue note')
})
test('channel input rejects blank and oversized messages and accepts mention reply cursors',()=>{
  assert.equal(channelInput.safeParse({body:'   '}).success,false)
  assert.equal(channelInput.safeParse({body:'a'.repeat(4001)}).success,false)
  assert.deepEqual(channelInput.parse({body:' reply ',reply_to:'4'}),{body:'reply',reply_to:'4'})
})

test('malformed session notes are ignored without throwing',()=>{
  for(const receipt of [undefined, null, {}, {id:'s'}, {id:'s',target:5}, {id:'s',target:'unknown:4'}]) {
    assert.doesNotThrow(()=>assert.equal(systemNote({id:'bad',event:'session',repository:'sami/repo',payload:{receipt}}),null))
  }
})
test('system notes preserve emission time across delayed delivery',()=>{
  const event:Emission={id:'delayed',event:'issues',repository:'sami/repo',created_at:'2026-10-08T12:00:00Z',payload:{issue:{number:1}}}
  assert.equal(systemNote(event)!.created_at,event.created_at)
})
