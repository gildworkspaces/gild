// Generate a local Next shell using production components and the workerd
// search endpoint. No test routes or fixture credentials enter the product.
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
const root = resolve('.tmp/ui')
function write(name, text) { const file=resolve(root,name); mkdirSync(dirname(file),{recursive:true}); writeFileSync(file,text) }
write('package.json', JSON.stringify({name:'gild-search-fixture',private:true}))
write('tsconfig.json',JSON.stringify({extends:'../../tsconfig.json',compilerOptions:{paths:{'@/*':['../../*']}},include:['**/*.ts','**/*.tsx','.next/types/**/*.ts'],exclude:['node_modules']}))
write('next.config.mjs',`export default { turbopack: { root: ${JSON.stringify(resolve('.'))} } }`)
write('app/layout.tsx',`import RootLayout from '@/app/layout'; import { SiteHeader } from '@/components/SiteHeader'; export default function Layout({children}) { return <RootLayout><SiteHeader name={null} avatar=""/><main style={{padding:'0 24px'}}>{children}</main></RootLayout> }`)
write('app/acme/demo/page.tsx',`import { SearchHits } from '@/components/SearchHits'; export default async function Page({searchParams}) {const sp=await searchParams; const file=sp.path; return <div style={{maxWidth:1100,margin:'28px auto'}}><p style={{color:'var(--accent)'}}>acme / <b>demo</b></p><h1>Repository index</h1><p>Browse every branch and tag from one content-addressed SQLite index.</p><nav style={{display:'flex',gap:24,padding:'16px 0',borderBottom:'1px solid var(--rule)'}}>Code <span>Issues</span><span>Pull requests</span><span>Search</span></nav><div style={{marginTop:24,padding:24,border:'1px solid var(--rule)',borderRadius:8,background:'var(--panel)'}}><h3>{file || 'README.md'}</h3>{file ? ['// Repository index','export function SparseIndex() {','  return "hello world"','}'].map((line,i)=><div id={'L'+(i+1)} key={i} style={{fontFamily:'var(--font-mono)',padding:4}}><a href={'#L'+(i+1)} style={{color:'var(--ink-dim)',marginRight:20}}>{i+1}</a>{line}</div>) : <p>Search content, paths and definitions. Press / to search or t to go to a file.</p>}</div></div> }`)
const api = `export async function GET(request) { const u=new URL(request.url); return fetch('http://127.0.0.1:8799/search'+u.search) }`
write('app/api/search/route.ts',api); write('app/api/repos/acme/demo/search/route.ts',api)
const results = `import { SearchResults } from '@/components/SearchResults'; export default async function Page({searchParams}) {const {q=''}=await searchParams; const data=await (await fetch('http://127.0.0.1:8799/search?q='+encodeURIComponent(q))).json(); return <SearchResults q={q} scope={{owner:'acme',repo:'demo'}} data={data}/>}`
write('app/search/page.tsx',results); write('app/acme/demo/search/page.tsx',results)
console.log('UI harness generated at '+root)
