import Link from '@/components/Link'
import type { PublicCommit } from '@/lib/explore'
import { ago } from '@/lib/time'
import s from '@/app/(marketing)/landing.module.css'

const LANES = ['var(--lane-1)', 'var(--lane-2)', 'var(--lane-3)', 'var(--lane-4)']
const GAP = 30

/** Recent commits across public repos, one lane per author (newest on top).
 *  Authors past the fourth share the last lane rather than widening the graph. */
export function LaneGraph({ commits }: { commits: PublicCommit[] }) {
  const authors: string[] = []
  for (const c of commits) if (!authors.includes(c.author)) authors.push(c.author)
  const lane = (a: string) => Math.min(authors.indexOf(a), LANES.length - 1)
  const lanes = Math.min(authors.length, LANES.length)
  const width = 14 + (lanes - 1) * GAP + 14
  const repos = new Set(commits.map((c) => `${c.owner}/${c.repo}`))

  return (
    <figure className={s.graph} aria-label="Recent commits on gild.gg">
      <div className={s.graphHead}>
        <span>{repos.size === 1 ? [...repos][0] : 'recent pushes on gild.gg'}</span>
        <span className={s.live}>● live</span>
      </div>
      {commits.length === 0 ? (
        <p className={s.empty}>Nothing has been pushed yet. Claim a name, create a repo, and your first commit shows up here.</p>
      ) : (
        commits.map((c) => (
          <Link key={`${c.owner}/${c.repo}@${c.hash}`} href={`/${c.owner}/${c.repo}`} className={s.row}>
            <span className={s.lanes} style={{ width }}>
              {Array.from({ length: lanes }, (_, i) => (
                <span key={i} className={s.lane} style={{ left: 14 + i * GAP, background: LANES[i] }} />
              ))}
              <span className={s.dot} style={{ left: 14 + lane(c.author) * GAP, background: LANES[lane(c.author)] }} />
            </span>
            <span className={s.commit}>
              <span className={s.msg}>{c.message}</span>
              <span className={s.meta}>
                {c.author} · {c.owner}/{c.repo}{c.at ? ` · ${ago(c.at * 1000)}` : ''}
              </span>
            </span>
          </Link>
        ))
      )}
      {authors.length > 0 && (
        <div className={s.graphFoot}>
          {authors.slice(0, LANES.length).map((a, i) => (
            <span key={a}><span style={{ color: LANES[i] }}>●</span> {i === LANES.length - 1 && authors.length > LANES.length ? `${a} + ${authors.length - LANES.length} more` : a}</span>
          ))}
        </div>
      )}
    </figure>
  )
}
