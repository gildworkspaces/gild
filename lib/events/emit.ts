import { getCloudflareContext } from '@opennextjs/cloudflare'
import { hubFrom, type EventBindings } from './binding.ts'
export type { Hub, EventBindings } from './binding.ts'
export async function hub() {
  return hubFrom((await getCloudflareContext()).env as unknown as EventBindings)
}
