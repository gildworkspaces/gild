'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { pollBrowserChallenge } from '@/lib/browser-challenge-poll'
import { CopyBlock } from '@/components/CopyBlock'

type Stage =
  | { kind: 'form' }
  | { kind: 'expired' }
  | { kind: 'signing'; challenge: string }
  | { kind: 'done'; name: string }

const inputStyle = {
  padding: '8px 10px', border: '1px solid var(--rule)', borderRadius: 6,
  background: 'var(--bg)', color: 'var(--ink)', fontFamily: 'inherit',
} as const

function ClaimForm() {
  const params = useSearchParams()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [publicKey, setPublicKey] = useState(() => params.get('key') ?? '')
  const [stage, setStage] = useState<Stage>({ kind: 'form' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const poll = useRef<(() => void) | null>(null)

  useEffect(() => () => { poll.current?.() }, [])

  const begin = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/claim/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, email, publicKey }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Could not start the claim. Please try again.'); return }
      const challenge = data.challenge as string
      setStage({ kind: 'signing', challenge })
      poll.current?.()
      poll.current = pollBrowserChallenge(`/api/claim/status?challenge=${encodeURIComponent(challenge)}`, d => {
        setStage({ kind: 'done', name: d.name! })
      }, () => setStage({ kind: 'expired' }))
    } catch {
      setError('Could not start the claim. Please try again.')
    } finally {
      setBusy(false)
    }

  }

  if (stage.kind === 'expired') {
    return (
      <div role="alert">
        <h1>Claim flow expired</h1>
        <p>This claim flow expired or was replaced by another tab. Start again to get a new challenge.</p>
        <p>If your claim already completed, sign in with the same terminal key.</p>
        <button type="button" onClick={() => setStage({ kind: 'form' })}>Restart claim</button>
        <p><a href="/auth/device">Sign in with your key</a></p>
      </div>
    )
  }

  if (stage.kind === 'done') {
    return (
      <>
        <h1 style={{ fontSize: 20, margin: '0 0 8px' }}>@{stage.name} is yours</h1>
        <p style={{ color: 'var(--ink-soft)', fontSize: 13 }}>
          The claim is recorded against your key. Signed by your terminal, seen by no one else.
        </p>
        <a href="/auth/device" style={{ color: 'var(--accent)', fontSize: 14 }}>sign in →</a>
      </>
    )
  }

  if (stage.kind === 'signing') {
    return (
      <>
        <h1 style={{ fontSize: 20, margin: '0 0 8px' }}>Prove it's your key</h1>
        <p style={{ color: 'var(--ink-soft)', fontSize: 13, margin: '0 0 16px' }}>
          One command in the terminal that holds the key:
        </p>
        <CopyBlock command={`gild auth claim ${stage.challenge}`} />
        <p className="mono-dim" style={{ textAlign: 'center' }}>waiting for your terminal…</p>
      </>
    )
  }

  const keyFromCli = params.get('key') !== null
  const ready = !busy && name.trim() !== '' && email.trim() !== '' && publicKey.trim() !== ''

  return (
    <>
      <h1 style={{ fontSize: 20, margin: '0 0 8px' }}>Claim your name</h1>
      <p style={{ color: 'var(--ink-soft)', fontSize: 13, margin: '0 0 20px' }}>
        Your identity is a key that lives in your terminal. Your email is how
        permission requests reach you — someone asking to contribute, an agent
        asking for access.
      </p>
      <form onSubmit={begin} style={{ display: 'grid', gap: 12 }}>
        <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
          username
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="@username"
            autoComplete="off"
            style={inputStyle}
          />
        </label>
        <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
          email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            style={inputStyle}
          />
        </label>
        <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
          public key {keyFromCli && <span className="mono-dim">(from your terminal)</span>}
          <textarea
            value={publicKey}
            onChange={(e) => setPublicKey(e.target.value)}
            placeholder="ed25519:…"
            rows={3}
            readOnly={keyFromCli}
            style={{ ...inputStyle, resize: 'vertical', opacity: keyFromCli ? 0.7 : 1 }}
          />
        </label>
        {error && <div role="alert"><p style={{ color: '#c0392b', fontSize: 13, margin: 0 }}>{error}</p><p>Already claimed your name? <a href="/auth/device">Sign in with your key</a></p></div>}
        <button
          type="submit"
          disabled={!ready}
          style={{
            padding: '10px', borderRadius: 6, border: 'none', fontFamily: 'inherit',
            background: 'var(--accent)', color: '#000', fontWeight: 600,
            opacity: ready ? 1 : 0.5, cursor: ready ? 'pointer' : 'default',
          }}
        >
          continue →
        </button>
        <p className="mono-dim" style={{ margin: 0 }}>
          First come, first served. The claim is bound to the key, not the machine you're on.
        </p>
      </form>
    </>
  )
}

export default function ClaimPage() {
  return (
    <Suspense>
      <ClaimForm />
    </Suspense>
  )
}
