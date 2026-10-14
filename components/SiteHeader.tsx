import { PublicIdentity } from './PublicViewer'
import Link from '@/components/Link'
import { RepoSearch } from './RepoSearch'
import type { ProfilePicture } from '@/lib/profile'

import { SiteHeaderView } from '../packages/presentation/Headers'

export function SiteHeader({ name, avatar }: { name: string | null; avatar?: ProfilePicture }) {
  return <SiteHeaderView Link={Link} search={<RepoSearch />} identity={<PublicIdentity initial={{name,picture:avatar}} />} />
}
