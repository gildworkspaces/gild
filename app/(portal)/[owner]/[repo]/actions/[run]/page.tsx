import { notFound } from 'next/navigation'
import { ActionRun } from '@/components/repo/Actions'
import { runQueue } from '@/lib/actions/service'
import { mayWrite } from '@/lib/access'
import { session } from '@/lib/session'
export default async function RunPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string; run: string }>
}) {
  const { owner, repo, run } = await params
  if (!/^\d+$/.test(run)) notFound()
  const detail = await (await runQueue(owner, repo)).detail(Number(run))
  if (!detail) notFound()
  return (
    <ActionRun
      owner={owner}
      repo={repo}
      initial={detail}
      writer={await mayWrite(owner, (await session())?.name ?? null)}
    />
  )
}
