import { mayRead } from '../repo-read'
import { store } from '../backend'
import { readyIndex } from '../repo-index'
import { caller, capabilities, mayWrite } from '../access'
import { actionEnv, dispatch, runQueue } from './service'
import { actionsAPI as handle, type ActionParams } from './handler'
export type { ActionParams } from './handler'
export async function actionsAPI(request: Request, params: ActionParams) {
  // The read fence precedes acquisition of the RunQueue RPC stub.
  const viewer=await caller(request)
  const runner=/^Bearer (?:gr|gc)_/i.test(request.headers.get('authorization')??'') && params.path?.[0]==='runner'
  if(!runner&&!await mayRead({store:await store(),index:readyIndex},params.owner,params.repo,viewer))return Response.json({error:'Not found'},{status:404,headers:{'cache-control':'private, no-store'}})

  return handle(request, params, {
    caller,
    capabilities,
    mayWrite,
    actionEnv,
    dispatch,
    runQueue,
  })
}
