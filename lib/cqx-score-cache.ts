import { BUILD } from './cqx-version.ts'
import { READS_VERSION } from './cqx-reads.ts'

// The web and API scorers share the same immutable input and cache namespace.
export const scoreCacheKey = (owner: string, repo: string, commit: string) =>
  `${owner}/${repo}@${commit}#${BUILD}:${READS_VERSION}`
