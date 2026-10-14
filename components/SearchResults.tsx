import { SearchHits } from './SearchHits'
import type { SearchResponse } from '@/lib/search'
export function SearchResults({ q, page = 1, scope, data }: { q: string; page?: number; scope?: { owner: string; repo: string }; data: SearchResponse }) {
  const base = `${scope ? `/${scope.owner}/${scope.repo}` : ''}/search`
  const url = (query: string, p = 1) => `${base}?q=${encodeURIComponent(query)}&page=${p}`
  return <div className="search-page">
    <form action={base} className="search-page-form"><label htmlFor="full-query">Search {scope ? `${scope.owner}/${scope.repo}` : 'public code'}</label><div><input id="full-query" name="q" defaultValue={q} placeholder="Search code…" /><button type="submit">Search</button></div></form>
    <div className="search-page-grid">
      <aside className="search-filters" aria-label="Search filters"><h2>Filter by</h2><h3>Language</h3>{Object.entries(data.languages).sort((a,b) => b[1]-a[1]).map(([language,count]) => <a key={language} href={url(`(${q}) language:"${language}"`)}>{language}<span>{count}</span></a>)}<h3>Paths</h3>{Object.entries(data.paths).sort((a,b) => b[1]-a[1]).slice(0,20).map(([path,count]) => <a key={path} href={url(`(${q}) ${path === '/' ? String.raw`path:/^[^\/]+$/` : `path:"${path + '/'}"`}`)}>{path}<span>{count}</span></a>)}</aside>
      <section aria-label="Code results"><div className="search-count">{data.count} file results{data.indexing && ' · Indexing repositories…'}</div>
        {data.fallback && q && <p className="search-hint">Searching for the exact text you entered.</p>}
        <SearchHits hits={data.hits} />
        {!data.hits.length && <p className="search-empty">{q ? data.indexing ? 'The index is being built. Search again shortly.' : 'No matching code. Try a different query.' : 'Search file content, paths and symbol definitions.'}</p>}
        <nav className="search-pagination" aria-label="Results pages">{page > 1 && <a href={url(q,page-1)}>← Previous</a>}<span>Page {page}</span>{page * 20 < data.count && <a href={url(q,page+1)}>Next →</a>}</nav>
      </section>
    </div>
  </div>
}
