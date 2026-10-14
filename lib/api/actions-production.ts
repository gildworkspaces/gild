import { runnerPool } from '../actions/pool-service'
import { actionHandler } from './actions.ts'
import { runQueue, dispatch, actionEnv } from '../actions/service.ts'
import { mayWrite } from '../access.ts'
export const apiActions = actionHandler({
  inheritedRunners: async (owner, repo) =>
    (await (await runnerPool(owner)).overview(`${owner}/${repo}`)).runners,
  runQueue,
  dispatch,
  actionEnv,
  mayWrite,
})
