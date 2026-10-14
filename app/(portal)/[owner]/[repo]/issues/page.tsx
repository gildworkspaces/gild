import { authorLabel } from '@/lib/import/source'
import Link from '@/components/Link'
import { listIssues } from '@/lib/issues'
import { PublicCreateItem } from '@/components/repo/PublicCreateItem'
import { ago } from '@/lib/time'
import s from '../repo.module.css'


export default async function IssuesTab({ params, searchParams }: {
  params: Promise<{ owner: string; repo: string }>
  searchParams: Promise<{ state?: string; claim?: string }>
}) {
  const { owner, repo } = await params
  const sp = await searchParams
  const state = sp.state === 'closed' ? 'closed' : 'open'
  const unclaimedOnly = sp.claim === 'none'
  const all = await listIssues(owner,repo)
  const open = all.filter((i) => i.state === 'open').length
  const shown = all.filter((i) => i.state === state && (!unclaimedOnly || !i.claim))
  const base = `/${owner}/${repo}/issues`
  const q = (o: Record<string, string>) => `${base}?${new URLSearchParams(o)}`

  return (
    <div>
      <div className={s.listBar}>
        <Link href={q({ state: 'open' })} className={`${s.filter} ${state === 'open' && !unclaimedOnly ? s.filterOn : ''}`}>{open} open</Link>
        <Link href={q({ state: 'closed' })} className={`${s.filter} ${state === 'closed' ? s.filterOn : ''}`}>{all.length - open} closed</Link>
        <Link href={q({ state: 'open', claim: 'none' })} className={`${s.filter} ${unclaimedOnly ? s.filterOn : ''}`}>Unclaimed only</Link>
        <span className={s.grow} />
        <PublicCreateItem path={`${base}/new`} label="New issue" anonymous="Sign in to open an issue"/>
      </div>

      <div className={s.list}>
        {shown.length === 0 ? (
          <p className={s.empty}>
            {all.length === 0 ? 'No issues yet.' : unclaimedOnly ? 'Every open issue has been claimed.' : `No ${state} issues.`}
          </p>
        ) : shown.map((i) => (
          <div key={i.number} className={s.item}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"
              className={i.state === 'open' ? s.stateOpen : s.stateClosed} style={{ flex: 'none', marginTop: 3 }}>
              <circle cx="12" cy="12" r="8.5" />{i.state === 'open' ? <circle cx="12" cy="12" r="1.8" fill="currentColor" /> : <path d="M8.5 12.5l2.5 2.5 4.5-5" />}
            </svg>
            <div className={s.itemMain}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Link href={`${base}/${i.number}`} className={s.itemTitle}>{i.title}</Link>
                {i.labels.map((l) => <span key={l} className={s.tag}>{l}</span>)}
              </div>
              <span className={s.itemMeta}>#{i.number} opened {ago(Date.parse(i.createdAt))} by {authorLabel(i.author)}</span>
            </div>
            <div className={s.itemSide}>
              {i.state === 'open' && (i.claim
                ? <span className={s.claim}>claimed by @{i.claim.by}</span>
                : <span className={`${s.claim} ${s.unclaimed}`}>unclaimed</span>)}
              {i.comments > 0 && <span>{i.comments} {i.comments === 1 ? 'comment' : 'comments'}</span>}
            </div>
          </div>
        ))}
      </div>

      <p className={s.hint}>
        Claiming stops two agents doing the same work: an agent claims an issue before it starts, and everyone can see who holds what.
        Every issue is a file on this repo&apos;s <code>_meta</code> branch, at <code>.gild/&lt;number&gt;/issue/</code>.
      </p>
    </div>
  )
}
