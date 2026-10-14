import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
const path='lib/prepared-read-models.ts',source=readFileSync(path,'utf8')
mkdirSync('.tmp/prepared-read-review',{recursive:true})
const mutations=[
 ['allowlist',"AND (? IS NULL OR lower(c.owner||'/'||c.name) IN (SELECT lower(value) FROM json_each(?)))","AND (? IS NULL OR ? IS NOT NULL)",'registered prepared cards',/scoped collection must never return B/],
 ['catalogue',"if(!catalogue)throw new PreparationPending()","if(false)throw new PreparationPending()",'known unprepared catalogue503',/200 !== 503/],
 ['provenance',"const currentFacts=!!snapshot.tip&&factsTip===snapshot.tip&&!!snapshot.facts","const currentFacts=!!snapshot.tip&&!!snapshot.facts",'old summary provenance',/false !== true/],
 ['pending-fence',"if(row.moving||!row.data||!row.access_acl||row.access_pending)","if(row.moving||!row.data||!row.access_acl)",'current ACL fences',/authorized owner must get Pending while fenced/],
]
try {
 for(const [name,before,after,test,effect] of mutations){
  assert.equal(source.split(before).length,2,name+' mutation applies once')
  writeFileSync(path,source.replace(before,after))
  const r=spawnSync(process.execPath,['--test','--test-name-pattern',test,'lib/prepared-read-models.test.ts'],{encoding:'utf8',timeout:30000})
  const output=(r.stdout??'')+(r.stderr??'');writeFileSync('.tmp/prepared-read-review/omission-'+name+'.log',output)
  assert.equal(r.status,1,name+' actual effect must fail');assert.match(output,effect);assert.doesNotMatch(output,/SyntaxError|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|SQLITE_ERROR/)
  console.log('PASS real registered/nativeSQL omission '+name)
 }
}finally{writeFileSync(path,source)}
const restored=spawnSync(process.execPath,['--test','lib/prepared-read-models.test.ts'],{encoding:'utf8',timeout:30000})
writeFileSync('.tmp/prepared-read-review/restored.log',(restored.stdout??'')+(restored.stderr??''));assert.equal(restored.status,0,restored.stdout+restored.stderr)
console.log('PASS all restored prepared reader effects')
