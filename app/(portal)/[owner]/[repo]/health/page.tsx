import { permanentRedirect } from 'next/navigation'

// /health was the first name of the Score tab; old links keep working.
export default async function HealthRedirect({ params, searchParams }: {
  params: Promise<{ owner: string; repo: string }>
  searchParams: Promise<Record<string, string>>
}) {
  const { owner, repo } = await params
  const q = new URLSearchParams(await searchParams).toString()
  permanentRedirect(`/${owner}/${repo}/score${q ? `?${q}` : ''}`)
}
