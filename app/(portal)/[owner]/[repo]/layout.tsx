import { store } from '@/lib/backend'
import { repoContext } from '@/lib/repo-context'
import { pageReads, pageViewer, pageIdentity } from '@/lib/page'
import { StarButton } from '@/components/repo/StarButton'
import { RepoViewerProvider } from '@/components/PublicViewer'
import { mayWrite } from '@/lib/access'
import Link from '@/components/Link'
import { notFound } from 'next/navigation'
import { repoInfo } from '@/lib/artifacts'
import { CloneButton } from '@/components/repo/CloneButton'
import { RepoTabs } from '@/components/repo/RepoTabs'
import { readIndex, readMetaFile } from '@/lib/metastore'
import s from './repo.module.css'
import { RepoHeaderView, repoTabs } from '../../../../packages/presentation/Headers'
import { PreparingRepository } from '@/components/repo/PreparingRepository'
import { stillPreparing } from '@/lib/status-pages'

export default async function RepoLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ owner: string; repo: string }>
}) {
  const { owner, repo } = await params
  const st = await store()
  // One D1 batch for policy, viewer, state, stars and role (read by the
  // Worker's privacy step and handed over, or read here once); the index and
  // metadata start alongside it. The policy decides 404 before data is used.
  const ctx = await repoContext({
    store: st,
    reads: (o, r) => pageReads(o, r),
    viewer: pageViewer,
    // Only a repo that really doesn't exist is a 404: a passing API error is
    // retried once, and a second failure is an error page, not "not found".
    info: (o, r) => repoInfo(o, r).catch(async (e) => {
      if (/not found/i.test(String((e as Error)?.message))) return null
      return repoInfo.uncached(o, r).catch((e2) => {
        if (/not found/i.test(String((e2 as Error)?.message))) return null
        throw e2
      })
    }),
    // `_meta` reads go through the page's one-RPC bundle, kept per commit.
    index: async (o, r) => ({ metaFile: (path: string) => readMetaFile(o, r, path) }),
    readIndex,
    mayWrite,
  }, owner, repo).catch(error => {
    if (!stillPreparing(error)) throw error
    return undefined
  })
  if (ctx === undefined) return <PreparingRepository />
  if (!ctx) notFound()
  const { info, viewer, state, stars: count, starred, acl, imported, index, write, contributor } = ctx
  const identity = await pageIdentity()
  const tabs = repoTabs(index.issues.filter((i) => i.state === 'open').length, index.pulls.filter((p) => p.state === 'open').length)

  return (
    <RepoViewerProvider repository={`${owner}/${repo}`} value={{ name: viewer, write, contributor, count, starred }}>
    <script id="gild-islands" type="application/json" dangerouslySetInnerHTML={{ __html: JSON.stringify({ repository: `${owner}/${repo}`, name: viewer, picture: identity?.picture, write, contributor, count, starred }).replaceAll('<', '\\u003c') }} />
    <div className={s.page} data-repository={`${owner}/${repo}`}>
      {imported && <p>Imported from <a href={imported.url}>{imported.url}</a>{imported.readOnly?' · source retained as a read-only reference':imported.mirror?' · mirroring source':''} <Link href={`/${owner}/${repo}/import`}>Import summary</Link></p>}
      <RepoHeaderView Link={Link} owner={owner} repo={info.name} privateRepo={acl.visibility === 'private' || !!acl.private} archived={state.archived}
        tabs={<RepoTabs base={`/${owner}/${repo}`} tabs={tabs} write={write} contributor={contributor} />}
        actions={<><StarButton owner={owner} repo={repo} count={count} starred={starred} signedIn={!!viewer} /><CloneButton owner={owner} repo={repo} /></>} />
      <div data-page-body="">{children}</div>
    </div>
    </RepoViewerProvider>
  )
}
