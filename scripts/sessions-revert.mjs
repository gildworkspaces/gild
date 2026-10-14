import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
mkdirSync('.tmp', {recursive:true})
const cases = [
 ['closed','lib/sessions/store.ts','if (old?.closed)','if(false)','closed receipts cannot'],
 ['redaction','lib/sessions/redact.ts','  return {','  return receipt; return {','secrets are redacted'],
 ['agent-cap','lib/sessions/store.ts','][0].n >= 100)','][0].n >= 1000)','one agent cannot exhaust'],
 ['reader','lib/sessions/read-access.ts','if (!viewer || !await mayRead(s, owner, repo, viewer))','if (false)','server receipt reads'],
 ['proof','lib/api/sessions.ts','return { data: await index.sessionPut(receipt, version), status: 201 }','return { data: {...await index.sessionPut(receipt, version), token_fingerprint: c.principal.id}, status: 201 }','agent attribution omits'],
]
for (const [name,path,guard,removed,pattern] of cases) {
 const original=readFileSync(path,'utf8')
 try {
  assert.ok(original.includes(guard),name+': guard exists')
  writeFileSync(path,original.replace(guard,removed))
  const r=spawnSync('node',['--test','--test-name-pattern='+pattern,'lib/sessions.test.ts'],{encoding:'utf8'})
  writeFileSync('.tmp/sessions-revert-'+name+'.log',r.stdout+r.stderr)
  assert.notEqual(r.status,0,name+': must fail'); assert.match(r.stdout,/not ok|✖/)
  console.log('Revert proof: '+name+' independently removed; regression fails; source restored')
 }finally{writeFileSync(path,original)}
}
const r=spawnSync('node',['--test','lib/sessions.test.ts'],{encoding:'utf8'})
writeFileSync('.tmp/sessions-revert-restored.log',r.stdout+r.stderr)
assert.equal(r.status,0,r.stdout+r.stderr)
console.log('Restored session suite passes')
