import { RepoInvitations } from '@/components/settings/Privacy'
import { profileView } from '@/lib/profile-view'
import { notFound } from 'next/navigation'
import Link from '@/components/Link'
import { settingsViewer } from '@/lib/settings-view'
import { ProfileForm, Organizations, Tokens } from '@/components/settings/forms'
import { AccountRunners } from '@/components/settings/Actions'
import { fingerprint } from '@/lib/fingerprint'
import { listRepos } from '@/lib/artifacts'
import { runQueue } from '@/lib/actions/service'
import { RESTORE_MS } from '@/lib/settings-store'
import s from '@/components/settings/settings.module.css'
import { billingPage } from '@/lib/hosted/billing'
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ section: string }>
  searchParams: Promise<{ repo?: string }>
}) {
  const { section } = await params,
    v = await settingsViewer(),
    name = v.claim.name
  if(section==='invitations')return <RepoInvitations />
  if (section === 'billing') return billingPage ? await billingPage(name, (await searchParams).repo ?? null) : notFound()
  if (section === 'profile')
    return (
      <ProfileForm
        name={name}
        initial={v.account.profile}
        resolvedPicture={v.account.picture}
        email={v.claim.email}
      />
    )
  if (section === 'organizations') {
    const orgs = await v.st.orgsFor(name),
      organizations = await Promise.all(
        orgs.map(async (o) => {
          const { profile, picture } = await profileView(v.st, o.name, true),
            members = await v.st.orgMembers(o.name)
          return {
            ...o,
            displayName: profile.displayName,
            picture,
            lastOwner:
              o.role === 'owner' &&
              members.filter((m) => m.role === 'owner').length === 1,
            archived: (await v.st.settings.state(o.name)).archived,
          }
        }),
      )
    const deleted = []
    for (const state of await v.st.settings.states())
      if (
        state.deletedAt !== null &&
        state.deletedAt + RESTORE_MS > Date.now() &&
        (state.key.split('/')[0] === name ||
          (await v.st.orgRole(state.key.split('/')[0], name)) === 'owner')
      )
        deleted.push(state)
    return <Organizations organizations={organizations} deleted={deleted} />
  }
  if (section === 'keys')
    return (
      <>
        <h1>Keys &amp; devices</h1>
        <div className={s.table}>
          <div className={s.row}>
            <div className={s.grow}>
              <strong>Ed25519 key</strong>
              <div className={s.fingerprint}>
                {v.claim.publicKey.startsWith('ed25519:') ? await fingerprint(v.claim.publicKey) : 'No device key yet'}
              </div>
              <div className={s.dim}>
                Added {new Date(v.claim.claimedAt).toLocaleDateString('en-CA')}
              </div>
            </div>
          </div>
        </div>
      </>
    )
  if (section === 'tokens')
    return <Tokens initial={await v.st.listApiTokens(name)} />
  if (section === 'agents') {
    const agents = await v.st.agentsFor(name)
    return (
      <>
        <h1>Agents</h1>
        <div className={s.table}>
          {agents.map((a) => (
            <div className={s.row} key={a.name}>
              <div className={s.grow}>
                <strong>@{a.name}</strong>
                <div className={s.dim}>
                  {a.revokedAt
                    ? 'Revoked'
                    : a.approver
                      ? 'Approver'
                      : 'Sponsored agent'}{' '}
                  · Added {new Date(a.createdAt).toLocaleDateString('en-CA')}
                </div>
              </div>
            </div>
          ))}
          {!agents.length && <div className={s.row}>No sponsored agents</div>}
        </div>
        <Link className={s.button} href="/agents" style={{ marginTop: 20 }}>
          Manage agents
        </Link>
      </>
    )
  }
  if (section === 'runners') {
    const owners = [name, ...v.organizations.map((o) => o.name)],
      repositories = (
        await Promise.all(
          owners.map(async (owner) =>
            Promise.all(
              (await listRepos(owner)).map(async (r) => ({
                name: `${owner}/${r.name}`,
                runners: (await (await runQueue(owner, r.name)).overview())
                  .runners,
              })),
            ),
          ),
        )
      ).flat()
    return <AccountRunners repositories={repositories} />
  }
  notFound()
}
