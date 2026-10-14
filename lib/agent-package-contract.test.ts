import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
import {parseAgentPackageManifest,parseAgentPackageLock,agentPackageSha256,agentPackageInventoryDigest,agentPackageInstallPath,verifyAgentPackageLock,verifyAgentPackageSource} from './api/agent-package-contract.ts'
const descriptor={kind:'agents' as const,repository:'https://gild.gg/sami/agents.git',ref:'latest'}
const consumer=()=>({version:1,name:'consumer',files:[],agents:{ava:{dependency:'@sami/ava',member:'ava'}},dependencies:{'@sami/ava':descriptor}})
async function fixture(){
 const sourceRaw=JSON.stringify({version:1,name:'@sami/team',files:['LICENSE','instructions.md'],agents:{ava:{runtime:'codex',instructions:'instructions.md',requestedPermissions:['repo:read']}},dependencies:{}})
 const files=new Map([['gild.json',new TextEncoder().encode(sourceRaw)],['LICENSE',new TextEncoder().encode('MIT License\n')],['instructions.md',new TextEncoder().encode('Review the owned fixture\n')]])
 const inventory=await Promise.all([...files].sort(([a],[b])=>a<b?-1:1).map(async([path,bytes])=>({path,sha256:await agentPackageSha256(bytes),size:bytes.byteLength})))
 const entry={...descriptor,commit:'a'.repeat(40),manifestSha256:await agentPackageSha256(sourceRaw),bundleDigest:await agentPackageInventoryDigest(inventory),files:inventory}
 const raw=JSON.stringify(consumer()),lock={version:1,manifestSha256:await agentPackageSha256(raw),dependencies:{'@sami/ava':entry}}
 return {sourceRaw,files,entry,raw,lock}
}
test('portable authored package supports multiple inline/reference agents without runtime authority',()=>{
 const p=parseAgentPackageManifest({...consumer(),files:['avatar.png','instructions.md'],agents:{ava:{runtime:'codex',instructions:'instructions.md',assets:['avatar.png'],requestedPermissions:['repo:read','arbitrary.declarative']},bob:{runtime:'claude',model:'example',args:['--version']},imported:{dependency:'@sami/ava',member:'ava'}}})
 assert.equal(Object.keys(p.agents).length,3)
 assert.deepEqual((p.agents.ava as any).requestedPermissions,['repo:read','arbitrary.declarative'])
 assert.equal('grants' in p,false)
 assert.equal(agentPackageInstallPath('agents','@sami/ava'),'agents/@sami/ava')
})
test('strict portable fields, normalized authored paths, references and install collisions reject tampering',()=>{
 for(const data of [{...consumer(),identityId:'forged'},{...consumer(),credentials:{token:'fake'}},{...consumer(),files:['../secret']},{...consumer(),files:['.config/gild/identity.json']},{...consumer(),files:['gild.lock']},{...consumer(),files:['gild.json']},{...consumer(),files:['Readme','readme']},{...consumer(),agents:{ava:{runtime:'codex',instructions:'undeclared.md'}}},{...consumer(),agents:{ava:{runtime:'codex',skills:['@sami/ava']}}},{...consumer(),files:['agents/@sami/ava/local.md']},{...consumer(),dependencies:{'@sami/ava':{...descriptor,repository:'https://user:fake@gild.gg/sami/agents.git'}}},{...consumer(),dependencies:{'@sami/ava':{...descriptor,repository:'https://gild.gg/sami/agents.git?token=fake'}}},{...consumer(),dependencies:{'@sami/ava':{...descriptor,bundlePath:'../escape'}}}])assert.throws(()=>parseAgentPackageManifest(data))
 assert.throws(()=>agentPackageInstallPath('agents','../../identity.json'))
 let touched=false;const accessor=Object.defineProperty({},'agents',{get(){touched=true;return {}}})
 assert.throws(()=>parseAgentPackageManifest(accessor),/accessors/);assert.equal(touched,false)
})
test('root package names reserve existing credentials, runners, VM and identity namespaces',()=>{
 for(const name of ['agents','runners','vm','identity','identity.json','isolation','isolation.json','system','.config','@sami/vm'])assert.throws(()=>parseAgentPackageManifest({...consumer(),name}))
 assert.equal(parseAgentPackageManifest(consumer()).name,'consumer')
 assert.equal(agentPackageInstallPath('agents','@sami/ava'),'agents/@sami/ava')
})
test('consumer raw bytes and every source descriptor bind the immutable lock',async()=>{
 const f=await fixture();assert.equal((await verifyAgentPackageLock(f.raw,f.lock)).lock.dependencies['@sami/ava'].commit,'a'.repeat(40))
 await assert.rejects(()=>verifyAgentPackageLock(f.raw+' ',f.lock),/Consumer manifest digest/)
 for(const patch of [{kind:'skills'},{repository:'https://gild.gg/other/agents.git'},{ref:'main'},{bundlePath:'package'}])await assert.rejects(()=>verifyAgentPackageLock(f.raw,{...f.lock,dependencies:{'@sami/ava':{...f.entry,...patch}}}),/descriptor/)
 await assert.rejects(()=>verifyAgentPackageLock(f.raw,{...f.lock,dependencies:{}}),/inventory/)
 await assert.rejects(()=>verifyAgentPackageLock(f.raw,{...f.lock,dependencies:{'@sami/ava':{...f.entry,bundleDigest:'0'.repeat(64)}}}),/Bundle inventory/)
 assert.throws(()=>parseAgentPackageLock({...f.lock,installPath:'/HOME'}))
})
test('source verifier preserves declared license bytes and rejects missing, extra, corrupt or reordered inventory',async()=>{
 const f=await fixture();const p=await verifyAgentPackageSource(f.entry,f.sourceRaw,f.files);assert.equal((p.agents.ava as any).runtime,'codex')
 assert.equal(new TextDecoder().decode(f.files.get('LICENSE')),'MIT License\n')
 await assert.rejects(()=>verifyAgentPackageSource(f.entry,f.sourceRaw+' ',f.files),/Source manifest digest/)
 const missing=new Map(f.files);missing.delete('LICENSE');await assert.rejects(()=>verifyAgentPackageSource(f.entry,f.sourceRaw,missing),/exactly declared/)
 const extra=new Map(f.files);extra.set('private-home.txt',new Uint8Array());await assert.rejects(()=>verifyAgentPackageSource(f.entry,f.sourceRaw,extra),/exactly declared/)
 const corrupt=new Map(f.files);corrupt.set('LICENSE',new TextEncoder().encode('tamper'));await assert.rejects(()=>verifyAgentPackageSource(f.entry,f.sourceRaw,corrupt),/integrity/)
 await assert.rejects(()=>verifyAgentPackageSource({...f.entry,files:[...f.entry.files].reverse()},f.sourceRaw,f.files),/sorted/)
 await assert.rejects(()=>verifyAgentPackageSource({...f.entry,bundleDigest:'0'.repeat(64)},f.sourceRaw,f.files),/Bundle inventory/)
})
test('single generated artifact parses and verifies the same actual file inventory',async()=>{
 mkdirSync(resolve('.tmp'),{recursive:true})
 const temp=mkdtempSync(resolve('.tmp/agent-contract-test-'))
 try {
 execFileSync(process.execPath,['scripts/generate-api-client.mjs',temp+'/src/api'],{stdio:'pipe'})
 const generated=await import(pathToFileURL(temp+'/src/api/agent-package-contract.ts').href)
 const f=await fixture();assert.deepEqual(generated.parseAgentPackageManifest(f.raw),parseAgentPackageManifest(f.raw))
 assert.deepEqual(await generated.verifyAgentPackageLock(f.raw,f.lock),await verifyAgentPackageLock(f.raw,f.lock))
 assert.deepEqual(await generated.verifyAgentPackageSource(f.entry,f.sourceRaw,f.files),await verifyAgentPackageSource(f.entry,f.sourceRaw,f.files))
 assert.equal(await generated.agentPackageInventoryDigest(f.entry.files),f.entry.bundleDigest)
 } finally {rmSync(temp,{recursive:true,force:true})}
})
