import { PublicIssueControls } from '@/components/repo/PublicIssueControls'
import { authorLabel } from '@/lib/import/source'
import Link from '@/components/Link'
import { notFound } from 'next/navigation'
import { readIssue } from '@/lib/issues'
import { capabilities } from '@/lib/access'
import { session } from '@/lib/session'
import { renderMarkdown } from '@/lib/markdown'
import { ago } from '@/lib/time'
import s from '../../repo.module.css'


const VERB: Record<string, string> = { closed: 'closed this', reopened: 'reopened this', claimed: 'claimed this', unclaimed: 'released the claim' }

export default async function IssuePage({ params }: { params: Promise<{ owner: string; repo: string; number: string }> }) {
  const { owner, repo, number } = await params
  if (!/^\d+$/.test(number)) notFound()
  const [found, me] = await Promise.all([readIssue(owner, repo, Number(number)), session()])
  if (!found) notFound()
  const { issue, comments, log } = found
  const name = me?.name ?? null
  const { writer } = await capabilities(owner, repo, name)

  // One timeline: the opening post, then comments and state changes in time order.
  const timeline = [
    ...comments.map((c) => ({ at: c.createdAt, kind: 'comment' as const, c })),
    ...log.map((e) => ({ at: e.at, kind: 'event' as const, e })),
  ].sort((a, b) => a.at.localeCompare(b.at))


  return (
    <div>
      <div className={s.issueHead}>
        <h2 className={s.issueTitle}>{issue.title} <span>#{issue.number}</span></h2>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 14, color: 'var(--ink-dim)' }}>
          <span className={`${s.pill} ${issue.state === 'open' ? s.pillOpen : s.pillClosed}`}>{issue.state === 'open' ? 'Open' : 'Closed'}</span>
          <span>{authorLabel(issue.author)} opened this {ago(Date.parse(issue.createdAt))}</span>
          {issue.claim && <span className={s.claim}>claimed by @{issue.claim.by}</span>}
          {issue.labels.map((l) => <span key={l} className={s.tag}>{l}</span>)}
        </div>
      </div>

      <div className={s.body}>
        <div className={s.timeline}>
          <article className={s.card}>
            <div className={s.cardHead}><span><strong>{authorLabel(issue.author)}</strong> opened {ago(Date.parse(issue.createdAt))}</span><span className="mono">.gild/{issue.number}/issue/issue.json</span></div>
            <div className={`${s.cardBody} ${s.readme}`} style={{ padding: '14px 18px' }}
              dangerouslySetInnerHTML={{ __html: issue.body.trim() ? renderMarkdown(issue.body) : '<p><em>No description.</em></p>' }} />
          </article>

          {timeline.map((t) => t.kind === 'comment' ? (
            <article key={t.c.id} className={s.card}>
              <div className={s.cardHead}><span><strong>{authorLabel(t.c.author)}</strong> commented {ago(Date.parse(t.c.createdAt))}</span></div>
              <div className={`${s.cardBody} ${s.readme}`} style={{ padding: '14px 18px' }} dangerouslySetInnerHTML={{ __html: renderMarkdown(t.c.body) }} />
            </article>
          ) : (
            <p key={`${t.e.at}-${t.e.kind}`} className={s.event}><strong>@{t.e.by}</strong> {VERB[t.e.kind] ?? t.e.kind} · {ago(Date.parse(t.e.at))}</p>
          ))}

          <PublicIssueControls owner={owner} repo={repo} issue={{number:issue.number,author:issue.author,state:issue.state,claim:issue.claim}}/>
        </div>

        <aside className={s.about} aria-label="Details">
          <div className={s.section}>
            <h2>Claim</h2>
            <p className={s.desc}>{issue.claim ? `@${issue.claim.by}, ${ago(Date.parse(issue.claim.at))}` : 'Nobody is working on this yet.'}</p>
          </div>
          <div className={s.section}>
            <h2>Stored in git</h2>
            <p className={s.muted}>This issue, its comments and every state change are commits on the <code>_meta</code> branch. Clone the repo and run <code>git log _meta</code> to see them.</p>
          </div>
        </aside>
      </div>
    </div>
  )
}
