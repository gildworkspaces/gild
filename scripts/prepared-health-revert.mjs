import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
const paths=['lib/prepared-read-models.ts','lib/prepared-repository-producer.ts','lib/api/service.ts']
const sources=Object.fromEntries(paths.map(p=>[p,readFileSync(p,'utf8')]))
mkdirSync('.tmp/prepared-health-review',{recursive:true})
const mutations=[
 ['version-key',paths[0],'WHERE cache_key=? AND id=? AND sha=?','WHERE ? IS NOT NULL AND id=? AND sha=?','health reads use prepared immutable',/another tool version must not satisfy this version/],
 ['immutable-complete',paths[1],'WHERE prepared_repository_health.complete=0 AND prepared_repository_health.observed_at<=excluded.observed_at','WHERE prepared_repository_health.observed_at<=excluded.observed_at','partial health semantics',/producer outage must not replace complete immutable result/],
 ['request-cache',paths[2],'preparedAccess.get(c.request)??await','await','registered legacy branch/ref',/one document read must not repeat ACL SQL/],
]
try{
 for(const [name,path,before,after,test,effect] of mutations){
  const source=sources[path];assert.equal(source.split(before).length,2,name+' applies once')
  writeFileSync(path,source.replace(before,after))
  const r=spawnSync(process.execPath,['--test','--test-name-pattern',test,'lib/prepared-read-models.test.ts'],{encoding:'utf8',timeout:30000})
  const output=(r.stdout??'')+(r.stderr??'');writeFileSync('.tmp/prepared-health-review/'+name+'.log',output)
  assert.equal(r.status,1,name+' must fail actual effect');assert.match(output,effect)
  assert.doesNotMatch(output,/SyntaxError|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|SQLITE_ERROR/)
  writeFileSync(path,source);console.log('PASS actual registered/nativeSQL omission '+name)
 }
}finally{for(const path of paths)writeFileSync(path,sources[path])}
const r=spawnSync(process.execPath,['--test','lib/prepared-read-models.test.ts'],{encoding:'utf8',timeout:30000})
writeFileSync('.tmp/prepared-health-review/restored.log',(r.stdout??'')+(r.stderr??''))
assert.equal(r.status,0,r.stdout+r.stderr);console.log('PASS all restored health/current authorization effects')
