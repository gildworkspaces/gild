import { Suspense } from 'react'
import { PublicOwnerControls } from '@/components/PublicOwnerControls'
import { Picture } from '@/components/Picture'
import { profileView } from '@/lib/profile-view'
import { SettingsHeader, OrgTabs } from '@/components/settings/Layout'
import styles from '@/components/settings/settings.module.css'
import Link from '@/components/Link'
import { notFound } from 'next/navigation'
import { runnerStatus } from '@/lib/actions/store'
import { repoList } from '@/lib/repo-list'
import { RepoList } from '@/components/RepoList'
import { runQueue } from '@/lib/actions/service'
import { store } from '@/lib/backend'
import { session } from '@/lib/session'


export default async function OwnerPage({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string }>
  searchParams: Promise<{ tab?: string }>
}) {
  const { owner } = await params
  const { tab } = await searchParams
  const st = await store()
  const [org, s] = await Promise.all([st.getOrg(owner), session()])

  if (!org) {
    // A person: their claimed name and their repos. A name nobody has
    // claimed and that holds no repos is a 404, not an empty page.
    const [claim, repos] = await Promise.all([
      st.getClaim(owner),
      repoList(owner, s?.name ?? null),
    ])
    if (!claim && repos.length === 0) notFound()
    const mine = s?.name === owner.toLowerCase()
    const view = await profileView(st, owner)
    return (
      <>
        <div className={styles.header}>
          <Picture name={owner} picture={view.picture} />
          <div>
            <h1 style={{ fontSize: 24, margin: 0 }}>
              {view.profile.displayName || '@' + owner.toLowerCase()}
            </h1>
            <span className={styles.kind}>@{owner} · Account</span>
          </div>
        </div>
        <PublicProfile profile={view.profile} />

        <h2 className="eyebrow">repos</h2>
        {repos.length === 0 && (
          <p style={{ color: 'var(--ink-soft)', fontSize: 14 }}>
            No repos yet
            {mine && (
              <>
                {' '}
                —{' '}
                <Link href="/new" style={{ color: 'var(--accent)' }}>
                  create the first one
                </Link>
              </>
            )}
            .
          </p>
        )}
        <RepoList repos={repos} />
        <Suspense fallback={null}><PublicOwnerControls owner={owner.toLowerCase()}/></Suspense>
      </>
    )
  }

  // Every read starts as soon as its inputs exist; none waits for an
  // unrelated one (the repository list is the longest chain).
  const membersP = st.orgMembers(org.name), reposP = repoList(org.name, s?.name ?? null)
  const [members, repos, memberProfiles, runners, { profile, picture }, organizations, myRole, accountPicture] = await Promise.all([
    membersP,
    reposP,
    membersP.then((members) => Promise.all(
      (tab === 'people' ? members : members.slice(0, 12)).map(async (m) => ({
        ...m,
        ...(await profileView(st, m.member)),
      })),
    )),
    tab
      ? []
      : reposP.then((repos) => Promise.all(repos.map(async (r) => (await (await runQueue(org.name, r.name)).overview()).runners))).then((r) => r.flat()),
    profileView(st, org.name, true),
    s?.name
      ? st.orgsFor(s.name).then((orgs) => Promise.all(
          orgs.filter((o) => o.role !== 'member').map(async (o) => ({ ...o, ...(await profileView(st, o.name, true)) })),
        ))
      : [],
    s?.name ? st.orgRole(org.name, s.name) : null,
    s?.name ? profileView(st, s.name).then((p) => p.picture) : undefined,
  ])

  return (
    <>
      <SettingsHeader
        name={org.name}
        kind="Organization"
        profile={profile}
        picture={picture}
        accountPicture={accountPicture}
        account={s?.name ?? ''}
        organizations={organizations}
      />
      <OrgTabs
        name={org.name}
        repositories={repos.length}
        people={members.length}
        settings={myRole === 'owner' || myRole === 'admin'}
      />
      {tab === 'people' ? (
        <>
          <h2 className="eyebrow">People</h2>
          <div className={styles.table}>
            {members.map((m) => (
              <div key={m.member} className={styles.row}>
                <Picture
                  name={m.member}
                  picture={
                    memberProfiles.find((p) => p.member === m.member)?.picture
                  }
                />
                <Link className={styles.grow} href={`/${m.member}`}>
                  @{m.member}
                </Link>
                <span className={styles.dim}>{m.role}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className={tab === 'repositories' ? styles.repositories : styles.overview}>
          <section className={styles.repoColumn}>
            <div className={styles.overviewHeading}>
              <h2>Repositories</h2>
              {(myRole === 'owner' || myRole === 'admin') && (
                <Link
                  className={`${styles.button} ${styles.primary}`}
                  href={`/new?owner=${org.name}`}
                >
                  ＋ New repo
                </Link>
              )}
            </div>
            {!repos.length && <p className={styles.dim}>No repos yet.</p>}
            <RepoList repos={repos} />
          </section>
          {tab !== 'repositories' && (
            <aside className={styles.orgAside}>
              <PublicProfile
                profile={{
                  ...profile,
                  description: profile.description || org.description || '',
                }}
              />
              <section>
                <h2>
                  <Link href={`/${org.name}?tab=people`}>People</Link>
                </h2>
                <div className={styles.peopleAvatars}>
                  {memberProfiles.map((m) => (
                    <Link
                      key={m.member}
                      href={`/${m.member}`}
                      title={'@' + m.member}
                    >
                      <Picture name={m.member} picture={m.picture} />
                    </Link>
                  ))}
                </div>
              </section>
              {!!runners.length && (
                <section>
                  <h2>Runners</h2>
                  <span className={styles.dim}>
                    {
                      runners.filter((r) => runnerStatus(r) !== 'Offline')
                        .length
                    }{' '}
                    online ·{' '}
                    {runners.filter((r) => runnerStatus(r) === 'Busy').length}{' '}
                    busy
                  </span>
                </section>
              )}
            </aside>
          )}
        </div>
      )}
    </>
  )
}

function PublicProfile({
  profile,
}: {
  profile: import('@/lib/settings-store').Profile
}) {
  return (
    <div className={styles.profileInfo}>
      {profile.description && <p>{profile.description}</p>}
      {profile.publicEmail && (
        <a href={'mailto:' + profile.publicEmail}>{profile.publicEmail}</a>
      )}
      {profile.url && (
        <a href={profile.url} rel="nofollow">
          {profile.url}
        </a>
      )}
      {profile.socialLinks.map((link) => (
        <a href={link} key={link} rel="nofollow">
          {link}
        </a>
      ))}
      {profile.location && <span>{profile.location}</span>}
    </div>
  )
}
