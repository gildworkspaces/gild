import { repoIndex } from '../repo-index'
import { store } from '../backend'
import { session } from '../session'
import { readSessionReceipts } from './read-access'
/** Viewer access is checked before reading mutable receipt collections. */
export async function sessionsFor(owner: string, repo: string, target: string) {
  return readSessionReceipts({store: await store(), index: repoIndex}, owner, repo, target, (await session())?.name ?? null)
}
