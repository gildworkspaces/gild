import { getCloudflareContext } from '@opennextjs/cloudflare'
import { repoIslands } from '@/lib/repo-islands'
import type { ChannelEnv } from '@/lib/channel/initial'
import { actionsForCommit } from '@/lib/actions/service'
import { sessionsFor } from '@/lib/sessions/read'
import { ApiError } from '@/lib/api/errors'
export async function GET(request:Request,{params}:{params:Promise<{owner:string;repo:string}>}) {
  const {owner,repo}=await params,{env}=await getCloudflareContext()
  try {
    const result=await repoIslands(request,env as unknown as ChannelEnv,owner,repo)
    const sha=new URL(request.url).searchParams.get('commit')
    const at=performance.now()
    const [runs,receipts]=sha && /^[a-f0-9]{40}$/.test(sha) ? await Promise.all([actionsForCommit(owner,repo,sha),sessionsFor(owner,repo,`commit:${sha}`)]) : [[],[]]
    return Response.json({...result.data,runs,receipts},{headers:{'cache-control':'private, no-store','server-timing':result.timing+`, commit_data;dur=${(performance.now()-at).toFixed(2)}`}})
  } catch(e){if(e instanceof ApiError)return new Response('Not found',{status:e.status,headers:{'cache-control':'private, no-store'}});throw e}
}
