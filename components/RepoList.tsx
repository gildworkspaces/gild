import Link from '@/components/Link'
import type { RepoRow } from '@/lib/repo-list'
import { updatedAgo } from '@/lib/time'
import { sparklinePoints } from '@/lib/repo-summary'
import s from './repo-list.module.css'

export function RepoList({
  repos,
  showOwner = false,
}: {
  repos: RepoRow[]
  showOwner?: boolean
}) {
  return (
    <div className={s.list}>
      {repos.map((r) => {
        const base = `/${r.owner}/${r.name}`
        const commits = r.activity?.reduce((sum, n) => sum + n, 0)
        return (
          <article key={base} className={s.row}>
            <div className={s.details}>
              <div className={s.heading}>
                <Link href={base}>
                  {showOwner ? `${r.owner}/` : ''}
                  {r.name}
                </Link>
                <span className={s.chip}>{r.visibility}</span>
                {r.archived && <span className={s.chip}>archived</span>}
              </div>
              {r.description && <p>{r.description}</p>}
              <div className={s.meta}>
                {r.score !== null && (
                  <Link className={s.score} href={`${base}/score`}>
                    cqx {r.score}
                  </Link>
                )}
                {r.note && <span>{r.note}</span>}
                {r.language && (
                  <span>
                    <i style={{ background: r.language.color }} />
                    {r.language.name}
                  </span>
                )}
                <span aria-label={`${r.stargazers_count} stars`}>
                  ☆ {r.stargazers_count.toLocaleString('en-US')}
                </span>
                {r.license && <span>{r.license}</span>}
                <Link href={`${base}/issues`}>
                  {r.issues} open {r.issues === 1 ? 'issue' : 'issues'}
                </Link>
                <Link href={`${base}/pulls`}>
                  {r.pulls} open {r.pulls === 1 ? 'PR' : 'PRs'}
                </Link>
                {r.updated !== null && (
                  <time
                    dateTime={new Date(r.updated).toISOString()}
                    title={new Date(r.updated).toUTCString()}
                  >
                    Updated {updatedAgo(r.updated)}
                  </time>
                )}
              </div>
            </div>
            {r.activity && (
              <svg
                className={s.activity}
                viewBox="0 0 156 40"
                role="img"
                aria-label={`${commits} commits in the last year`}
              >
                {/* One string: React renders a multi-part <title> as empty on the server
                    and then fails hydration (#418, gild-site#66). */}
                <title>{`${commits} commits in the last year`}</title>
                <polyline
                  points={sparklinePoints(r.activity)}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </article>
        )
      })}
    </div>
  )
}
