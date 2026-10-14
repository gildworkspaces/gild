import {
  SettingsHeader,
  SettingsLayout,
  orgSections,
  OrgTabs,
} from '@/components/settings/Layout'
import { orgViewer } from '@/lib/settings-view'
import { billingPage } from '@/lib/hosted/billing'
import { profileView } from '@/lib/profile-view'
import { listRepos } from '@/lib/artifacts'
export const dynamic = 'force-dynamic'
export default async function Layout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ org: string }>
}) {
  const { org } = await params,
    v = await orgViewer(org),
    [repos, members, view] = await Promise.all([listRepos(org), v.st.orgMembers(org), profileView(v.st, org, true)])
  return (
    <>
      <SettingsHeader
        name={org}
        kind="Organization"
        profile={view.profile}
        picture={view.picture}
        account={v.claim.name}
        accountPicture={v.account.picture}
        organizations={v.organizations}
      />
      <OrgTabs
        name={org}
        repositories={repos.length}
        people={members.length}
        settings
      />
      <SettingsLayout base={`/orgs/${org}/settings`} sections={billingPage ? orgSections : orgSections.filter(s => s.key !== 'billing')}>
        {children}
      </SettingsLayout>
    </>
  )
}
