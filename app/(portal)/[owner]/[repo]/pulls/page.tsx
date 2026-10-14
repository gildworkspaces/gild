import { authorLabel } from '@/lib/import/source'
import Link from '@/components/Link'
import { listPulls } from '@/lib/pulls'
import { PublicCreateItem } from '@/components/repo/PublicCreateItem'
import { ago } from '@/lib/time'
import type { PullEntry } from '@/lib/metastore'
import s from '../repo.module.css'


function status(p: PullEntry, queuePos: number) {
  if (p.state === 'merged') return { text: 'merged', cls: s.stateMerged }
  if (p.state === 'closed') return { text: 'closed', cls: '' }
  if (queuePos >= 0) return { text: `in queue · ${queuePos + 1}`, cls: s.stateWarn }
  if (p.conflicts) return { text: 'conflicts', cls: s.stateBad }
  if (p.changesRequested.length) return { text: `changes requested by @${p.changesRequested[0]}`, cls: s.stateBad }
  if (p.approvals.length) return { text: `approved by @${p.approvals[0]}`, cls: s.stateGood }
  return { text: 'needs review', cls: '' }
}

export default async function PullsTab({ params, searchParams }: {
  params: Promise<{ owner: string; repo: string }>
  searchParams: Promise<{ state?: string }>
}) {
  const { owner, repo } = await params
  const sp = await searchParams
  const want = sp.state === 'merged' ? 'merged' : sp.state === 'closed' ? 'closed' : 'open'
  const {pulls,queue}=await listPulls(owner,repo)
  const count = (st: string) => pulls.filter((p) => p.state === st).length
  const shown = pulls.filter((p) => p.state === want)
  const base = `/${owner}/${repo}/pulls`
  const byNumber = new Map(pulls.map((p) => [p.number, p]))

  return (
    <div className={s.body} style={{ paddingTop: 0 }}>
      <div className={s.main}>
        <div className={s.listBar}>
          {(['open', 'merged', 'closed'] as const).map((st) => (
            <Link key={st} href={`${base}?state=${st}`} className={`${s.filter} ${want === st ? s.filterOn : ''}`}>{count(st)} {st}</Link>
          ))}
          <span className={s.grow} />
          <PublicCreateItem path={`${base}/new`} label="New pull request" anonymous="Sign in to open one"/>
        </div>
        <div className={s.list}>
          {shown.length === 0 ? <p className={s.empty}>{pulls.length === 0 ? 'No pull requests yet.' : `No ${want} pull requests.`}</p> : shown.map((p) => {
            const st = status(p, queue.indexOf(p.number))
            return (
              <div key={p.number} className={s.item}>
                <div className={s.itemMain}>
                  <Link href={`${base}/${p.number}`} className={s.itemTitle}>{p.title}</Link>
                  <span className={s.itemMeta}>#{p.number} by {authorLabel(p.author)} · <span className={s.mono}>{p.head}</span> → <span className={s.mono}>{p.base}</span> · {ago(Date.parse(p.updatedAt))}</span>
                </div>
                <div className={s.itemSide}>
                  <span className={`${s.state} ${st.cls}`}>{st.text}</span>
                  {p.comments > 0 && <span>{p.comments} {p.comments === 1 ? 'comment' : 'comments'}</span>}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <aside className={s.queue} aria-label="Merge queue" style={{ marginTop: 20 }}>
        <h2>Merge queue</h2>
        <p className={s.muted}>Approved pull requests merge one at a time, each onto the main the previous one left behind. One that no longer merges cleanly leaves the queue marked as conflicting instead of landing broken.</p>
        {queue.length === 0 ? <p className={s.muted}>Empty right now.</p> : (
          <ol>
            {queue.map((n, i) => {
              const p = byNumber.get(n)
              return (
                <li key={n}>
                  <span className={s.queueN}>{i + 1}</span>
                  <Link href={`${base}/${n}`} style={{ color: 'var(--ink)', fontWeight: 600 }}>#{n} {p?.title ?? ''}</Link>
                </li>
              )
            })}
          </ol>
        )}
      </aside>
    </div>
  )
}
