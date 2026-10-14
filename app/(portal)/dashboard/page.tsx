import Link from '@/components/Link'
import { session } from '@/lib/session'
import { repoList } from '@/lib/repo-list'
import { RepoList } from '@/components/RepoList'
import { store } from '@/lib/backend'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const s = await session()
  const st = await store()
  const orgs = s?.name ? await st.orgsFor(s.name) : []
  const repos = s?.name ? await repoList(s.name, s.name) : []
  const orgRepos = await Promise.all(orgs.map(async (o) => ({ org: o, repos: await repoList(o.name, s?.name ?? null) })))

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
        <h1 style={{ fontSize: 22, margin: '0 0 8px' }}>repos</h1>
        {s?.name && (
          <span style={{ fontSize: 13 }}>
            <Link href="/new" style={{ color: 'var(--accent)' }}>new repo</Link>
            {' · '}
            <Link href="/new/org" style={{ color: 'var(--accent)' }}>new org</Link>
          </span>
        )}
      </div>
      {!s?.name && (
        <p style={{ color: 'var(--ink-soft)', fontSize: 14 }}>
          Sign in (and claim a name) to see your repositories.
        </p>
      )}
      {s?.name && repos.length === 0 && orgRepos.every((g) => g.repos.length === 0) && (
        <p style={{ color: 'var(--ink-soft)', fontSize: 14 }}>
          Nothing here yet — <Link href="/new" style={{ color: 'var(--accent)' }}>create your first repo</Link>.
        </p>
      )}

      {repos.length > 0 && (
        <>
          <h2 className="eyebrow">@{s!.name}</h2>
          <RepoList repos={repos} showOwner />
        </>
      )}

      {orgRepos.map(({ org, repos: oRepos }) => (
        <div key={org.name}>
          <h2 className="eyebrow">
            <Link href={`/${org.name}`} style={{ color: 'inherit' }}>@{org.name}</Link>
            <span className="mono-dim" style={{ marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>{org.role}</span>
          </h2>
          {oRepos.length === 0 ? (
            <p style={{ color: 'var(--ink-soft)', fontSize: 13, marginTop: 4 }}>no repos yet</p>
          ) : (
            <RepoList repos={oRepos} showOwner />
          )}
        </div>
      ))}
    </>
  )
}
