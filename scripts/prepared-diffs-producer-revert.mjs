import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
const path='lib/prepared-repository-producer.ts',source=readFileSync(path,'utf8')
const before="  const data={from:change.from,to:change.to,files:change.files,truncated:change.truncated,total:change.total,sizes:change.sizes}"
assert.equal(source.split(before).length,2,'actual diff publication omission applies once')
mkdirSync('.tmp/prepared-diffs-review',{recursive:true})
try{
 writeFileSync(path,source.replace(before,'  return\n'+before))
 const r=spawnSync(process.execPath,['scripts/api-local.mjs','--prepared-reads'],{encoding:'utf8',timeout:120000})
 const output=(r.stdout??'')+(r.stderr??'');writeFileSync('.tmp/prepared-diffs-review/producer-omitted.log',output)
 assert.equal(r.status,1,'missing actual producer must fail actual diff HTTP read')
 assert.match(output,/ApiRequestError/);assert.match(output,/status: 503/);assert.match(output,/PREPARATION_PENDING/)
 assert.doesNotMatch(output,/SyntaxError|ERR_MODULE_NOT_FOUND|SQLITE_ERROR/)
 console.log('PASS actual compiled Worker diff GET fails when actual producer publication is omitted')
}finally{writeFileSync(path,source)}
const r=spawnSync(process.execPath,['scripts/api-local.mjs','--prepared-reads'],{encoding:'utf8',timeout:120000})
writeFileSync('.tmp/prepared-diffs-review/producer-restored.log',(r.stdout??'')+(r.stderr??''))
assert.equal(r.status,0,r.stdout+r.stderr);console.log('PASS restored actual producer and all ten HTTP operations')
