'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { pollBrowserChallenge } from '@/lib/browser-challenge-poll'
import { CopyBlock } from '@/components/CopyBlock'
import { signInOptions as SignInOptions } from '@/lib/hosted/signin'

export default function DevicePage() {
  const [challenge, setChallenge] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'waiting' | 'done' | 'expired' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const router = useRouter()
  const [{ next, error }, setQuery] = useState({ next: '/dashboard', error: '' })
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    setQuery({ next: q.get('next') ?? '/dashboard', error: q.get('error') ?? '' })
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setChallenge(null); setState('loading')
    fetch('/api/auth/challenge', { method: 'POST', cache: 'no-store', signal: controller.signal })
      .then(async r => { if (!r.ok) throw new Error('Challenge unavailable'); return r.json() })
      .then(d => { if (!controller.signal.aborted) { setChallenge(d.challenge); setState('waiting') } })
      .catch(() => { if (!controller.signal.aborted) setState('error') })
    return () => controller.abort()
  }, [attempt])

  useEffect(() => {
    if (!challenge || state !== 'waiting') return
    return pollBrowserChallenge(`/api/auth/status?challenge=${encodeURIComponent(challenge)}`, () => {
      setState('done')
      const next = new URLSearchParams(window.location.search).get('next')
      // Only return to local paths; protocol-relative URLs leave this site.
      router.push(next?.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : '/dashboard')
    }, () => { setChallenge(null); setState('expired') })
  }, [challenge, state, router])

  return (
    <>
      <h1 style={{ fontSize: 20, margin: '0 0 8px' }}>Sign in</h1>
      {error && <p role="alert" style={{ color: 'var(--bad)', fontSize: 13 }}>{error}</p>}
      {SignInOptions && <SignInOptions next={next} />}
      <p style={{ color: 'var(--ink-soft)', fontSize: 13, margin: '0 0 20px' }}>
        gild never asks for a password. This browser shows a challenge; your
        terminal signs it. The root key never touches the browser.
      </p>
      <div
        style={{
          border: '1px dashed var(--rule)', borderRadius: 8, padding: '18px 14px',
          textAlign: 'center', fontSize: 13, wordBreak: 'break-all',
          color: state === 'waiting' ? 'var(--ink)' : 'var(--ink-faint)',
        }}
      >
        {challenge ?? '…'}
      </div>
      {state === 'waiting' && (
        <>
          <CopyBlock command={`gild auth sign ${challenge}`} />
          <p className="mono-dim" style={{ textAlign: 'center' }}>waiting for your terminal…</p>
        </>
      )}
      {(state === 'expired' || state === 'error') && (
        <div role="alert">
          <p>{state === 'expired' ? 'This sign-in flow expired or was replaced by another tab. Start again to get a new challenge.' : 'Could not start sign-in. Please try again.'}</p>
          <button type="button" onClick={() => setAttempt(a => a + 1)}>Restart sign in</button>
        </div>
      )}
      {state === 'done' && <p style={{ color: 'var(--accent)', textAlign: 'center' }}>signed — opening…</p>}
    </>
  )
}
