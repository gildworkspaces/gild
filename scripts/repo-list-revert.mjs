import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
mkdirSync('.tmp',{recursive:true})
const cases=[
  {name:'star-existence',file:'lib/api/service.ts',before:"      ['star', 'unstar', 'stargazers'].includes(id) &&",after:"      false &&",args:['scripts/repo-stars-test.mjs'],expected:'204 !== 404'},
  {name:'landing-cache',file:'lib/public-activity.ts',before:'(s.keep ?? kept)(',after:'((_key, compute) => compute())(',args:['--test','lib/public-activity.test.ts'],expected:'2 !== 1'},
  {name:'license',file:'lib/repo-summary.ts',before:"  const s = text.toLowerCase()",after:"  return null\n  const s = text.toLowerCase()",args:['--test','--test-name-pattern=license MIT','lib/repo-list.test.ts'],expected:'null'},
  {name:'activity',file:'lib/repo-summary.ts',before:'weeks[last - 51 + i] ?? 0',after:'0',args:['--test','--test-name-pattern=52 fixed','lib/repo-list.test.ts'],expected:'0'},
  {name:'star',file:'lib/drivers/d1.ts',before:/    async star\(repo, name\) \{[\s\S]*?\n    \},/,after:'    async star(repo, name) { return },',args:['scripts/repo-stars-test.mjs'],expected:'fresh store'},
  {name:'private',file:'lib/repo-read.ts',before:"  if (acl.visibility !== 'private' && acl.private !== true) return true",after:'  return true',args:['scripts/repo-stars-test.mjs'],expected:'204 !== 404'},
]
for(const c of cases){
  const source=readFileSync(c.file,'utf8')
  assertSource(c.before instanceof RegExp ? c.before.test(source) : source.includes(c.before),c.name)
  try{
    writeFileSync(c.file,source.replace(c.before,c.after))
    const r=spawnSync(process.execPath,c.args,{encoding:'utf8'})
    const log=r.stdout+r.stderr
    writeFileSync('.tmp/repo-list-revert-'+c.name+'.log',log)
    if(r.status===0 || !log.includes(c.expected))throw Error(c.name+' did not fail on its behavior assertion: '+log)
    console.log(c.name+': expected behavior failure, exit '+r.status)
  }finally{writeFileSync(c.file,source)}
}
function assertSource(ok,name){if(!ok)throw Error('mutation no longer applies: '+name)}
