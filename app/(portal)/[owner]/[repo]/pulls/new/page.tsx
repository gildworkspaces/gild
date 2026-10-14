import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { session } from '@/lib/session'
import { pageRefs } from '@/lib/repo-index'
import { NewPullForm } from '@/components/repo/PullForms'

export default async function NewPull({ params, searchParams }: {
  params: Promise<{ owner: string; repo: string }>
  searchParams: Promise<{ head?: string }>
}) {
  const { owner, repo } = await params
  const sp = await searchParams
  const me = await session()
  if (!(await headers()).get('x-gild-publishing') && !me?.name) redirect(`/auth/device?next=${encodeURIComponent(`/${owner}/${repo}/pulls/new`)}`)
  const refs = await pageRefs(owner, repo)
  const branches = refs.branches.map((b) => b.name)
  return <NewPullForm owner={owner} repo={repo} viewerName={me?.name} branches={branches} base={refs.defaultBranch} head={sp.head && branches.includes(sp.head) ? sp.head : branches.find((b) => b !== refs.defaultBranch) ?? ''} />
}
