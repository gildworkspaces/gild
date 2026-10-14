import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync,rmSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'
// Own volatile-index port and local Git transport; policy is proven separately
// through the full compiled private Worker/browser fixture.
test('fixed manifest writer reuses the validated root and preserves unrelated Git files',async()=>{
 mkdirSync('.tmp',{recursive:true});const work=mkdtempSync(resolve('.tmp/package-root-effect-')),dir=join(work,'repo');mkdirSync(dir)
 const git=(...args:string[])=>execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:'pipe'}).trim()
 try{
  git('init','-b','main');const original={version:1,name:'root-effect',files:['README.md'],agents:{ava:{runtime:'codex',model:'before'}},dependencies:{}}
  writeFileSync(join(dir,'gild.json'),JSON.stringify(original));writeFileSync(join(dir,'README.md'),'Unrelated authored bytes\n');writeFileSync(join(dir,'tool.sh'),'#!/bin/sh\nexit 0\n');chmodSync(join(dir,'tool.sh'),0o755)
  git('add','.');git('-c','commit.gpgsign=false','commit','-m','Owned root preservation fixture')
  const before=git('rev-parse','HEAD'),tree=git('rev-parse','HEAD^{tree}'),entries=git('ls-tree','HEAD').split('\n').map(line=>{const m=/^(\d+) (\w+) ([a-f0-9]+)\t(.+)$/.exec(line)!;return {mode:m[1],type:m[2],child:m[3],name:m[4]}})
  let reads=0
  ;(globalThis as any).__packageRootIndex={commit:async()=>({tree}),tree:async()=>++reads===1?entries:null}
  ;(globalThis as any).__packageRootPush=async(request:Request)=>new Response(execFileSync('git',['-c','receive.denyCurrentBranch=ignore','receive-pack','--stateless-rpc',dir],{input:Buffer.from(await request.arrayBuffer()),stdio:['pipe','pipe','pipe']}),{status:200})
  const target=join(work,'writer.mjs'),omit=process.argv.includes('--omit-root-reuse')
  await build({entryPoints:['lib/agent-package-write.ts'],outfile:target,bundle:true,format:'esm',platform:'node',packages:'external',plugins:[{name:'owned-index-and-git-transport',setup(b){
   b.onResolve({filter:/^\.\/(repo-index|gitproxy)$/},a=>a.importer.endsWith('agent-package-write.ts')?{path:a.path,namespace:'owned-port'}:null)
   b.onLoad({filter:/.*/,namespace:'owned-port'},a=>({contents:a.path==='./repo-index'?'export const readyIndex=async()=>globalThis.__packageRootIndex':'export const pushPackageManifest=(request)=>globalThis.__packageRootPush(request)',loader:'js'}))
   if(omit)b.onLoad({filter:/agent-package-write\.ts$/},a=>{const source=readFileSync(a.path,'utf8'),start=source.indexOf(' const changed=await editTree('),end=source.indexOf('\n const commit=',start);assert.ok(start>0&&end>start);return {contents:source.slice(0,start)+" const changed=await editTree(async sha=>(await index.tree(sha)??[]).map(e=>({name:e.name,type:e.type,mode:e.mode,sha:e.child})),base.tree,[{path:'gild.json',content:text}])"+source.slice(end),loader:'ts'}})
  }}]})
  const {writePackageManifest}=await import(pathToFileURL(target).href)
  const text=JSON.stringify({...original,agents:{ava:{runtime:'codex',model:'after'}}})
  const result=await writePackageManifest({route:{id:'updateAgentPackage'},params:{owner:'owner',repo:'repo'},principal:{id:'fake-owner',name:'owner',publicKey:'fixture',scopes:null,repos:null},body:{branch:'main',expected_head:before,text},request:new Request('http://127.0.0.1/api/v1/repos/owner/repo/agent-package')})
  assert.equal(git('rev-parse','refs/heads/main'),result.data.commit)
  assert.deepEqual(git('diff','--name-only',before,result.data.commit).split('\n'),['gild.json'],'A missing second read must never remove unrelated files')
  assert.equal(git('show','HEAD:README.md'),'Unrelated authored bytes')
  assert.match(git('ls-tree','HEAD','tool.sh'),/^100755 /)
  assert.equal(reads,1,'The already validated immutable root is reused')
 }finally{delete (globalThis as any).__packageRootIndex;delete (globalThis as any).__packageRootPush;rmSync(work,{recursive:true,force:true})}
})
