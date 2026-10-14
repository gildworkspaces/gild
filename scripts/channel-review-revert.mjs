import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {spawn} from 'node:child_process'
import assert from 'node:assert/strict'
mkdirSync('.tmp',{recursive:true})
async function run(name,args,timeout=300000){
 const child=spawn(args[0]==='--test' ? process.execPath : 'bun',args,{env:{...process.env,GILD_TEST_CLI_DIR:process.env.GILD_TEST_CLI_DIR || '../gild-cli'},stdio:['ignore','pipe','pipe']})
 let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output+=b;writeFileSync('.tmp/channel-review-'+name+'.log',output)})
 const timer=setTimeout(()=>child.kill('SIGTERM'),timeout)
 const code=await new Promise(r=>child.on('exit',r));clearTimeout(timer)
 return {code,output}
}
const unit=['--test','lib/channel-runtime.test.ts','lib/channel.test.ts']
const cases=[
 ['agent-mention','lib/channel/do.ts','if (run <= AGENT_RUN_LIMIT) for','if (false) for'],
 ['loop-guard','lib/channel/do.ts','if (run <= AGENT_RUN_LIMIT) for','if (true) for'],
 ['loop-guard-reset','lib/channel/store.ts',".author.kind !== 'agent') break",".author.kind !== 'agent') continue"],
 ['loop-guard-note','lib/channel/do.ts','if (run === AGENT_RUN_LIMIT + 1) notes.push(','if (false) notes.push('],
 ['reply-validation','lib/channel/do.ts','if (replyTo && (','if (false && ('],
 ['rate','lib/channel/store.ts','].count > 30','].count > 31'],
 ['cache','lib/channel/do.ts','return this.authorization.valid(ws,','return new SocketAuthorization<WorkerSocket>().valid(ws,'],
 ['timer','lib/channel/do.ts','async alarm() {\n    this.authorization.clear()','async alarm() {'],
 ['timer-order','lib/channel/do.ts',"    try {\n      await this.broadcast({type:'presence',online:await this.online()})\n      await this.flushMentions()","    try {\n      await this.flushMentions()\n      await this.broadcast({type:'presence',online:await this.online()})"],
 ['access-event','lib/channel/do.ts',"if (e.event === 'push') {","if (false) {"],
 ['duplicate-agent-query','lib/channel/do.ts',"const agent = p.name.includes('/') && !identity.token ?", "const agent = p.name.includes('/') ?"],
 ['nonblocking-emission','lib/events/hub-do.ts','    return this.events.event(event.id)!.cursor','    await this.flushChannel()\n    return this.events.event(event.id)!.cursor'],
 ['session-guard','lib/channel/system.ts',"    if (typeof p.receipt?.target !== 'string' || typeof p.receipt?.id !== 'string' || !/^(pull:[1-9][0-9]*|commit:[a-f0-9]{40})$/.test(p.receipt.target)) return null\n",''],
 ['event-time','lib/channel/system.ts','created_at: e.created_at ?? new Date().toISOString()','created_at: new Date().toISOString()'],
 ['state-time','lib/channel/session.ts','Date.parse(state.data.last_activity)','state.data.last_activity'],
 ['receipt-forward','lib/repo-index-do.ts','...(state ? {state} : {})','...{}'],
 ['state','lib/channel/do.ts',"if (e.event === 'session') {",'if (false) {'],
 ['acl-notification','lib/metastore.ts','await channelAccessChanged(options.runtime?.channels ?? (await getCloudflareContext()).env as unknown as ChannelBindings,state.id)','await Promise.resolve()',['run','test:channel']],
 ['drain','scripts/api-test-worker.ts',').drainChannel()',').alarm()',['run','test:channel']],
 ['identity','lib/channel/identity.ts','return name',"return ''",['run','test:channel']],
 ['cookie-api','lib/api/production.ts','    authenticate: async (request) => {',`    authenticate: async (request) => {
      if (!request.headers.has('authorization')) {
        const me = await (await import('../session')).session()
        if (me?.name) return {id:'browser:'+me.name,name:me.name,publicKey:me.publicKey,scopes:null,repos:null}
      }`,['run','test:channel:web'],true],
 ['issue-action','app/api/repos/[owner]/[repo]/issues/[number]/route.ts',"if(action==='close'||action==='reopen')return legacy(request,'updateIssue',{owner,repo,number},{state:action==='close' ? 'closed' : 'open'})","if (!await caller(request)) return NextResponse.json({error:'sign in first'},{status:401})\nif(action==='close'||action==='reopen')return legacy(request,'updateIssue',{owner,repo,number},{state:action==='close' ? 'closed' : 'open'})",['run','test:channel:web'],true],
 ['pull-action','app/api/repos/[owner]/[repo]/pulls/[number]/route.ts',"if(action==='close'||action==='reopen')return legacy(request,'updatePull',{owner,repo,number},{state:action==='close' ? 'closed' : 'open'})","if (!await caller(request)) return NextResponse.json({error:'sign in first'},{status:401})\nif(action==='close'||action==='reopen')return legacy(request,'updatePull',{owner,repo,number},{state:action==='close' ? 'closed' : 'open'})",['run','test:channel:web'],true],
 ['approval','app/api/agents/requests/[id]/route.ts',"return legacy(request, 'decideAgentRequest', await ctx.params)","return Response.json({error:'Approval disabled'},{status:403})",['run','test:channel:web'],true],
 ['grant-ui','app/(portal)/[owner]/[repo]/settings/agents/page.tsx','{writer && myAgents.some((a) => !names.has(a)) && (','{false && myAgents.some((a) => !names.has(a)) && (',['run','test:channel:web'],true],
]
let rebuild=false
for(const [name,path,before,after,args=unit,web=false] of cases){
 if(process.argv[2] && process.argv[2]!==name)continue
 const original=readFileSync(path,'utf8')
 try {
  assert.ok(original.includes(before),name+' mutation applies')
  writeFileSync(path,original.replace(before,after))
  if(web){const build=await run(name+'-build',['run','build:cloudflare']);assert.equal(build.code,0,build.output);rebuild=true}
  const result=await run(name,args)
  assert.notEqual(result.code,0,name+' removal must fail behavior')
  assert.match(result.output,/AssertionError|ERR_ASSERTION|Timeout .*exceeded/,name+' must fail an effect assertion')
  assert.doesNotMatch(result.output,/Build failed|SyntaxError|Cannot find module|ERR_MODULE_NOT_FOUND/,name+' must compile')
  console.log('PASS reverted '+name+': effect test fails')
 } finally {writeFileSync(path,original)}
}
const restored=await run('restored',unit);assert.equal(restored.code,0,restored.output)
if(rebuild){const build=await run('restored-build',['run','build:cloudflare']);assert.equal(build.code,0,build.output);const web=await run('restored-web',['run','test:channel:web']);assert.equal(web.code,0,web.output)}
console.log('PASS restored review regression suite')
