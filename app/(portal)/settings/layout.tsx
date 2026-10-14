import {
  SettingsHeader,
  SettingsLayout,
  accountSections,
} from '@/components/settings/Layout'
import { settingsViewer } from '@/lib/settings-view'
import { billingPage } from '@/lib/hosted/billing'
export const dynamic = 'force-dynamic'
export default async function Layout({
  children,
}: {
  children: React.ReactNode
}) {
  const v = await settingsViewer()
  return (
    <>
      <SettingsHeader
        name={v.claim.name}
        kind="Account"
        profile={v.account.profile}
        picture={v.account.picture}
        account={v.claim.name}
        accountPicture={v.account.picture}
        organizations={v.organizations}
      />
      <SettingsLayout base="/settings" sections={billingPage ? accountSections : accountSections.filter(s => s.key !== 'billing')}>
        {children}
      </SettingsLayout>
    </>
  )
}
