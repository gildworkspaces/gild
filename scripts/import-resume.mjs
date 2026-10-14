import { forgeFixture } from './forge-fixture.mjs'
import {writeFileSync,readFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {spawn,execFileSync} from 'node:child_process'
import assert from 'node:assert/strict'
const work=resolve(process.argv[2]),f=await forgeFixture({reuseWork:work}),{origin,tokens,git,gitRoot}=f
console.log('Resume fixture: '+work)
const memory={samples:0,baseline_kib:0,peak_kib:0}
function memorySample(){try{const rows=execFileSync('ps',['-axo','pid,ppid,rss,comm'],{encoding:'utf8'}).trim().split('\n').slice(1).map(line=>{const [pid,ppid,rss,...command]=line.trim().split(/\s+/);return {pid:Number(pid),ppid:Number(ppid),rss:Number(rss),command:command.join(' ')}}),descendants=new Set([f.worker.pid]);let changed=true;while(changed){changed=false;for(const row of rows)if(descendants.has(row.ppid)&&!descendants.has(row.pid)){descendants.add(row.pid);changed=true}}const rss=rows.filter(r=>descendants.has(r.pid)&&r.command.endsWith('workerd')).reduce((sum,r)=>sum+r.rss,0);if(rss){memory.samples++;memory.baseline_kib ||= rss;memory.peak_kib=Math.max(memory.peak_kib,rss)}}catch{}}
const memoryTimer=setInterval(memorySample,1000)
async function call(operation,body){const r=await fetch(origin+'/api/v1/repos/avatest/import-mid/import'+operation,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+tokens.avatest,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)});assert.equal(r.status,200,await r.clone().text());return r.json()}
try{
 for(let n=0;;n++){try{const r=await fetch(origin+'/api/v1/openapi.json',{signal:AbortSignal.timeout(1000)});if(r.ok)break}catch{}if(n>90)throw Error('Worker did not start');await new Promise(r=>setTimeout(r,250))}
 await fetch(origin+'/__fixture/import-counters?repository=avatest/import-mid&discard=1');
 const before=await call('');console.log('Prior state: '+before.state+'; '+before.progress.completed+' records')
 if(before.state!=='running')await call('/retry',{});let job
 for(let n=0;n<30;n++){try{const status=await call('');if(status.state!=='running'){job=await call('/claim',{});if(job)break}}catch(e){console.log('Claim transport retry')}await new Promise(r=>setTimeout(r,10000))}
 assert.ok(job,'No import lease after recovery');const file=join(work,'resume-job.json'),out=join(work,'resume-evidence.json')
 writeFileSync(file,JSON.stringify(job),{mode:0o600})
 const child=spawn('/usr/bin/time',['-l','bun',resolve('scripts/import-public-runner.ts'),origin,file,work,out,'',resolve('.tmp/import-source-cache')],{stdio:['ignore','pipe','pipe']});let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output+=b;writeFileSync(join(work,'resume-log.txt'),output)})
 const timer=setInterval(()=>console.log(output.trim().split('\n').at(-1)),30000)
 const exit=await new Promise(r=>child.on('close',r));clearInterval(timer);assert.equal(exit,0,output.slice(-2200))
 const data=JSON.parse(readFileSync(out,'utf8')),dir=join(gitRoot,'u-avatest','import-mid.git'),index=JSON.parse(git(dir,'show','_meta:.gild/index.json')),files=git(dir,'ls-tree','-r','--name-only','_meta','.gild').split('\n')
 assert.equal(index.issues.length,data.sourceCounts.issues);assert.equal(index.pulls.length,data.sourceCounts.pulls)
 assert.equal(files.filter(p=>/\/(?:issue|pr)\/c-/.test(p)).length,data.sourceCounts.comments)
 assert.equal(files.filter(p=>/\/pr\/r-/.test(p)).length,data.sourceCounts.reviews)
 assert.ok(index.pulls.every(p=>!p.approvals.length&&!p.changesRequested.length));assert.ok(data.maxRequestBytes<=256*1024)
 await call('/cutover',{});assert.equal((await call('')).state,'cutover');assert.equal(JSON.parse(git(dir,'show','_meta:.gild/import/source.json')).readOnly,true)
 data.worker_rss=memory;data.time_output=output.split('\n').filter(line=>/real|user|sys|resident|maximum|page fault|faults|bytes/.test(line)).join('\n');writeFileSync(out,JSON.stringify(data,null,2));
 console.log(JSON.stringify({counts:data.sourceCounts,summary:data.status.summary,elapsed_ms:data.elapsed_ms,max_rss_kib:data.max_rss_kib}))
}finally{clearInterval(memoryTimer);f.worker.kill('SIGTERM');await new Promise(r=>f.server.close(r))}
