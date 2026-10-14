import { headers } from 'next/headers'
import { publicActivity } from '@/lib/explore'
import { RepoList } from '@/components/RepoList'
export default async function Explore() {
  const requestHeaders=await headers()
  const { repos, pending } = await publicActivity(requestHeaders.get('x-gild-publication-input') ?? undefined)
  return <section><h1>Explore public repositories</h1>{pending ? <section data-artifact-pending="" role="status"><strong>Pending</strong><p>Public activity is being prepared in the background.</p></section> : <RepoList repos={repos} showOwner />}</section>
}
