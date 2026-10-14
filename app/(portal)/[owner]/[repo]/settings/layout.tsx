import { SettingsLayout, repoSections } from '@/components/settings/Layout'
import { repoViewer } from '@/lib/settings-view'
export const dynamic = 'force-dynamic'
export default async function Layout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ owner: string; repo: string }>
}) {
  const { owner, repo } = await params
  await repoViewer(owner)
  return (
    <SettingsLayout base={`/${owner}/${repo}/settings`} sections={repoSections}>
      {children}
    </SettingsLayout>
  )
}
