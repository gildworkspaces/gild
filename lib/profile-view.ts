import type { ForgeStore } from './backend.ts'
import { resolvePicture } from './profile.ts'

/** Claim emails stay here; callers serialize only the resolved picture. */
export async function profileView(st: ForgeStore, name: string, org = false) {
  // The profile and the claim are independent reads: one round trip, not two.
  const [profile, claim] = await Promise.all([st.settings.profile(name), org ? null : st.getClaim(name)])
  const email = org ? profile.publicEmail : claim?.email
  return { profile, picture: await resolvePicture(profile.picture, email) }
}
