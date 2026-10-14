import { redirect } from 'next/navigation'
export default async function Page({
  params,
}: {
  params: Promise<{ org: string }>
}) {
  redirect(`/orgs/${(await params).org}/settings/general`)
}
