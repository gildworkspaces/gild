import { RunnerPanel } from '@/components/settings/Runners'
import { orgViewer, settingsViewer, repoViewer } from '../settings-view'
import { listRepos } from '../artifacts'
import { mayRead } from '../repo-read'
import { readyIndex } from '../repo-index'
export async function runnersPage(
  owner: string | undefined,
  view: 'runners' | 'runner-groups',
  path: string[] = [],
  repo?: string,
  group?: string,
) {
  const viewer = repo
      ? await repoViewer(owner!)
      : owner
        ? await orgViewer(owner)
        : await settingsViewer(),
    name = owner ?? viewer.claim.name,
    kind = (await viewer.st.getOrg(name)) ? 'org' : 'user',
    base = repo
      ? `/${name}/${repo}/settings`
      : owner
        ? `/orgs/${name}/settings`
        : '/settings'
  const repositories =
    view === 'runner-groups'
      ? await Promise.all(
          (await listRepos(name)).map(async (r) => ({
            name: r.name,
            private: !(await mayRead(
              { store: viewer.st, index: readyIndex },
              name,
              r.name,
              null,
            )),
          })),
        )
      : []
  return (
    <RunnerPanel
      owner={name}
      kind={kind}
      repo={repo}
      base={base}
      view={view}
      path={path}
      repositories={repositories}
      initialGroup={group}
    />
  )
}
