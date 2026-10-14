import { profileView } from './profile-view'
import { store } from './backend'
import { session } from './session'
import { notFound } from 'next/navigation'
import { orgAccess, repoAccess } from './settings'
export async function settingsViewer() {
  const st = await store(),
    me = await session()
  if (!me?.name || me.name.includes('/')) notFound()
  const claim = await st.getClaim(me.name)
  if (!claim) notFound()
  const orgs = await st.orgsFor(me.name),
    organizations = await Promise.all(
      orgs
        .filter((o) => o.role !== 'member')
        .map(async (o) => ({
          ...o,
          ...(await profileView(st, o.name, true)),
        })),
    )
  return {
    st,
    me,
    claim,
    organizations,
    account: await profileView(st, claim.name),
  }
}
export async function orgViewer(org: string) {
  const viewer = await settingsViewer()
  let role
  try {
    role = await orgAccess(viewer.st, org, viewer.claim.name)
  } catch {
    notFound()
  }
  const organization = await viewer.st.getOrg(org)
  if (!organization) notFound()
  return { ...viewer, role, organization }
}
export async function repoViewer(owner: string) {
  const viewer = await settingsViewer()
  let role
  try {
    role = await repoAccess(viewer.st, owner, viewer.claim.name)
  } catch {
    notFound()
  }
  return { ...viewer, role }
}
