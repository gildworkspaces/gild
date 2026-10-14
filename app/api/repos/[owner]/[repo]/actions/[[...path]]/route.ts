import {legacy} from '@/lib/api/legacy'
import {matchRequest} from '@/lib/api/routing'
import { actionsAPI, type ActionParams } from '@/lib/actions/api'
type Ctx = { params: Promise<ActionParams> }
async function route(request: Request, ctx: Ctx) {
  const params=await ctx.params
  if(params.path?.[0]==='secrets' || params.path?.[0]==='settings'){const found=matchRequest(request.method,new URL(request.url).pathname);if(found)return legacy(request,found.route.id,found.params)}
  return actionsAPI(request, params)
}
export { route as GET, route as POST, route as PUT, route as DELETE }
