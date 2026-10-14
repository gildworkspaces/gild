import { SearchPage } from '@/components/SearchPage'
export default async function Page({ params, searchParams }: { params: Promise<{ owner: string; repo: string }>; searchParams: Promise<{ q?: string; page?: string }> }) {
  const [scope, { q = '', page }] = await Promise.all([params, searchParams])
  return <SearchPage scope={scope} q={q} page={Math.max(1,Number(page) || 1)} />
}
