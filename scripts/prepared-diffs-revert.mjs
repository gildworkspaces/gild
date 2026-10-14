import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
const path='lib/prepared-read-models.ts',source=readFileSync(path,'utf8')
mkdirSync('.tmp/prepared-diffs-review',{recursive:true})
const mutations=[
 ['version-key','WHERE id=? AND version=? AND kind=? AND target=?','WHERE id=? AND ? IS NOT NULL AND kind=? AND target=?','commit diff GET',/wrong diff tool version cannot satisfy preparation/],
 ['base-tip','row.base!==base','false','pull diff GET',/changed base cannot reuse old merge-base diff/],
 ['head-tip','row.head!==head','false','pull diff GET',/changed head cannot reuse old pull diff/],
 ['current-meta','row.meta!==access.meta||row.head!==head','false||row.head!==head','pull diff GET',/current metadata must match prepared pull/],
]
try{
 for(const [name,before,after,test,effect] of mutations){
  assert.equal(source.split(before).length,2,name+' applies once');writeFileSync(path,source.replace(before,after))
  const r=spawnSync(process.execPath,['--test','--test-name-pattern',test,'lib/prepared-read-models.test.ts'],{encoding:'utf8',timeout:30000})
  const output=(r.stdout??'')+(r.stderr??'');writeFileSync('.tmp/prepared-diffs-review/'+name+'.log',output)
  assert.equal(r.status,1,name+' must fail actual effect');assert.match(output,effect)
  assert.doesNotMatch(output,/SyntaxError|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|SQLITE_ERROR/)
  writeFileSync(path,source);console.log('PASS actual registered/nativeSQL omission '+name)
 }
}finally{writeFileSync(path,source)}
const r=spawnSync(process.execPath,['--test','lib/prepared-read-models.test.ts'],{encoding:'utf8',timeout:30000})
writeFileSync('.tmp/prepared-diffs-review/restored.log',(r.stdout??'')+(r.stderr??''))
assert.equal(r.status,0,r.stdout+r.stderr);console.log('PASS all restored prepared diff effects')
