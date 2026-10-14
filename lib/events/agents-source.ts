import type { AgentRequest } from '../backend.ts'
import type { Emission } from '../api/events-contract.ts'
import { common } from './payloads.ts'
export function agentEvent(
  request: AgentRequest,
  action: 'opened' | 'approved' | 'denied',
  by: string,
): Emission {
  const { publicKey, tokenIssued, ...safe } = request
  return {
    id: `agent-request:${request.id}:${action}`,
    event: 'agent_request',
    repository: request.repo,
    audience: request.sponsor,
    payload: {
      ...(request.repo ? common(request.repo, by) : {}),
      action,
      agent: `${request.sponsor}/${request.label}`,
      request: safe,
    },
  }
}
