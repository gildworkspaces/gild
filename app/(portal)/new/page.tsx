'use client'

import Link from 'next/link'
import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

interface OrgOption {
  name: string
  role: 'owner' | 'admin' | 'member'
}

function NewRepoForm() {
  const [privateRepo,setPrivateRepo]=useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [owner, setOwner] = useState<string>('')
  const [me, setMe] = useState<string | null>(null)
  const [orgs, setOrgs] = useState<OrgOption[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const router = useRouter()
  const params = useSearchParams()

  useEffect(() => {
    fetch('/api/orgs').then((r) => (r.ok ? r.json() : null)).then((data) => {
      if (!data) return
      setMe(data.me)
      // Only roles that may create repos appear in the picker.
      const creatable = (data.orgs as OrgOption[]).filter((o) => o.role === 'owner' || o.role === 'admin')
      setOrgs(creatable)
      const wanted = params.get('owner')
      setOwner(wanted && (wanted === data.me || creatable.some((o) => o.name === wanted)) ? wanted : data.me)
    })
  }, [params])

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await fetch('/api/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, description, owner,private:privateRepo }),
    })
    const data = await res.json()
    setBusy(false)
    if (!res.ok) { setError(data.error ?? 'something went wrong'); return }
    router.push(`/${data.owner}/${data.name}`)
  }

  const inputStyle = {
    padding: '9px 11px', border: '1px solid var(--rule)', borderRadius: 7,
    background: 'var(--bg)', color: 'var(--ink)', fontFamily: 'inherit',
  } as const

  return (
    <form onSubmit={create} style={{ display: 'grid', gap: 12, maxWidth: 420, marginTop: 20 }}>
      <label style={{ display: 'grid', gap: 4, fontSize: 13, color: 'var(--ink-soft)' }}>
        owner
        <select value={owner} onChange={(e) => setOwner(e.target.value)} style={inputStyle}>
          {me && <option value={me}>@{me} (you)</option>}
          {orgs.map((o) => <option key={o.name} value={o.name}>@{o.name} (org)</option>)}
        </select>
      </label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="repo name"
        autoComplete="off"
        style={inputStyle}
      />
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="description (optional)"
        style={inputStyle}
      />
      <label><input type="checkbox" checked={privateRepo} onChange={e=>setPrivateRepo(e.target.checked)} /> Private repository · free</label>
      {error && <p style={{ color: '#c0392b', fontSize: 13, margin: 0 }}>{error}</p>}
      <button
        type="submit"
        disabled={busy || !name.trim() || !owner}
        style={{
          padding: '10px', borderRadius: 7, border: 'none', fontFamily: 'inherit',
          background: 'var(--accent)', color: 'var(--accent-ink)', fontWeight: 600,
          opacity: busy || !name.trim() || !owner ? 0.5 : 1, cursor: 'pointer',
        }}
      >
        create repository
      </button>
    </form>
  )
}

export default function NewRepoPage() {
  return (
    <>
      <h1 style={{ fontSize: 22, margin: '0 0 8px' }}>new repo</h1>
      <p style={{ color: 'var(--ink-soft)', fontSize: 14, maxWidth: '60ch' }}>
        A real git repository on Artifacts — durable, replicated, clonable by any
        git client. The `_meta` branch (issues, PRs, CI) is initialized with it.
      </p>
      <p><Link href="/import">Import an existing repository</Link></p>
      <Suspense>
        <NewRepoForm />
      </Suspense>
    </>
  )
}
