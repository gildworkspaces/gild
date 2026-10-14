import { NextResponse } from 'next/server'
import { store } from './backend.ts'
import { issueSession } from './session.ts'
import { browserProofHash, browserProofState, clearBrowserProof, type BrowserProofKind } from './browser-proof.ts'

/** Session issuance requires the initiating browser and one atomic completion. */
export async function browserStatus(request: Request, kind: BrowserProofKind) {
  const headers = { 'cache-control': 'private, no-store' }
  const state = browserProofState(request, kind)
  if (!state) return NextResponse.json({ status: 'expired' }, { status: 404, headers })
  const challenge = new URL(request.url).searchParams.get('challenge') ?? ''
  const completion = await (await store()).completeBrowserChallenge(kind, challenge, await browserProofHash(state))
  if (!completion) return NextResponse.json({ status: 'expired' }, { status: 404, headers })
  if (completion.status === 'pending') return NextResponse.json({ status: 'pending' }, { headers })
  const res = NextResponse.json(kind === 'auth' ? { status: 'ok' } : { status: 'done', name: completion.name }, { headers })
  await issueSession(res, { publicKey: completion.publicKey, ...(completion.name ? { name: completion.name } : {}) })
  res.headers.append('set-cookie', clearBrowserProof(kind))
  return res
}
