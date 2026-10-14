import {AgentPackageEditor} from '@/components/repo/AgentPackageEditor'
import {capabilities} from '@/lib/access'
import {pageViewer} from '@/lib/page'
export const dynamic='force-dynamic'
export default async function PackageProfiles({params}:{params:Promise<{owner:string;repo:string}>}) {
 const {owner,repo}=await params,viewer=await pageViewer()
 const can=await capabilities(owner,repo,viewer?.name??null)
 return <AgentPackageEditor key={`${owner}/${repo}`} owner={owner} repo={repo} canEdit={can.writer}/>
}
