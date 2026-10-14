import { redirect } from 'next/navigation'
import { session } from '@/lib/session'
import { store } from '@/lib/backend'
import { requestsFor } from '@/lib/agentRequests'
import { ago } from '@/lib/time'
import { fingerprint } from '@/lib/fingerprint'
import { AgentActions, RequestCard } from '@/components/AgentControls'

export const dynamic = 'force-dynamic'

export default async function AgentsPage() {
  const me = await session()
  if (!me?.name) redirect('/auth/device?next=/agents')
  const [agents, waiting] = await Promise.all([(await store()).agentsFor(me.name), requestsFor(me.name)])
  const live = agents.filter((a) => !a.revokedAt)
  const keys = new Map(await Promise.all(live.filter((a) => a.publicKey).map(async (a) => [a.name, await fingerprint(a.publicKey!)] as const)))
  const revoked = agents.filter((a) => a.revokedAt)
  return (
    <div style={{ maxWidth: 860, display: 'grid', gap: 28, paddingTop: 8 }}>
      <header style={{ display: 'grid', gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 28, letterSpacing: '-0.02em' }}>Your agents</h1>
        <p style={{ margin: 0, color: 'var(--ink-soft)', maxWidth: '62ch' }}>
          Agents ask to join and you approve them, the way a new machine joins a tailnet. Each one acts with its own key,
          so everything it does shows who did the work and who sent it.
        </p>
      </header>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Waiting for you <span style={{ color: 'var(--ink-faint)', fontWeight: 500 }}>{waiting.length}</span></h2>
        {waiting.length === 0 ? <p style={{ margin: 0, color: 'var(--ink-dim)' }}>No requests right now.</p> : waiting.map((w) => <RequestCard key={w.request.id} {...w} />)}
      </section>

      <section style={{ display: 'grid', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>How an agent joins</h2>
        <p style={{ margin: 0, color: 'var(--ink-soft)', fontSize: 14 }}>On the agent&apos;s machine:</p>
        <pre style={{ margin: 0, padding: '12px 14px', border: '1px solid var(--rule)', borderRadius: 8, background: 'var(--bg-soft)', fontFamily: 'var(--font-mono)', fontSize: 13, overflowX: 'auto' }}>{`gild agent join codex --sponsor ${me.name} --repo ${me.name}/app --grants pr`}</pre>
        <p style={{ margin: 0, color: 'var(--ink-dim)', fontSize: 14 }}>It prints a link to an approval page, waits, and collects its token by signing with its own key once you approve.</p>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Active <span style={{ color: 'var(--ink-faint)', fontWeight: 500 }}>{live.length}</span></h2>
        {live.length === 0 ? <p style={{ margin: 0, color: 'var(--ink-dim)' }}>None yet.</p> : live.map((a) => (
          <div key={a.name} style={{ display: 'flex', gap: 16, justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', border: '1px solid var(--rule)', borderRadius: 12, padding: 16, background: 'var(--surface)' }}>
            <div style={{ display: 'grid', gap: 4 }}>
              <strong style={{ fontFamily: 'var(--font-mono)', fontSize: 15 }}>@{a.name}{a.approver && <span style={{ fontFamily: 'var(--font-sans)', fontWeight: 500, fontSize: 12, color: 'var(--accent)', marginLeft: 8 }}>approver</span>}</strong>
              <span style={{ fontSize: 13, color: 'var(--ink-faint)' }}>approved by {!a.approvedBy || a.approvedBy === me.name ? 'you' : `@${a.approvedBy}`} · {ago(Date.parse(a.createdAt))}{a.publicKey ? ` · key ${keys.get(a.name)}` : ''}</span>
            </div>
            <AgentActions label={a.label} name={a.name} approver={a.approver} />
          </div>
        ))}
      </section>

      {revoked.length > 0 && (
        <section style={{ display: 'grid', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 15, color: 'var(--ink-dim)' }}>Revoked</h2>
          {revoked.map((a) => <span key={a.name} style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--ink-faint)' }}>@{a.name} · revoked {ago(Date.parse(a.revokedAt!))}</span>)}
        </section>
      )}
    </div>
  )
}
