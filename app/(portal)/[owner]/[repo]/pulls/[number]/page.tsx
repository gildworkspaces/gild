import { PublicPullControls } from '@/components/repo/PublicPullControls'
import { authorLabel } from '@/lib/import/source'
import {SessionReceipts} from '@/components/repo/SessionReceipts'
import {sessionsFor} from '@/lib/sessions/read'
import { CommitActions } from '@/components/repo/Actions'
import { actionsForCommit } from '@/lib/actions/service'
import { pageRefs } from '@/lib/repo-index'
import Link from '@/components/Link'
import { notFound } from 'next/navigation'
import { readPull } from '@/lib/pulls'
import { commitChange, pullChange } from '@/lib/changes'
import { Diff, FileView } from '@/components/repo/Diff'
import { Glance, cleanRoot } from '@/components/repo/Glance'
import { HealthReview, isCategory } from '@/components/repo/Health'
import { scoreRead } from '@/lib/cqx'
import { capabilities } from '@/lib/access'
import { session } from '@/lib/session'
import { renderMarkdown } from '@/lib/markdown'
import { headers } from 'next/headers'
import { ApiError } from '@/lib/api/errors'
import { PreparingRepository } from '@/components/repo/PreparingRepository'
import { ago } from '@/lib/time'
import s from '../../repo.module.css'


const EVENT: Record<string, string> = {
  queued: 'added this to the merge queue', dequeued: 'took this out of the merge queue', merged: 'merged this',
  conflicts: 'found conflicts while merging', closed: 'closed this', reopened: 'reopened this',
}
const VERDICT: Record<string, string> = { approve: 'approved', changes: 'requested changes', comment: 'reviewed' }

export default async function PullPage({ params, searchParams }: {
  params: Promise<{ owner: string; repo: string; number: string }>
  searchParams: Promise<{ tab?: string; in?: string; file?: string; cat?: string }>
}) {
  const { owner, repo, number } = await params
  const sp = await searchParams
  const tab = sp.tab === 'files' || sp.tab === 'glance' ? sp.tab : 'conversation'
  if (!/^\d+$/.test(number)) notFound()
  const [found, me] = await Promise.all([readPull(owner, repo, Number(number)), session()])
  if (!found) notFound()
  const { pull, reviews, comments, log, queue } = found
  const name = me?.name ?? null
  const { writer } = await capabilities(owner, repo, name)
  // A merged pull request is read from its merge commit (its branch may be
  // gone, and it no longer differs from the base); an open one from its branch.
  let preparing = false
  const preparation = async (error: unknown) => {
    if (!(error instanceof ApiError) || error.status !== 503) throw error
    // The producer retries rather than storing an incomplete public page.
    if ((await headers()).has('x-gild-publishing')) throw error
    preparing = true
    return null
  }
  const diff = pull.state === 'merged'
    ? (tab !== 'conversation' && pull.merged ? await commitChange(owner, repo, pull.merged.commit, pull.base).catch(preparation) : null)
    : await pullChange(owner, repo, pull.head, pull.base).catch(preparation)

  // The cqx review sits under Glance: the head scored, and the commit it started from.
  // One at a time: each run holds a whole snapshot in wasm memory.
  const reviewing = diff && tab === 'glance' && !sp.file
  const pendingScore = async (error: unknown) => { await preparation(error); return null }
  const healthAfterRead = reviewing ? await scoreRead(owner, repo, diff.to).catch(pendingScore) : null
  const healthAfter = healthAfterRead?.report??null
  const healthBeforeRead = reviewing && healthAfter && diff.from ? await scoreRead(owner, repo, diff.from).catch(pendingScore) : null
  const healthBefore = healthBeforeRead?.report??null
  if (preparing && tab !== 'conversation') return <PreparingRepository />

  const currentSha = pull.merged?.commit ?? (await pageRefs(owner,repo)).branches.find((b)=>b.name===pull.head)?.oid
  const actionRuns = currentSha ? await actionsForCommit(owner,repo,currentSha):[]

  const latest = new Map<string, string>()
  for (const r of reviews) if(!r.imported) latest.set(r.author, r.verdict)
  const approvals = [...latest].filter(([a, v]) => v === 'approve' && a !== pull.author).map(([a]) => a)
  const changes = [...latest].filter(([, v]) => v === 'changes').map(([a]) => a)
  const queuePos = queue.indexOf(pull.number)
  const adds = diff?.files.reduce((n, f) => n + f.additions, 0) ?? 0
  const dels = diff?.files.reduce((n, f) => n + f.deletions, 0) ?? 0

  const timeline = [
    ...comments.map((c) => ({ at: c.createdAt, node: (
      <article key={c.id} className={s.card}>
        <div className={s.cardHead}><span><strong>{authorLabel(c.author)}</strong> commented {ago(Date.parse(c.createdAt))}</span></div>
        <div className={`${s.cardBody} ${s.readme}`} style={{ padding: '14px 18px' }} dangerouslySetInnerHTML={{ __html: renderMarkdown(c.body) }} />
      </article>
    ) })),
    ...reviews.map((r) => ({ at: r.createdAt, node: (
      <article key={r.id} className={s.card}>
        <div className={s.cardHead}>
          <span><strong>{authorLabel(r.author)}</strong> <span className={r.verdict === 'approve' ? s.stateGood : r.verdict === 'changes' ? s.stateBad : ''}>{VERDICT[r.verdict]}</span> {ago(Date.parse(r.createdAt))}</span>
          {r.headOid && <span className={s.mono}>at {r.headOid.slice(0, 7)}</span>}
        </div>
        {r.body.trim() && <div className={`${s.cardBody} ${s.readme}`} style={{ padding: '14px 18px' }} dangerouslySetInnerHTML={{ __html: renderMarkdown(r.body) }} />}
      </article>
    ) })),
    ...log.map((e, i) => ({ at: e.at, node: (
      <p key={`e${i}`} className={s.event}>
        <strong>@{e.by}</strong> {EVENT[e.kind] ?? e.kind}
        {e.commit ? <> as <span className={s.mono}>{e.commit.slice(0, 7)}</span></> : null}
        {e.files?.length ? <> in <span className={s.mono}>{e.files.join(', ')}</span></> : null} · {ago(Date.parse(e.at))}
      </p>
    ) })),
  ].sort((a, b) => a.at.localeCompare(b.at))

  // The merge box: one sentence for where this pull request stands, and what can happen next.
  let box: { cls: string; title: string; detail: string }
  if (pull.state === 'merged') box = { cls: s.mergeBoxMerged, title: `Merged into ${pull.base}`, detail: `By the merge queue as ${pull.merged?.commit.slice(0, 7)}, ${ago(Date.parse(pull.merged!.at))}.` }
  else if (pull.state === 'closed') box = { cls: '', title: 'Closed without merging', detail: 'Reopen it to continue.' }
  else if (queuePos >= 0) box = { cls: s.mergeBoxQueued, title: `In the merge queue, position ${queuePos + 1}`, detail: `It merges into ${pull.base} after the ones ahead of it.` }
  else if (pull.conflicts) box = { cls: s.mergeBoxBad, title: `Conflicts with ${pull.base}`, detail: `${pull.conflictFiles?.length ? pull.conflictFiles.join(', ') + ' changed on both sides. ' : ''}Merge ${pull.base} into ${pull.head}, push, and queue it again.` }
  else if (changes.length) box = { cls: s.mergeBoxBad, title: `Changes requested by ${changes.map((a) => `@${a}`).join(', ')}`, detail: 'Push a fix, then ask for another review.' }
  else if (approvals.length) box = { cls: '', title: `Approved by ${approvals.map((a) => `@${a}`).join(', ')}`, detail: 'Ready for the merge queue.' }
  else box = { cls: '', title: 'Waiting for review', detail: 'It needs an approval from someone with write access other than the author.' }


  const receipts=await sessionsFor(owner,repo,`pull:${pull.number}`)
  const base = `/${owner}/${repo}/pulls/${pull.number}`
  const glanceHref = (dir?: string) => `${base}?tab=glance${dir ? `&in=${encodeURIComponent(dir)}` : ''}`
  const fileHref = (path: string) => `${glanceHref(sp.in)}&file=${encodeURIComponent(path)}`
  return (
    <div>
      {(healthAfterRead?.noStore||healthBeforeRead?.noStore) ? <meta name="gild-read-cache" content="no-store" /> : null}
      {pull.patchParts ? <p>This imported pull request is closed because its source head is unavailable. <a href={`/api/repos/${owner}/${repo}/import/pulls/${pull.number}/patch`}>Download its original patch</a></p> : null}
      <div className={s.issueHead}>
        <h2 className={s.issueTitle}>{pull.title} <span>#{pull.number}</span></h2>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 14, color: 'var(--ink-dim)' }}>
          <span className={`${s.pill} ${pull.state === 'open' ? s.pillOpen : s.pillClosed}`}>{pull.state === 'open' ? (queuePos >= 0 ? 'In merge queue' : 'Open') : pull.state === 'merged' ? 'Merged' : 'Closed'}</span>
          <span>{authorLabel(pull.author)} wants to merge <span className={s.mono}>{pull.head}</span> into <span className={s.mono}>{pull.base}</span></span>
        </div>
        <nav className={s.subtabs} aria-label="Pull request">
          <Link href={base} className={`${s.tab} ${tab === 'conversation' ? s.tabOn : ''}`}>Conversation</Link>
          <Link href={`${base}?tab=glance`} className={`${s.tab} ${tab === 'glance' ? s.tabOn : ''}`}>Glance</Link>
          <Link href={`${base}?tab=files`} className={`${s.tab} ${tab === 'files' ? s.tabOn : ''}`}>
            Files changed {preparing && <span role="status">· Pending</span>} {diff && <><span className={s.add}>+{adds}</span> <span className={s.del}>−{dels}</span></>}
          </Link>
        </nav>
      </div>

      {tab === 'glance' ? (
        !diff ? <p className={s.note} style={{ paddingBlock: 20 }}>Couldn&apos;t compare these branches. Is <span className={s.mono}>{pull.head}</span> still there?</p>
          : sp.file
            ? <FileView files={diff.files} path={sp.file} backHref={glanceHref(sp.in)} fileHref={fileHref} />
            : <>
                <Glance sizes={diff.sizes} files={diff.files} root={cleanRoot(sp.in, diff.sizes)} what="pull request"
                  zoomHref={glanceHref} fileHref={fileHref} receipts={receipts}/>
                <SessionReceipts receipts={receipts} fileHref={fileHref}/>
                {healthAfter && <HealthReview report={healthAfter} before={healthBefore} beforeName={pull.base}
                  picked={isCategory(sp.cat) ? sp.cat : null}
                  pickHref={(c) => `${glanceHref(sp.in)}&cat=${c}#score`}
                  title="cqx review of this pull request"
                  lede={`The five cqx categories, scored on the pull request's head. Each starts at 100 and loses points only to a named rule. The small line is the change from ${pull.base}.`} />}
              </>
      ) : tab === 'files' ? (
        <div className={s.timeline} style={{ paddingBlock: 20 }}>
          {!diff ? <p className={s.note}>Couldn&apos;t compare these branches. Is <span className={s.mono}>{pull.head}</span> still there?</p>
            : diff.files.length === 0 ? <p className={s.note}>No changes between {pull.base} and {pull.head}.</p>
            : diff.files.slice(0, 60).map((f) => <Diff key={f.path} file={f} />)}
          {diff && diff.total > 60 && <p className={s.muted}>Showing the first 60 of {diff.total} files.</p>}
        </div>
      ) : (
        <div className={s.body}>
          <div className={s.timeline}>
            <article className={s.card}>
              <div className={s.cardHead}><span><strong>{authorLabel(pull.author)}</strong> opened {ago(Date.parse(pull.createdAt))}</span><span className={s.mono}>.gild/{pull.number}/pr/pr.json</span></div>
              <div className={`${s.cardBody} ${s.readme}`} style={{ padding: '14px 18px' }}
                dangerouslySetInnerHTML={{ __html: pull.body.trim() ? renderMarkdown(pull.body) : '<p><em>No description.</em></p>' }} />
            </article>
            <SessionReceipts receipts={receipts} fileHref={fileHref}/>
            {timeline.map((t) => t.node)}

            <div className={`${s.mergeBox} ${box.cls}`}>
              <strong>{box.title}</strong>
              <CommitActions runs={actionRuns} owner={owner} repo={repo} sha={currentSha??''}/>
              <span className={s.muted}>{box.detail}</span>
              {pull.state === 'open' && (
                <div className={s.checks}>
                  <span>{approvals.length ? '✓' : '○'} Approval from someone other than the author</span>
                  <span>{changes.length ? '✗' : '✓'} No open change requests</span>
                  <span>{pull.conflicts ? '✗' : '✓'} {pull.conflicts ? 'Conflicts on the last merge attempt' : 'No conflicts found so far'}</span>
                </div>
              )}

            </div>

            <PublicPullControls owner={owner} repo={repo} pull={{number:pull.number,author:pull.author,state:pull.state,conflicts:pull.conflicts}} queuePos={queuePos} approvals={approvals.length} changes={changes.length}/>
          </div>

          <aside className={s.about} aria-label="Details">
            <div className={s.section}>
              <h2>Reviewers</h2>
              {latest.size === 0 ? <p className={s.muted}>No reviews yet.</p> : [...latest].map(([a, v]) => (
                <div key={a} className={s.person} style={{ justifyContent: 'space-between' }}>
                  <span>@{a}</span>
                  <span className={v === 'approve' ? s.stateGood : v === 'changes' ? s.stateBad : s.muted} style={{ fontWeight: 400, fontSize: 13 }}>{VERDICT[v]}</span>
                </div>
              ))}
            </div>
            <div className={s.section}>
              <h2>Who can merge</h2>
              <p className={s.muted}>People with write access add approved pull requests to the queue; gild does the merge. Authors can&apos;t approve their own.</p>
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
