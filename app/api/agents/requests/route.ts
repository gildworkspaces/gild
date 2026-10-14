import { requestMayRead } from '@/lib/privacy-production'
import { bootstrap } from '@/lib/api/bootstrap'
import { NextResponse } from 'next/server'
import { caller, isAgent } from '@/lib/access'
import { store } from '@/lib/backend'
import { effectiveStatus } from '@/lib/agentRequests'

/** An agent asks to join: { sponsor, label, publicKey, repo?, grants?, note? }.
 *  No account needed; the agent proves its key later, when it collects the token. */
export async function POST(request: Request) {
  return bootstrap(request, 'join')
}

/** Requests waiting for the caller: their own, or their sponsor's when the
 *  caller is an approver agent. */
export async function GET(request: Request) {
  const name = await caller(request)
  if (!name)
    return NextResponse.json({ error: 'sign in first' }, { status: 401 })
  const st = await store()
  let sponsor = name
  if (isAgent(name)) {
    const a = await st.getAgent(name)
    if (!a?.approver) return NextResponse.json({ requests: [] })
    sponsor = a.sponsor
  }
  const pending = (await st.pendingRequestsFor(sponsor)).filter(
    (r) => effectiveStatus(r) === 'pending',
  )
  const requests = (
    await Promise.all(
      pending.map(async (r) =>
        !r.repo ||
        (await requestMayRead(
          request,
          r.repo.split('/')[0],
          r.repo.split('/')[1],
        ))
          ? r
          : null,
      ),
    )
  ).filter((r) => r !== null)
  return NextResponse.json(
    { requests },
    { headers: { 'cache-control': 'private, no-store' } },
  )
}
