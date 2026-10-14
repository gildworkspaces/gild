import { PreparingRepository } from '@/components/repo/PreparingRepository'

// The Cloudflare Worker serves the prepared immutable repository HTML.
// A cold/missing projection must never fall back to Git analysis in Next.
export default function RepositoryPage(_props?: unknown) {
  return <PreparingRepository />
}
