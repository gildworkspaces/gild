import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
mkdirSync('.tmp',{recursive:true})
const cases = [
 ['hmac','lib/events/security.ts',"hash: 'SHA-256'","hash: 'SHA-1'",'GitHub HMAC fixture','lib/events.test.ts'],
 ['stream-read','lib/events/repositories.ts','&& await read(owner, repo, c.principal.name)','','shared read policy','lib/events-runtime.test.ts'],
 ['creator-access','lib/events/hub-do.ts','if (!await this.creatorAccess(hook, source.repository))','if (false)','creator access revocation','lib/events-runtime.test.ts'],
 ['timestamp','lib/events/hub-do.ts',"timestamp + '.' + body",'body','delivery signs timestamp','lib/events-runtime.test.ts'],
 ['sweep','lib/events/hub-do.ts',"AND queued_at<? AND lease<=?", "AND queued_at<0 AND lease<=?",'alarm sweeps stuck','lib/events-runtime.test.ts'],
 ['dead-letter','lib/events/hub-do.ts',"SET state='failed',lease=0,result=?", "SET state='pending',lease=0,result=?",'alarm sweeps stuck','lib/events-runtime.test.ts'],
 ['defer','lib/events/consumer.ts',"if ('defer' in result && result.defer)",'if (false)','queue consumer delays','lib/events-runtime.test.ts'],
 ['ssrf','lib/events/security.ts','addresses.some((ip) => !publicAddress(ip))','false','deliverHTTP blocks SSRF','lib/events-runtime.test.ts'],
 ['timeout','lib/events/transport.ts',"io.timeoutMs ?? 10000",'10000','deliverHTTP total timeout','lib/events-runtime.test.ts'],
 ['redirect','lib/events/hub-do.ts','result.status < 300','result.status < 400','delivery signs timestamp','lib/events-runtime.test.ts'],
]
for(const [name,path,guard,removed,pattern,test] of cases){
 const original=readFileSync(path,'utf8')
 try{
  assert.ok(original.includes(guard), name+': guard exists')
  writeFileSync(path,original.replace(guard,removed))
  const r=spawnSync('node',['--test','--test-name-pattern='+pattern,test],{encoding:'utf8',timeout:30000})
  writeFileSync('.tmp/events-revert-'+name+'.log',r.stdout+r.stderr)
  assert.notEqual(r.status,0,name+': guard removal must fail');assert.match(r.stdout,/not ok|✖/)
  console.log('Revert proof: '+name+' independently removed; regression fails; source restored')
 }finally{writeFileSync(path,original)}
}
const r=spawnSync('node',['--test','lib/events.test.ts','lib/events-runtime.test.ts'],{encoding:'utf8'})
writeFileSync('.tmp/events-revert-restored.log',r.stdout+r.stderr)
assert.equal(r.status,0,r.stdout+r.stderr)
console.log('Restored event suites pass')
