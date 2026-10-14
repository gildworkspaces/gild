import { z } from 'zod'
import { sessionState } from '../api/sessions-contract.ts'
export const channelState = sessionState
export type ChannelState = z.output<typeof channelState>
export { stateLabel } from './label.ts'
