import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
const path='lib/repo-index-do.ts',source=readFileSync(path,'utf8')
const before='await publishPreparedRefs(this.env.DB,identity,refsEpoch,this.refs())'
assert.equal(source.split(before).length,2,'producer omission applies once')
mkdirSync('.tmp/prepared-refs-review',{recursive:true})
try{
  writeFileSync(path,source.replace(before,'void 0'))
  const r=spawnSync(process.execPath,['scripts/api-local.mjs','--prepared-reads'],{encoding:'utf8',timeout:120000})
  const output=(r.stdout??'')+(r.stderr??'');writeFileSync('.tmp/prepared-refs-review/producer-omitted.log',output)
  assert.equal(r.status,1,'missing real producer must fail compiled Worker refs')
  assert.match(output,/ApiRequestError/);assert.match(output,/status: 503/);assert.match(output,/PREPARATION_PENDING/)
  assert.doesNotMatch(output,/SyntaxError|ERR_MODULE_NOT_FOUND|SQLITE_ERROR/)
  console.log('PASS actual compiled Worker GET fails when real producer publication is omitted')
}finally{writeFileSync(path,source)}
const r=spawnSync(process.execPath,['scripts/api-local.mjs','--prepared-reads'],{encoding:'utf8',timeout:120000})
writeFileSync('.tmp/prepared-refs-review/producer-restored.log',(r.stdout??'')+(r.stderr??''))
assert.equal(r.status,0,r.stdout+r.stderr);console.log('PASS restored real producer and all six HTTP routes')
