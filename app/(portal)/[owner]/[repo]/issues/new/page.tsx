import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { session } from '@/lib/session'
import { NewIssueForm } from '@/components/repo/IssueForms'

export default async function NewIssue({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  const { owner, repo } = await params
  const me = await session()
  if (!(await headers()).get('x-gild-publishing') && !me?.name) redirect(`/auth/device?next=${encodeURIComponent(`/${owner}/${repo}/issues/new`)}`)
  return <NewIssueForm owner={owner} repo={repo} viewerName={me?.name} />
}
