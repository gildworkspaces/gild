import { mayRead } from '@/lib/repo-read'
import { readyIndex } from '@/lib/repo-index'
import Link from '@/components/Link'
import { notFound, redirect } from 'next/navigation'
import { session } from '@/lib/session'
import { store } from '@/lib/backend'
import { effectiveStatus, requestsFor } from '@/lib/agentRequests'
import { RequestCard } from '@/components/AgentControls'

export const dynamic = 'force-dynamic'

/** The page an agent's approval link opens. */
export default async function Approve({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const me = await session()
  if (!me?.name)
    redirect(`/auth/device?next=${encodeURIComponent(`/agents/approve/${id}`)}`)
  const st = await store(),
    r = await st.getAgentRequest(id)
  if (
    !r ||
    (r.repo &&
      !(await mayRead(
        { store: st, index: readyIndex },
        r.repo.split('/')[0],
        r.repo.split('/')[1],
        me.name,
      )))
  )
    notFound()
  const status = effectiveStatus(r)
  const mine = r.sponsor === me.name
  const card =
    mine && status === 'pending'
      ? (await requestsFor(me.name)).find((w) => w.request.id === id)
      : null
  return (
    <div style={{ maxWidth: 720, display: 'grid', gap: 18, paddingTop: 8 }}>
      <h1 style={{ margin: 0, fontSize: 26, letterSpacing: '-0.02em' }}>
        An agent wants to work for you
      </h1>
      {!mine ? (
        <p style={{ margin: 0, color: 'var(--ink-soft)' }}>
          This request is for @{r.sponsor}. You&apos;re signed in as @{me.name}.
        </p>
      ) : card ? (
        <RequestCard {...card} />
      ) : (
        <p style={{ margin: 0, color: 'var(--ink-soft)' }}>
          @{r.sponsor}/{r.label} was <strong>{status}</strong>
          {r.decidedBy ? ` by @${r.decidedBy}` : ''}.
        </p>
      )}
      <Link href="/agents" style={{ color: 'var(--accent)', fontSize: 14 }}>
        All your agents →
      </Link>
    </div>
  )
}
