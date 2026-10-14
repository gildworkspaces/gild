'use client'
import { usePublicViewer } from '../PublicViewer'
import Link from '@/components/Link'
import { usePathname } from 'next/navigation'
import { RepoTabsView } from '../../packages/presentation/Headers'
export function RepoTabs({ base, tabs, write, contributor }: { base: string; tabs: { label: string; path: string; count?: number }[]; write?: boolean; contributor?: boolean }) {
  const viewer = usePublicViewer(base.slice(1))
  return <RepoTabsView base={base} tabs={tabs} here={usePathname()} write={write || viewer.write} contributor={contributor || viewer.contributor} Link={Link} />
}
