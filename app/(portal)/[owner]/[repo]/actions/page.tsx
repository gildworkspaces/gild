import { RepoIsland } from '@/components/repo/RepoIsland'
import { ActionsBoard } from '@/components/repo/Actions'
import { runQueue, pageWorkflows } from '@/lib/actions/service'
import { tipOf } from '@/lib/repo'
import { pageRefs } from '@/lib/repo-index'
import { PreparingRepository } from '@/components/repo/PreparingRepository'
import { stillPreparing } from '@/lib/status-pages'
export default async function ActionsPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>
}) {
  const { owner, repo } = await params
  // Two independent chains, started together: the moving branch tip resolves
  // to a commit whose parsed workflows are kept by hash, while the live run
  // list is one RunQueue call. Write controls hydrate from the viewer island.
  const prepared = await Promise.all([
    pageRefs(owner, repo).then(async (refs) => {
      const sha = tipOf(refs, refs.defaultBranch)
      return { refs, workflows: sha ? await pageWorkflows(owner, repo, sha) : [] }
    }),
    runQueue(owner, repo).then((q) => q.overview()),
  ]).catch(error => {
    if (!stillPreparing(error)) throw error
    return null
  })
  // Preparation is queued by the cache reader. Keep the authorized parent
  // layout and navigation intact while its immutable workflow view is absent.
  if (!prepared) return <PreparingRepository />
  const [{ refs, workflows }, view] = prepared
  const props = {
    owner, repo, initial: view,
    workflows: workflows.map((w) => ({
      file: w.file, name: w.name, error: w.error,
      dispatch: Boolean(w.triggers.workflow_dispatch),
    })),
    branches: refs.branches.map((b) => b.name),
    defaultBranch: refs.defaultBranch,
  }
  return <RepoIsland kind="actions" props={props}><ActionsBoard {...props}/></RepoIsland>
}
