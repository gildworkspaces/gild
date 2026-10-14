'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { navigatePublicPage } from '@/components/refresh-public'

export default function NewOrgPage() {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await fetch('/api/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, description }),
    })
    const data = await res.json()
    setBusy(false)
    if (!res.ok) { setError(data.error ?? 'something went wrong'); return }
    navigatePublicPage(router,`/${data.name}`)
  }

  const inputStyle = {
    padding: '9px 11px', border: '1px solid var(--rule)', borderRadius: 7,
    background: 'var(--bg)', color: 'var(--ink)', fontFamily: 'inherit',
  } as const

  return (
    <>
      <h1 style={{ fontSize: 22, margin: '0 0 8px' }}>new org</h1>
      <p style={{ color: 'var(--ink-soft)', fontSize: 14, maxWidth: '60ch' }}>
        An org groups related repos under one name — gild.gg/&lt;org&gt;/&lt;repo&gt; —
        and scopes who can manage and push to them. Org names share the global
        namespace with usernames.
      </p>
      <form onSubmit={create} style={{ display: 'grid', gap: 12, maxWidth: 420, marginTop: 20 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="org name"
          autoComplete="off"
          style={inputStyle}
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="description (optional)"
          style={inputStyle}
        />
        {error && <p style={{ color: '#c0392b', fontSize: 13, margin: 0 }}>{error}</p>}
        <button
          type="submit"
          disabled={busy || !name.trim()}
          style={{
            padding: '10px', borderRadius: 7, border: 'none', fontFamily: 'inherit',
            background: 'var(--accent)', color: 'var(--accent-ink)', fontWeight: 600,
            opacity: busy || !name.trim() ? 0.5 : 1, cursor: 'pointer',
          }}
        >
          create org
        </button>
      </form>
    </>
  )
}
