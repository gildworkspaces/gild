import { SearchIsland } from './SearchIsland'
export async function SearchPage({ scope }: { q: string; page?: number; scope?: { owner: string; repo: string } }) {
  return <SearchIsland scope={scope} />
}
