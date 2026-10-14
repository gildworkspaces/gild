import type { ReactNode } from 'react'
import type { PageIdentity } from '@/lib/page'
import { Sidebar } from './Sidebar'
import { PortalBar } from './PortalBar'
import { ViewerProvider } from './PublicViewer'
import { RepoIsland } from './repo/RepoIsland'

/** Shared signed-in chrome, resolved before either layout renders. */
export function AccountShell({ identity, children }: { identity: PageIdentity; children: ReactNode }) {
  const sidebar = { name: identity.name, avatar: identity.picture }
  return (
    <ViewerProvider viewer={identity.claimed ? { name: identity.name, picture: identity.picture } : { name: null }}>
      <div style={{ display: 'flex', minHeight: '100vh' }}>
        <RepoIsland kind="sidebar" props={{ identity: sidebar }}><Sidebar identity={sidebar} /></RepoIsland>
        <main className="portal-main">
          <PortalBar />
          {children}
        </main>
      </div>
    </ViewerProvider>
  )
}
