import { readFileSync,writeFileSync,mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
mkdirSync('.tmp',{recursive:true})
const cases=[
  ['post','lib/channel/service.ts',"return {data:await channel.post(","throw new ApiError(403,'Posting disabled'); return {data:await channel.post("],
  ['history','lib/channel/store.ts','Number(q.after ?? q.before ?? latest + 1)','Number(q.after ?? latest + 1)'],
  ['permissions','lib/channel/service.ts','if (!canPost) throw','if (false) throw'],
  ['mention','lib/channel/participants.ts','return attached.filter(name=>','return [].filter(name=>'],
  ['system','lib/events/hub-do.ts',"if (systemNote(event) || event.event === 'push' || event.event === 'session') this.events.sql.exec",'if (false) this.events.sql.exec'],
  ['live','lib/channel/do.ts',"    const wire = JSON.stringify(presence ? {...data as object,participants:presence.participants} : data)","    if ((data as {type:string}).type==='message') return\n    const wire = JSON.stringify(presence ? {...data as object,participants:presence.participants} : data)"],
  ['socketauth','lib/channel/do.ts','await verifyStoredTokenHash(p.id,st)','await st.getApiToken(p.id)'],
  ['participants','components/repo/Channel.tsx','{p.prefix}{displayIdentity(p.name)}','{displayIdentity(p.name)}'],
  ['modal','components/repo/Channel.tsx','e.preventDefault();markChannelModal();router.push','e.preventDefault();return;markChannelModal();router.push'],
  ['actionlogs','lib/api/actions.ts','if (c.query.job !== undefined) {','if (false) {'],
  ['back','components/repo/Channel.tsx','router.push(channelObjectURL(base,m.link!.href)','router.replace(channelObjectURL(base,m.link!.href)'],
  ['comment','components/repo/IssueForms.tsx','await send(`/api/repos/${owner}/${repo}/issues/${number}/comments`, { body })','await Promise.resolve()'],
]
const run=async(name,args)=>{
  const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});let output=''
  for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output+=b;writeFileSync('.tmp/channel-revert-'+name+'.log',output)})
  const timer=setTimeout(()=>child.kill('SIGTERM'),180000)
  const code=await new Promise(r=>child.on('exit',r));clearTimeout(timer)
  return {code,output}
}
for(const [name,path,before,after] of cases) {
  if(process.argv[2] && process.argv[2]!==name)continue
  const original=readFileSync(path,'utf8')
  try {
    assert.ok(original.includes(before),name+' mutation must apply')
    writeFileSync(path,original.replace(before,after))
    const {code,output}=await run(name,name==='actionlogs' ? ['--test','lib/channel-actions.test.ts'] : ['scripts/api-local.mjs','--channel'])
    assert.notEqual(code,0,name+' removal must fail the effect check')
    assert.match(output,/AssertionError|ERR_ASSERTION|Timeout .*exceeded/,name+' must fail behavior')
    assert.doesNotMatch(output,/Build failed|SyntaxError|Cannot find module/,name+' must compile')
    console.log('PASS reverted '+name+': effect test fails')
  } finally {writeFileSync(path,original)}
}
const unit=await run('restored-actions',['--test','lib/channel-actions.test.ts']);assert.equal(unit.code,0,unit.output)
const restored=await run('restored',['scripts/api-local.mjs','--channel']);assert.equal(restored.code,0,restored.output)
console.log('PASS restored channel API/browser suite')
