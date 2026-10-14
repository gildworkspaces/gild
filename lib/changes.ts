// Diff facts are prepared once by RepoIndex's alarm and read by pages.
import { repoIndex } from './repo-index'
import type { FileDiff } from './compare'

export interface Change {
  /** The commit compared against (merge base or parent); null for a root commit. */
  from: string | null
  to: string
  files: FileDiff[]
  truncated: boolean
  total: number
  sizes: { path: string; lines: number }[]
}

export interface CommitChange extends Change {
  commit: { message: string; author: { name: string; timestamp: number }; parent: string | null }
}

export async function commitChange(owner: string, repo: string, sha: string, _ref: string): Promise<CommitChange | null> {
  const change = await (await repoIndex(owner, repo))?.pageChange('commit', sha) as CommitChange | null | undefined
  return change ?? null
}

export async function pullChange(owner: string, repo: string, head: string, base: string): Promise<Change | null> {
  const change = await (await repoIndex(owner, repo))?.pageChange('pull', head, base)
  return change ?? null
}
