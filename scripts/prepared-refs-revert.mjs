import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
const paths=['lib/api/service.ts','lib/prepared-read-models.ts','lib/prepared-repository-producer.ts']
const sources=Object.fromEntries(paths.map(p=>[p,readFileSync(p,'utf8')]))
mkdirSync('.tmp/prepared-refs-review',{recursive:true})
const mutations=[
  ['legacy-fallback',paths[0],"if(preparedRepositoryOperation(id)){","if(false&&preparedRepositoryOperation(id)){",'registered legacy branch/ref',/500 !== 200/],
  ['pending-fence',paths[1],'if(!row||row.pending||row.meta!==access.meta||!row.data)','if(!row||row.meta!==access.meta||!row.data)','producer ref epoch',/accepted push must hide the previously prepared refs/],
  ['newer-epoch',paths[2],'WHERE id=? AND epoch=?','WHERE id=? AND ? IS NOT NULL','producer ref epoch',/older awaited publication cannot clear newer fence/],
]
try {
  for(const [name,path,before,after,test,effect] of mutations){
    const source=sources[path];assert.equal(source.split(before).length,2,name+' omission applies once')
    writeFileSync(path,source.replace(before,after))
    const r=spawnSync(process.execPath,['--test','--test-name-pattern',test,'lib/prepared-read-models.test.ts'],{encoding:'utf8',timeout:30000})
    const output=(r.stdout??'')+(r.stderr??'');writeFileSync('.tmp/prepared-refs-review/'+name+'.log',output)
    assert.equal(r.status,1,name+' must fail actual effect');assert.match(output,effect)
    assert.doesNotMatch(output,/SyntaxError|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|SQLITE_ERROR/)
    writeFileSync(path,source);console.log('PASS actual registered/nativeSQL omission '+name)
  }
}finally{for(const path of paths)writeFileSync(path,sources[path])}
const r=spawnSync(process.execPath,['--test','lib/prepared-read-models.test.ts'],{encoding:'utf8',timeout:30000})
writeFileSync('.tmp/prepared-refs-review/restored.log',(r.stdout??'')+(r.stderr??''))
assert.equal(r.status,0,r.stdout+r.stderr);console.log('PASS all restored prepared repository effects')
