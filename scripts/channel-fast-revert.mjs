import {readFileSync,writeFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
const run=(name,args)=>{
  const r=spawnSync('bun',args,{encoding:'utf8',maxBuffer:32*1024*1024,timeout:300000})
  writeFileSync('.tmp/channel-fast-revert-'+name+'.log',(r.stdout ?? '')+(r.stderr ?? ''))
  return r
}
const file='app/(portal)/[owner]/[repo]/agents/page.tsx',original=readFileSync(file,'utf8')
try {
  assert.ok(original.includes(' initial={initial}'))
  writeFileSync(file,original.replace(' initial={initial}','').replace('props={{owner,repo,initial}}','props={{owner,repo}}'))
  const build=run('build',['run','build:cloudflare']);assert.equal(build.status,0,build.stderr)
  const result=run('browser',['run','test:channel:fast'])
  assert.notEqual(result.status,0)
  assert.match(result.stderr,/AssertionError/)
  assert.match(result.stderr,/messages render before WebSocket connects|participants render with messages/)
  assert.doesNotMatch(result.stderr,/Build failed|SyntaxError|Cannot find module/)
  console.log('PASS reverted initial server props: the real browser first-render assertion fails')
} finally {
  writeFileSync(file,original)
  const build=run('restored-build',['run','build:cloudflare']);assert.equal(build.status,0,build.stderr)
}
const restored=run('restored-browser',['run','test:channel:fast']);assert.equal(restored.status,0,restored.stderr)
console.log('PASS restored browser first-render/latency/privacy assertions')
