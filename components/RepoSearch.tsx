'use client'
import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { createPortal } from 'react-dom'
import type { SearchResponse } from '@/lib/search'
import { MatchLine, fileURL } from './SearchHits'
const RESERVED = new Set(['auth', 'api', 'new', 'agents', 'search', 'settings', 'dashboard', 'runners', 'keys', 'git'])
/** Lines found in sources the browser already holds; null when it holds none. */
export type LocalSearch = (q: string) => Promise<{ path: string; ref: string; line: number; text: string }[] | null>
/** The one search palette. Published pages pass their in-browser source search. */
export function RepoSearch({ local }: { local?: LocalSearch } = {}) {
  const pathname = usePathname(), parts = pathname.split('/').filter(Boolean)
  const repo = parts.length >= 2 && !RESERVED.has(parts[0]) ? `${parts[0]}/${parts[1]}` : null
  const [open, setOpen] = useState(false), [scope, setScope] = useState<string | null>(repo)
  const [q, setQ] = useState(''), [mode, setMode] = useState('code'), [data, setData] = useState<SearchResponse | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [selected, setSelected] = useState(0)
  const input = useRef<HTMLInputElement>(null), dialog = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null)
  const show = (files = false) => {
    setScope(repo); setMode(files ? 'files' : 'code'); setQ(''); setData(null); setSelected(0); setOpen(true) }
  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (e.key === 'Escape') { setOpen(false); return }
      if (target.closest('input,textarea,select') || target.isContentEditable || e.altKey || e.metaKey || e.ctrlKey) return
      if (e.key === '/' || (repo && e.key === 't')) { e.preventDefault(); show(e.key === 't') }
    }
    // Published only after React committed actual trigger/keyboard handlers.
    const owner=trigger.current
    if(owner)owner.dataset.searchReady=''
    // A click or / before this island committed (the router remembers it).
    if(document.documentElement.dataset.searchWanted!==undefined){delete document.documentElement.dataset.searchWanted;show()}
    document.addEventListener('keydown', keys)
    return () => {document.removeEventListener('keydown', keys);if(owner)delete owner.dataset.searchReady}
  }, [repo])
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'; input.current?.focus()
    const root = document.querySelectorAll('body > *')
    const siblings = [...root].filter((e) => e instanceof HTMLElement && !e.classList.contains('search-backdrop')) as HTMLElement[]
    const old = siblings.map((e) => e.inert); siblings.forEach((e) => { e.inert = true })
    return () => { document.body.style.overflow = overflow; siblings.forEach((e, i) => { e.inert = old[i] }); previous?.focus() }
  }, [open])
  const previousPath = useRef(pathname)
  useEffect(() => { if (previousPath.current !== pathname) { previousPath.current = pathname; setOpen(false) } }, [pathname])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setBusy(true); setError(''); setSelected(0)
    const timer = setTimeout(async () => {
      try {
        const held = scope && local && mode === 'code' && q.trim() ? await local(q) : null
        if (held && !controller.signal.aborted) { setData(localResponse(scope!, q, held)); setBusy(false); return }
        const endpoint = scope ? `/api/repos/${scope}/search` : '/api/search'
        const response = await fetch(`${endpoint}?q=${encodeURIComponent(q)}&mode=${mode}`, { signal: controller.signal })
        if (!response.ok) throw new Error('Search is temporarily unavailable.')
        const result: SearchResponse = await response.json()
        if (!controller.signal.aborted) { setData(result); setBusy(false) }
      } catch (e) { if (!controller.signal.aborted) { setBusy(false); setError((e as Error).message) } }
    }, 120)
    return () => { clearTimeout(timer); controller.abort() }
  }, [q, open, scope, mode, local])
  const options = [
    ...(data?.suggestions ?? []).map((s) => ({ url: fileURL(s.repo,s.path,s.ref,s.line), path:s.path, repo:s.repo, detail:s.name ?? (s.kind === 'file' ? 'File' : 'Symbol'), lines:[] })),
    ...(mode === 'files' ? [] : data?.hits ?? []).map((h) => ({ url:fileURL(h.repo,h.path,h.ref,h.lines[0].line),path:h.path,repo:h.repo,detail:h.language,lines:h.lines })),
  ]
  const resultsURL = `${scope ? `/${scope}` : ''}/search?q=${encodeURIComponent(q)}`
  useEffect(() => { dialog.current?.querySelector(`[data-selected="true"]`)?.scrollIntoView({ block:'nearest' }) }, [selected])
  const navigate = (url: string) => { setOpen(false); window.location.assign(url) }
  return <>
    <button ref={trigger} className="search-trigger" onClick={() => show()} aria-label="Search code" aria-haspopup="dialog"><span>Type / to search</span><kbd>/</kbd></button>
    {open && createPortal(<div className="search-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false) }}>
      <div ref={dialog} className="search-dialog" role="dialog" aria-modal="true" aria-label={mode === 'files' ? 'Go to file' : 'Search code'} onKeyDown={(e) => {
        if (e.key === 'Tab') {
          const focusable = [...dialog.current!.querySelectorAll<HTMLElement>('input,button,a[href]')]
          if (e.shiftKey && document.activeElement === focusable[0]) { e.preventDefault(); focusable.at(-1)?.focus() }
          else if (!e.shiftKey && document.activeElement === focusable.at(-1)) { e.preventDefault(); focusable[0]?.focus() }
        }
      }}>
        <div className="search-input-row">
          {scope && <button className="search-scope" onClick={() => { setScope(null); setMode('code'); input.current?.focus() }} aria-label={`Remove repo:${scope} scope`}>repo:{scope} <span>×</span></button>}
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={mode === 'files' ? 'Go to file…' : 'Search code…'} aria-label={mode === 'files' ? 'File path' : 'Search query'} role="combobox" aria-autocomplete="list" aria-controls="search-options" aria-expanded={true} aria-activedescendant={options[selected] ? `search-option-${selected}` : undefined} onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setSelected((n) => options.length ? (n + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length : 0) }
            if (e.key === 'Enter') { e.preventDefault(); if (e.metaKey || e.ctrlKey || !options[selected]) navigate(resultsURL); else navigate(options[selected].url) }
          }} />
          <button className="search-close" onClick={() => setOpen(false)} aria-label="Close search">Esc</button>
        </div>
        <div className="search-status" role="status">{error || (busy ? 'Searching…' : data?.indexing ? 'Indexing repository…' : mode === 'files' ? 'Go to file' : q.trim() ? `${data?.count ?? 0}${data?.partial ? '+' : ''} file results` : 'Files and symbols')}<span>↑ ↓ to select · Enter to open</span></div>
        <div id="search-options" className="search-options" role="listbox" aria-label="Search results" aria-busy={busy}>
          {options.map((o, i) => <a href={o.url} id={`search-option-${i}`} key={`${o.url}:${i}`} role="option" aria-selected={selected === i} data-selected={selected === i} tabIndex={-1} onMouseEnter={() => setSelected(i)} onClick={(e) => { e.preventDefault(); navigate(o.url) }} className="search-option">
            <div className="search-option-title"><span>{o.path}</span><small>{o.detail}</small></div>
            {!scope && <small>{o.repo}</small>}
            {o.lines.map((l) => <div className="search-code-line" key={l.line}><MatchLine line={l} /></div>)}
          </a>)}
          {!options.length && !busy && <p className="search-empty">{error || (data?.indexing ? 'The first index is being built. Try again shortly.' : q ? 'No matching files.' : 'Type to search paths, content and definitions.')}</p>}
        </div>
        <a className="search-footer" href={resultsURL}>View all results <span>⌘ / Ctrl + Enter</span></a>
      </div>
    </div>, document.body)}
  </>
}
function localResponse(repo: string, q: string, held: NonNullable<Awaited<ReturnType<LocalSearch>>>): SearchResponse {
  const needle = q.toLowerCase(), hits = new Map<string, SearchResponse['hits'][number]>()
  for (const h of held) {
    const at = h.text.toLowerCase().indexOf(needle)
    const hit = hits.get(h.path) ?? { repo, path: h.path, ref: h.ref, language: '', lines: [] }
    if (hit.lines.length < 3) hit.lines.push({ line: h.line, text: h.text, ranges: at < 0 ? [] : [[at, at + needle.length]] })
    hits.set(h.path, hit)
  }
  return { hits: [...hits.values()], count: hits.size, languages: {}, paths: {}, fallback: false, suggestions: [], indexing: false }
}
