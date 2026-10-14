import { profileView } from '@/lib/profile-view'
import { notFound } from 'next/navigation'
import { orgViewer } from '@/lib/settings-view'
import { ProfileForm, Members, DangerZone } from '@/components/settings/forms'
import { Webhooks } from '@/components/repo/Webhooks'
import { billingPage } from '@/lib/hosted/billing'
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; section: string }>
  searchParams: Promise<{ repo?: string }>
}) {
  const { org, section } = await params,
    v = await orgViewer(org),
    state = await v.st.settings.state(org)
  if (section === 'general')
    return (
      <>
        <ProfileForm
          name={org}
          org
          resolvedPicture={(await profileView(v.st, org, true)).picture}
          initial={{
            ...(await v.st.settings.profile(org)),
            description:
              (await v.st.settings.profile(org)).description ||
              v.organization.description ||
              '',
          }}
          disabled={state.archived || state.moving}
        />
        {v.role === 'owner' && (
          <DangerZone kind="organization" name={org} state={state} />
        )}
      </>
    )
  if (section === 'billing') {
    if (v.role !== 'owner') notFound()
    if (!billingPage) notFound()
    return await billingPage(org, (await searchParams).repo ?? null)
  }
  if (section === 'members')
    return (
      <Members
        org={org}
        role={v.role}
        viewer={v.claim.name}
        initial={await v.st.orgMembers(org)}
        pictures={Object.fromEntries(
          await Promise.all(
            (await v.st.orgMembers(org)).map(async (m) => [
              m.member,
              (await profileView(v.st, m.member)).picture,
            ]),
          ),
        )}
        disabled={state.archived || state.moving}
      />
    )
  if (section === 'webhooks')
    return (
      <Webhooks owner={org} org disabled={state.archived || state.moving} />
    )
  notFound()
}
