import { ImportStatus } from '@/components/ImportStatus'
import { store } from '@/lib/backend'
import { mayRead } from '@/lib/repo-read'
import { session } from '@/lib/session'
import { notFound } from 'next/navigation'
import { mayWrite } from '@/lib/access'
// Progress must remain available while the code/metadata projection is pending.
// Imports publish authoritative ACL snapshots from creation and every batch.
export default async function Page({params}:{params:Promise<{owner:string;repo:string}>}) {
  const {owner,repo}=await params
  const name=(await session())?.name??null
  if(!await mayRead({store:await store(),index:async()=>null},owner,repo,name))notFound()
  return <ImportStatus owner={owner} repo={repo} canManage={await mayWrite(owner,name)} />
}
