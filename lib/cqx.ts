// Pages read scores produced by RepoIndex's background publication pipeline.
import {pageHealth} from './api/page-health'
import type { Report } from './cqx-report'

export { scoreNote, scoreUnavailable, CATEGORIES, type Category, type Report, type RuleHit } from './cqx-report'
export { UNSCORED } from './cqx-reads'


/** A missing prepared score returns Pending immediately; producers own work. */
export async function scoreCommit(owner: string, repo: string, commit: string): Promise<Report | null> {
  return (await pageHealth(owner,repo,commit)).report
}
export const scoreRead=pageHealth

export async function scoreHead(owner: string, repo: string, _ref: string, commit: string) {
  return scoreCommit(owner, repo, commit)
}
