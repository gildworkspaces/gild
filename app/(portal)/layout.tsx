import { headers } from 'next/headers'
import { SiteHeader } from '@/components/SiteHeader'
import { Footer } from '@/components/Footer'
import { ViewerProvider } from '@/components/PublicViewer'
import { pageIdentity } from '@/lib/page'
import { AccountShell } from '@/components/AccountShell'

export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const requestHeaders = await headers()
  const banner = requestHeaders.get('x-gild-archive')
  // One cached read shared with every layout and page of this request; on a
  // repository address the Worker already read it (no round trip here).
  const page = await pageIdentity()

  // Public pages (repos, profiles) are readable signed out; those visitors
  // get the site header instead of a rail full of account links.
  if (!page) {
    return (
      <ViewerProvider viewer={{ name: null }}>
        <SiteHeader name={null} />
        <main style={{ padding: '0 24px 24px', minWidth: 0 }}>
          {banner && (
            <div className="archive-banner" role="status">
              {banner}
            </div>
          )}
          {children}
        </main>
        <Footer />
      </ViewerProvider>
    )
  }

  return (
    <AccountShell identity={page}>
        {banner && (
          <div className="archive-banner" role="status">
            {banner}
          </div>
        )}
        {children}
    </AccountShell>
  )
}
