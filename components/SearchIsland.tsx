'use client'
import { useEffect, useState } from 'react'
import { SearchResults } from './SearchResults'
import type { SearchResponse } from '@/lib/search'
const empty: SearchResponse = { hits: [], count: 0, languages: {}, paths: {}, suggestions: [], fallback: false, indexing: false }
export function SearchIsland({ scope }: { scope?: { owner: string; repo: string } }) {
  const [data,setData] = useState(empty), [query,setQuery] = useState({q:'',page:1}), [error,setError] = useState('')
  useEffect(() => {
    const url = new URL(location.href), q = url.searchParams.get('q') ?? '', page = Math.max(1, Number(url.searchParams.get('page')) || 1)
    setQuery({q,page})
    if (!q) return
    const abort = new AbortController()
    const endpoint = scope ? `/api/repos/${scope.owner}/${scope.repo}/search` : '/api/search'
    void fetch(`${endpoint}?q=${encodeURIComponent(q)}&page=${page}`, {signal:abort.signal,cache:'no-store'})
      .then(async r => { if (!r.ok) throw Error('Search unavailable. Try again.'); return r.json() })
      .then(setData).catch(e => { if (!abort.signal.aborted) setError(e.message) })
    return () => abort.abort()
  },[scope])
  return <>{error && <p role="alert">{error}</p>}<SearchResults {...query} scope={scope} data={data} /></>
}
