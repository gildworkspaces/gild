import {build} from 'esbuild'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import assert from 'node:assert/strict'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
mkdirSync('.tmp',{recursive:true})
await build({entryPoints:['components/repo/RuntimeObservation.tsx','components/repo/Channel.tsx'],outdir:'.tmp/runtime-view',bundle:true,format:'esm',platform:'node',packages:'external',jsx:'automatic',outExtension:{'.js':'.mjs'},plugins:[{name:'router-context',setup(b){
 b.onResolve({filter:/^next\/link$/},()=>({path:'link',namespace:'test-link'}))
 b.onLoad({filter:/.*/,namespace:'test-link'},()=>({contents:'import {createElement} from "react"; export default function Link({children,...props}){return createElement("a",props,children)}',loader:'js',resolveDir:process.cwd()}))
 b.onResolve({filter:/^next\/navigation$/},()=>({path:'navigation',namespace:'test-router'}))
 b.onLoad({filter:/.*/,namespace:'test-router'},()=>({contents:'export const useRouter=()=>({refresh(){}}); export const usePathname=()=>"/acme/demo/agents"; export const useSearchParams=()=>new URLSearchParams();',loader:'js'}))
 b.onLoad({filter:/\.css$/},()=>({contents:'export default {}',loader:'js'}))
}}]})
const {RuntimeObservation}=await import(resolve('.tmp/runtime-view/RuntimeObservation.mjs'))
const {RepoChannel}=await import(resolve('.tmp/runtime-view/Channel.mjs'))
const start='2026-10-12T18:00:00Z'
const session={id:'831a238a-4c0d-4be6-972f-3a68880d478d',started_at:start,ended_at:null,updated_at:start,version:1,closed:false,runtime:{mode:'VM',worker:{id:'5e88ffcb-2a57-4d03-802f-99d4f8d4d380',name:'Demo worker'},host:{os:'linux',version:'6.12.112'},guest:{os:'Ubuntu',version:'24.04.5 LTS'},observed_at:start}}
const html=(s,props={})=>renderToStaticMarkup(createElement(RuntimeObservation,{session:s,...props}))
const live=html(session,{now:Date.parse(start),connected:true})
for(const needle of ['VM','Reported running','Demo worker',session.runtime.worker.id,'linux','Ubuntu','24.04.5 LTS',start])assert.ok(live.includes(needle),needle)
assert.match(html(session,{now:Date.parse(start)+91_000}),/Stale/)
assert.match(html({...session,runtime:{...session.runtime,observed_at:'2027-10-12T18:00:00Z'}},{now:Date.parse(start)+91_000}),/Stale/)
assert.match(html({...session,runtime:{...session.runtime,guest:null}}),/Guest: Not observed/)
assert.match(html(session,{now:Date.parse(start),connected:false}),/Updates disconnected/)
assert.match(html({...session,closed:true,ended_at:start},{now:Date.parse(start)+91_000}),/Stopped/)
const host={...session,runtime:{mode:'HOST',worker:session.runtime.worker,host:{os:'macos',version:'15.7'},observed_at:start}}
assert.match(html(host),/HOST/);assert.ok(!html(host).includes('Guest:'))
const legacy={...session};delete legacy.runtime;assert.match(html(legacy),/Runtime not reported/)
const page=renderToStaticMarkup(createElement(RepoChannel,{owner:'acme',repo:'demo',initial:{viewer:'acme',can_post:false,viewer_resolved:true,page:{messages:[],cursor:'0',before:null,after:null},participants:[{name:'acme/bot',kind:'agent',prefix:'',sponsor:'acme',scopes:[],online:false,state:{status:'busy',last_activity:start},session}]}}))
assert.match(page,/Runtime profile/);assert.match(page,/Agent runtime profile/);assert.match(page,/Ubuntu/);assert.match(page,/Demo worker/)
writeFileSync('.tmp/runtime-view/profile.html',page)
writeFileSync('.tmp/runtime-view/result.json',JSON.stringify({actualRosterRendered:true,vmFields:true,hostOmitsGuest:true,stale:true,disconnected:true,stopped:true,legacyUnknown:true,liveProduction:false},null,2)+'\n')
console.log('Runtime profile actual roster, HOST/VM fields, stopped/stale/disconnected and legacy rendering passed')
