import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
const path='lib/repo-index-do.ts',source=readFileSync(path,'utf8')
const before='await publishPreparedHealth(this.env.DB,state.id,key,sha,report)'
assert.equal(source.split(before).length,3,'fresh and cached producer publications both exist')
mkdirSync('.tmp/prepared-health-review',{recursive:true})
try{
 writeFileSync(path,source.replaceAll(before,'void 0'))
 const r=spawnSync(process.execPath,['scripts/api-local.mjs','--prepared-reads'],{encoding:'utf8',timeout:120000})
 const output=(r.stdout??'')+(r.stderr??'');writeFileSync('.tmp/prepared-health-review/producer-omitted.log',output)
 assert.equal(r.status,1,'missing real health producer must fail actual HTTP read')
 assert.match(output,/ApiRequestError/);assert.match(output,/status: 503/);assert.match(output,/PREPARATION_PENDING/)
 assert.doesNotMatch(output,/SyntaxError|ERR_MODULE_NOT_FOUND|SQLITE_ERROR/)
 console.log('PASS actual compiled Worker health GET fails when actual report producer is omitted')
}finally{writeFileSync(path,source)}
const r=spawnSync(process.execPath,['scripts/api-local.mjs','--prepared-reads'],{encoding:'utf8',timeout:120000})
writeFileSync('.tmp/prepared-health-review/producer-restored.log',(r.stdout??'')+(r.stderr??''))
assert.equal(r.status,0,r.stdout+r.stderr);console.log('PASS restored actual producer and all eight HTTP operations')
