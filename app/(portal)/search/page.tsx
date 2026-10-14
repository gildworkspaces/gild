import { SearchPage } from '@/components/SearchPage'
export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const { q = '', page } = await searchParams
  return <SearchPage q={q} page={Math.max(1,Number(page) || 1)} />
}
