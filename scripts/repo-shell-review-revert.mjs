// Review regressions against actual served production renderer/browser bytes.
import { readFileSync, writeFileSync, cpSync, mkdirSync } from 'node:fs'
import { spawnSync, execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
mkdirSync('.tmp', {recursive:true})
const records=[]
function run(name, args) {
  const result=spawnSync(args[0], args.slice(1), {encoding:'utf8', timeout:600000, maxBuffer:16*1024*1024})
  writeFileSync(`.tmp/review-revert-${name}.log`,result.stdout+result.stderr)
  return result
}
function render(name) {
  const result=run(name,['bun','run','build:render'])
  assert.equal(result.status,0,result.stdout+result.stderr)
  cpSync('public/gild-fragments','.open-next/assets/gild-fragments',{recursive:true})
}
const fixturePath='scripts/api-fixture/runtime.ts', fixtureOriginal=readFileSync(fixturePath,'utf8')
try {
  writeFileSync(fixturePath,fixtureOriginal.replace('  remote = url ?? env.FIXTURE_REMOTE','  if (url) remote = url'))
  const result=run('fixture-remote',[process.execPath,'--test','lib/api-fixture-runtime.test.ts'])
  assert.notEqual(result.status,0,'fresh-isolate metadata remote must fail with in-memory-only configuration')
  assert.match(result.stdout+result.stderr,/AssertionError/)
  records.push({name:'fixture-remote',assertion:'fresh isolate gets the disposable Git remote',status:result.status})
  console.log('PASS review revert fixture-remote: fresh-isolate remote assertion fails')
} finally {writeFileSync(fixturePath,fixtureOriginal)}
const httpPath='lib/fragments/http.ts', httpOriginal=readFileSync(httpPath,'utf8')
try {
  writeFileSync(httpPath,httpOriginal.replace('  return session?.name ? new HTMLRewriter()', '  return false ? new HTMLRewriter()'))
  const result=run('viewer-cache',[process.execPath,'scripts/fragments-local.mjs','--viewer-cache-only'])
  assert.notEqual(result.status,0,'cached neutral HTML must be personalized for the current viewer')
  assert.match(result.stdout+result.stderr,/warm neutral page applies signed-in geometry/)
  records.push({name:'viewer-cache',assertion:'warm neutral page applies signed-in geometry',status:result.status})
  console.log('PASS review revert viewer-cache: cached owner geometry assertion fails')
} finally {writeFileSync(httpPath,httpOriginal)}
const cases=[
  ['cold-portal','packages/presentation/Headers.tsx', s=>s.replace('    <PortalBarView search={search} />','    {search}'),['--quick','--headers-only'],/cold Code has .portal-bar/],
  ['star-reservation','app/(portal)/[owner]/[repo]/repo.module.css',()=>execFileSync('git',['show','b6e0c0a:app/(portal)/[owner]/[repo]/repo.module.css'],{encoding:'utf8'}),['--quick','--headers-only'],/five digit star count fits/],
  ['long-identity','app/globals.css',s=>s.replace('min-width: 84px; width: 240px; max-width:100%;','width: 84px;')+'\n.site-nav [data-identity]:has(.site-identity) { width:auto; }\n',['--values-only','--headers-only'],/long handle preserves identity well/],
  ['mobile-corner','app/globals.css',s=>s+'\n@media(max-width:760px){.portal-bar{display:none}}\n',['--quick','--headers-only'],/cold Code has .portal-bar at 400px/],
]
for(const [name,path,revert,args,pattern] of cases) {
  const original=readFileSync(path,'utf8')
  try {
    const changed=revert(original)
    assert.notEqual(changed,original)
    writeFileSync(path,changed)
    render('build-'+name)
    const result=run(name,[process.execPath,'scripts/repo-shell-browser.mjs',...args])
    assert.notEqual(result.status,0,`${name}: reverted behavior must fail`)
    assert.match(result.stdout+result.stderr,/AssertionError/)
    assert.match(result.stdout+result.stderr,pattern)
    records.push({name,assertion:pattern.source,status:result.status})
    console.log(`PASS review revert ${name}: effect assertion fails`)
  } finally {writeFileSync(path,original);render('restore-'+name)}
}
writeFileSync('.tmp/review-reverts.json',JSON.stringify(records,null,2))
const result=run('restored',[process.execPath,'scripts/repo-shell-browser.mjs','--quick','--headers-only'])
assert.equal(result.status,0,result.stdout+result.stderr)
console.log('PASS restored review regression suite')
