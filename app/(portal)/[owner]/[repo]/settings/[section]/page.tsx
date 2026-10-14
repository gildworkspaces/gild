import { RepoPrivacy } from '@/components/settings/Privacy'
import { repoAccess, privateAcl } from '@/lib/repo-read'
import { repoIndex } from '@/lib/repo-index'
import { notFound } from 'next/navigation'
import { repoViewer } from '@/lib/settings-view'
import { RepoGeneral } from '@/components/settings/forms'
import { ActionsSettings } from '@/components/settings/Actions'
import { Webhooks } from '@/components/repo/Webhooks'
import { pageRefs } from '@/lib/repo-index'
import { repoInfo } from '@/lib/artifacts'
import { runQueue, actionEnv } from '@/lib/actions/service'
import { secretNames } from '@/lib/actions/secrets'
export default async function Page({
  params,
}: {
  params: Promise<{ owner: string; repo: string; section: string }>
}) {
  const { owner, repo, section } = await params,
    v = await repoViewer(owner),
    state = await v.st.settings.state(`${owner}/${repo}`),
    orgState = await v.st.settings.state(owner),
    disabled =
      state.archived || orgState.archived || state.moving || orgState.moving
  if(section==='access') {
    const access=await repoAccess({store:v.st,index:repoIndex},owner,repo)
    return <RepoPrivacy owner={owner} repo={repo} visibility={access&&privateAcl(access.acl)?'private':'public'} disabled={disabled} />
  }
  if (section === 'general') {
    const info = await repoInfo(owner, repo)
    return (
      <RepoGeneral
        owner={owner}
        repo={repo}
        description={info.description}
        defaultBranch={info.default_branch}
        branches={(await pageRefs(owner, repo)).branches.map((b) => b.name)}
        state={state}
        disabled={disabled}
        ownerRole={v.role === 'owner'}
      />
    )
  }
  if (section === 'actions') {
    const overview = await (await runQueue(owner, repo)).overview()
    return (
      <ActionsSettings
        owner={owner}
        repo={repo}
        kind={await v.st.getOrg(owner)?'org':'user'}
        initialRequired={overview.settings.required}
        runners={overview.runners}
        initialSecrets={await secretNames(
          await actionEnv(),
          `${owner}/${repo}`,
        )}
        disabled={disabled}
      />
    )
  }
  if (section === 'webhooks')
    return <Webhooks owner={owner} repo={repo} disabled={disabled} />
  notFound()
}
