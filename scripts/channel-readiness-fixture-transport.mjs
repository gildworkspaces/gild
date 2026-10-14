// Bounded transport contract proof; compiled product/background effects are
// exercised separately by api-local --channel after the namespace server hook.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdirSync,mkdtempSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {build} from 'esbuild'

const root=resolve('.tmp');mkdirSync(root,{recursive:true})
const work=mkdtempSync(join(root,'channel-transport-'))
const observed=[],inventories=new Map([
  ['fixture-acme',[{id:'fixture',name:'demo',description:'Observed demo',default_branch:'main',created_at:'1970-01-01T00:00:00.000Z',updated_at:'1970-01-01T00:00:00.000Z',last_push_at:null}]],
  ['fixture-org',[{id:'created',name:'created',description:'Observed created',default_branch:'trunk',created_at:'2026-01-01T00:00:00.000Z',updated_at:'2026-01-01T00:00:00.000Z',last_push_at:null}]],
])
const server=createServer((request,response)=>{
  const url=new URL(request.url,'http://fixture'),namespace=url.searchParams.get('namespace')
  observed.push({path:url.pathname,namespace,method:request.method,hasAuthorization:!!request.headers.authorization})
  if(url.pathname!=='/repositories'){response.writeHead(404).end();return}
  if(namespace==='fixture-error'){response.writeHead(503).end();return}
  response.setHeader('content-type','application/json')
  if(namespace==='fixture-invalid'){response.end(JSON.stringify({items:inventories.get('fixture-acme')}));return}
  if(!inventories.has(namespace)){response.writeHead(404).end();return}
  response.end(JSON.stringify(inventories.get(namespace)))
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
try{
  const outfile=join(work,'runtime.mjs')
  await build({entryPoints:['scripts/api-fixture/runtime.ts'],outfile,bundle:true,format:'esm',platform:'node',packages:'external',external:['cloudflare:workers']})
  const runtime=await import(outfile)
  runtime.configure({FIXTURE_REMOTE:`http://127.0.0.1:${server.address().port}/repo.git`})
  assert.deepEqual(await runtime.rawListRepos(runtime.nsFor('acme'),'local-fixture-credential'),inventories.get('fixture-acme'))
  assert.deepEqual(await runtime.rawListRepos(runtime.nsFor('org'),'local-fixture-credential'),inventories.get('fixture-org'))
  assert.deepEqual(await runtime.rawListRepos('fixture-empty'),[])
  await assert.rejects(runtime.rawListRepos('fixture-error'),error=>error.status===503)
  await assert.rejects(runtime.rawListRepos('fixture-invalid'),/Invalid fixture repository inventory/)
  assert.equal(observed.length,5)
  assert.ok(observed.every(request=>request.method==='GET'&&request.path==='/repositories'&&!request.hasAuthorization))
  console.log('PASS fixture catalogue transport: observed namespace inventories, genuine404 empty, upstream503/malformed fail closed, no credential forwarding')
}finally{
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
}
