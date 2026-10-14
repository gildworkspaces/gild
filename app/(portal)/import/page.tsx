'use client'
import { useEffect,useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
export default function ImportPage() {
  const router=useRouter(),[url,setUrl]=useState(''),[name,setName]=useState(''),[owner,setOwner]=useState(''),[owners,setOwners]=useState<string[]>([]),[token,setToken]=useState(''),[privateChoice,setPrivate]=useState<boolean|null>(null),privateRepo=privateChoice??token!=='',[mirror,setMirror]=useState(false),[forge,setForge]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('')
  useEffect(()=>{fetch('/api/orgs').then(r=>r.ok?r.json():null).then(data=>{if(data){setOwner(data.me);setOwners([data.me,...data.orgs.filter((o:{role:string})=>['owner','admin'].includes(o.role)).map((o:{name:string})=>o.name)])}}).catch(()=>setError('Could not load repository owners'))},[])
  const field={padding:'9px 11px',border:'1px solid var(--rule)',borderRadius:7,background:'var(--bg)',color:'var(--ink)',fontFamily:'inherit'}
  async function submit(e:React.FormEvent) {
    e.preventDefault();setBusy(true);setError('')
    try {
      const r=await fetch('/api/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url,name:name||undefined,owner,private:privateRepo,mirror,source_token:token||undefined,forge:forge||undefined})}),data=await r.json()
      setToken('');if(!r.ok)throw Error(data.error??data.message??'Could not start import')
      router.push('/'+data.repository+'/import')
    }catch(e){setError((e as Error).message)}finally{setBusy(false)}
  }
  return <><h1>Import repository</h1><p>Bring all branches, tags, full history, and GitHub or GitLab issues and pull requests to gild.</p>
    <p>Web imports run on an eligible <Link href="/settings/runners">owner runner</Link>. You can also import locally with <code>gild repo import &lt;url&gt;</code>.</p>
    {!owner && <Link href="/auth/device?next=/import">Sign in to import a repository</Link>}
    <form onSubmit={submit} style={{display:'grid',gap:12,maxWidth:480}}>
      <label>Source URL<input required type="text" value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://github.com/owner/repository.git" style={{...field,display:'block',width:'100%'}} /></label>
      <label>Owner<select value={owner} onChange={e=>setOwner(e.target.value)} style={{...field,display:'block',width:'100%'}}>{owners.map(o=><option key={o} value={o}>@{o}</option>)}</select></label>
      <label>Repository name (optional)<input value={name} onChange={e=>setName(e.target.value)} autoComplete="off" style={{...field,display:'block',width:'100%'}} /></label>
      <label>Source access token (optional)<input type="password" value={token} onChange={e=>setToken(e.target.value)} autoComplete="off" style={{...field,display:'block',width:'100%'}} /><small>Used during import, then discarded. Mirror mode retains it encrypted until cutover.</small></label>
      <label>Metadata<select value={forge} onChange={e=>setForge(e.target.value)} style={{...field,display:'block',width:'100%'}}><option value="">Detect GitHub or GitLab</option><option value="github">GitHub</option><option value="gitlab">GitLab (including self-hosted)</option><option value="git">Git only</option></select></label>
      <label><input type="checkbox" checked={privateRepo} onChange={e=>setPrivate(e.target.checked)} /> Private destination</label>
      <label><input type="checkbox" checked={mirror} onChange={e=>setMirror(e.target.checked)} /> Mirror source hourly until cutover</label>
      {error && <p role="alert">{error}</p>}
      <button disabled={busy||!owner||!url} type="submit" style={{...field,background:'var(--accent)',color:'var(--accent-ink)'}}>{busy?'Starting import…':'Import repository'}</button>
    </form></>
}
