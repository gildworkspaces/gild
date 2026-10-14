import { displayIdentity } from '@/lib/channel/identity'
import { Picture } from '@/components/Picture'
import Link from '@/components/Link'
import { GRANTS, mayWrite, readAcl } from '@/lib/access'
import { readIndex } from '@/lib/metastore'
import { session } from '@/lib/session'
import { store } from '@/lib/backend'
import { GrantForm, OrchestratorToggle, RequestCard, SuspendButton } from '@/components/AgentControls'
import { coveringScopes } from '@/lib/orchestrators'
import { requestsFor } from '@/lib/agentRequests'
import { pullChange } from '@/lib/changes'
import { AgentLegend, AgentMap, type AgentWork } from '@/components/repo/AgentMap'
import { cleanRoot } from '@/lib/treemap-layout'
import s from '../../repo.module.css'

export const dynamic = 'force-dynamic'

const COLORS = ['var(--lane-2)', 'var(--lane-1)', 'var(--lane-3)', 'var(--ok)']
const WHAT: Record<string, string> = { pr: 'Push branches and claim issues', review: 'Approve and request changes', queue: 'Add approved work to the merge queue' }

export default async function AgentsTab({ params, searchParams }: { params: Promise<{ owner: string; repo: string }>; searchParams: Promise<{ in?: string }> }) {
  const { owner, repo } = await params
  const sp = await searchParams
  const [acl, index, me] = await Promise.all([readAcl(owner, repo), readIndex(owner, repo), session()])
  const writer = await mayWrite(owner, me?.name ?? null)
  const myAgents = writer && me?.name ? (await (await store()).agentsFor(me.name)).filter((a) => !a.revokedAt).map((a) => a.name) : []
  const waiting = me?.name ? await requestsFor(me.name, `${owner}/${repo}`) : []

  // Everyone who is an agent here: granted in acl.json, or seen doing work.
  const names = new Set<string>(Object.keys(acl.agents ?? {}).map((a) => a.replace(/^@/, '')))
  for (const i of index.issues) if (i.claim?.by.includes('/')) names.add(i.claim.by)
  for (const p of index.pulls) if (p.author.includes('/')) names.add(p.author)

  const openPulls = index.pulls.filter((p) => p.state === 'open')
  // What each open pull request changes, from the cached change views (keyed
  // by branch tips): a lookup per pull request, not a clone.
  const changes = await Promise.all(openPulls.map((p) => pullChange(owner, repo, p.head, p.base).catch(() => null)))
  const files = new Map(openPulls.map((p, i) => [p.number, (changes[i]?.files ?? []).map((f) => f.path)]))

  // Files that more than one author's open pull requests change.
  const touched = new Map<string, { author: string; number: number }[]>()
  for (const p of openPulls) for (const f of files.get(p.number) ?? []) touched.set(f, [...(touched.get(f) ?? []), { author: p.author, number: p.number }])
  const overlaps = [...touched].filter(([, who]) => new Set(who.map((w) => w.author)).size > 1)

  const st = await store()
  // Orchestrators granted here or on the org, and the children they spawned.
  const { repoScope, orgScope } = await coveringScopes(st, owner, repo)
  const grants = await st.orchestratorsIn([repoScope, orgScope])
  for (const g of grants) names.add(g.agent)
  const records = new Map((await Promise.all([...names].map((n) => st.getAgent(n)))).filter((a) => a !== null).map((a) => [a!.name, a!]))
  const revoked = new Set([...records.values()].filter((a) => a.revokedAt).map((a) => a.name))
  const liveChildren = new Map(await Promise.all(grants.map(async (g) => [g.agent, (await st.childrenOf(g.agent)).filter((c) => !c.revokedAt).length] as const)))
  const grants_ = (name: string) => grants.find((g) => g.agent === name && g.scope === repoScope) ? 'repo' as const : grants.find((g) => g.agent === name) ? 'org' as const : null
  const agents = [...names].sort().map((name, i) => {
    const grants = acl.agents?.[`@${name}`] ?? []
    const prs = openPulls.filter((p) => p.author === name)
    const claims = index.issues.filter((iss) => iss.state === 'open' && iss.claim?.by === name)
    const reviewing = openPulls.filter((p) => p.approvals.includes(name) || p.changesRequested.includes(name))
    const queued = prs.filter((p) => index.queue.includes(p.number))
    const record = records.get(name)
    const status = revoked.has(name) ? 'revoked'
      : record?.suspendedAt ? 'suspended'
      : queued.length ? 'in the merge queue'
      : prs.some((p) => p.changesRequested.length || p.conflicts) ? 'waiting on a fix'
      : prs.length || claims.length ? 'working'
      : reviewing.length ? 'reviewing'
      : grants.length ? 'idle' : 'no access here'
    const orchestrator = grants_(name)
    return { name, sponsor: name.split('/')[0], grants, prs, claims, reviewing, status, color: COLORS[i % COLORS.length], spawnedBy: record?.sponsoredBy ?? null, orchestrator, suspended: !!record?.suspendedAt }
  })

  const work: AgentWork[] = agents.filter((a) => a.prs.length).map((a) => {
    const files = new Map<string, { adds: number; dels: number; pull: number }>()
    openPulls.forEach((p, i) => {
      if (p.author !== a.name) return
      for (const f of changes[i]?.files ?? []) {
        const cur = files.get(f.path)
        if (f.additions + f.deletions > (cur ? cur.adds + cur.dels : 0)) files.set(f.path, { adds: f.additions, dels: f.deletions, pull: p.number })
      }
    })
    return { name: a.name, color: a.color, files }
  })
  // The repo's files and sizes: the union of every open pull request's head
  // (cached views), so a file one agent is adding still gets its real size.
  const sizeOf = new Map<string, number>()
  for (const c of changes) for (const f of c?.sizes ?? []) sizeOf.set(f.path, Math.max(sizeOf.get(f.path) ?? 0, f.lines))
  const sizes = [...sizeOf].map(([path, lines]) => ({ path, lines }))

  const base = `/${owner}/${repo}`
  return (
    <div className={s.body}>
      <main className={s.main}>
        {waiting.length > 0 && (
          <section style={{ display: 'grid', gap: 10 }} aria-label="Join requests">
            <h2 style={{ margin: 0, fontSize: 17 }}>Waiting for your approval <span className={s.count}>{waiting.length}</span></h2>
            {waiting.map((w) => <RequestCard key={w.request.id} {...w} />)}
          </section>
        )}
        <AgentMap agents={work} sizes={sizes} root={cleanRoot(sp.in, sizes)} base={base}
          zoomHref={(dir) => `${base}/settings/agents${dir ? `?in=${encodeURIComponent(dir)}` : ''}`} />
        {agents.length === 0 && <p className={s.note}>No agents work here yet. An agent asks to join with <code>gild agent join &lt;name&gt; --sponsor &lt;you&gt; --repo {owner}/{repo}</code>, and its request shows up here.</p>}
        {agents.map((a) => (
          <article key={a.name} className={s.card}>
            <div className={s.cardHead} style={{ alignItems: 'center' }}>
              <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <Picture name={a.name} size={34} />
                <span style={{ display: 'grid', gap: 2 }}>
                  <strong className={s.mono} style={{ fontSize: 15, color: a.color }}>@{displayIdentity(a.name)}</strong>
                  <span>{a.spawnedBy ? <>spawned by @{displayIdentity(a.spawnedBy)}</> : <>signed in by @{displayIdentity(a.sponsor)}</>}{a.orchestrator && <> · <span title="Orchestrator: spawns child agents, takes them offline, reads every agent's mentions">% orchestrator{a.orchestrator === 'org' ? ' (org)' : ''}</span></>}</span>
                </span>
              </span>
              <span className={s.state}>{a.status}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              <div className={s.cardBody} style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
                <span className={s.muted} style={{ textTransform: 'uppercase', letterSpacing: '.05em', fontSize: 12 }}>Working on</span>
                {a.prs.length === 0 && a.claims.length === 0 && <span className={s.muted}>Nothing open.</span>}
                {a.prs.map((p) => <Link key={p.number} href={`${base}/pulls/${p.number}`} style={{ fontSize: 14 }}>PR #{p.number} {p.title} <span className={s.mono} style={{ color: 'var(--ink-faint)', fontSize: 12 }}>{p.head}</span></Link>)}
                {a.claims.map((iss) => <Link key={iss.number} href={`${base}/issues/${iss.number}`} style={{ fontSize: 14 }}>claimed #{iss.number} {iss.title}</Link>)}
              </div>
              <div className={s.cardBody} style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
                <span className={s.muted} style={{ textTransform: 'uppercase', letterSpacing: '.05em', fontSize: 12 }}>May, in this repo</span>
                {GRANTS.map((g) => (
                  <span key={g} style={{ fontSize: 13, color: a.grants.includes(g) ? 'var(--ink-soft)' : 'var(--ink-faint)' }}>{a.grants.includes(g) ? '✓' : '–'} {WHAT[g]}</span>
                ))}
                {writer && a.status !== 'revoked' && <GrantForm owner={owner} repo={repo} agents={[]} initial={{ agent: a.name, grants: a.grants }} />}
                {writer && a.status !== 'revoked' && a.orchestrator !== 'org' && <OrchestratorToggle owner={owner} repo={repo} agent={a.name} granted={a.orchestrator === 'repo'} children={liveChildren.get(a.name) ?? 0} />}
                {writer && a.status !== 'revoked' && (a.spawnedBy || a.orchestrator) && <SuspendButton owner={owner} repo={repo} agent={a.name} suspended={a.suspended} />}
              </div>
              <div className={s.cardBody} style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
                <span className={s.muted} style={{ textTransform: 'uppercase', letterSpacing: '.05em', fontSize: 12 }}>Reviewing</span>
                {a.reviewing.length === 0 ? <span className={s.muted}>Nothing.</span> : a.reviewing.map((p) => (
                  <Link key={p.number} href={`${base}/pulls/${p.number}`} style={{ fontSize: 14 }}>#{p.number} · {p.approvals.includes(a.name) ? 'approved' : 'asked for changes'}</Link>
                ))}
              </div>
            </div>
          </article>
        ))}
      </main>

      <aside className={s.about} style={{ maxWidth: 340, gap: 16 }} aria-label="Agent access">
        {work.length > 0 && (
          <div className={s.mergeBox}>
            <strong>Who&apos;s who</strong>
            <AgentLegend agents={work} />
          </div>
        )}
        <div className={s.mergeBox} style={overlaps.length ? { borderColor: 'var(--bad)' } : undefined}>
          <strong>Overlapping work</strong>
          <span className={s.muted}>Files that more than one author&apos;s open pull requests change. Whoever merges second will need to update their branch.</span>
          {overlaps.length === 0 ? <span className={s.muted}>None right now.</span> : overlaps.map(([file, who]) => (
            <div key={file} style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              <span className={s.mono} style={{ fontWeight: 600 }}>{file}</span>
              {who.map((w) => <Link key={w.number} href={`${base}/pulls/${w.number}`}>@{displayIdentity(w.author)} · #{w.number}</Link>)}
            </div>
          ))}
        </div>
        {writer && myAgents.some((a) => !names.has(a)) && (
          <div className={s.mergeBox}>
            <strong>Let an agent work here</strong>
            <GrantForm owner={owner} repo={repo} agents={myAgents.filter((a) => !names.has(a))} />
          </div>
        )}
      </aside>
    </div>
  )
}
