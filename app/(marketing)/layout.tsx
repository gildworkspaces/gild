import { Footer } from '@/components/Footer'
import { SiteHeader } from '@/components/SiteHeader'
import { AccountShell } from '@/components/AccountShell'
import { pageIdentity } from '@/lib/page'
export default async function MarketingLayout({ children }: { children: React.ReactNode }) {
  const identity = await pageIdentity()
  if (identity) return <AccountShell identity={identity}>{children}</AccountShell>
  return <><SiteHeader name={null}/><main>{children}</main><Footer/></>
}
