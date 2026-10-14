import { headers } from 'next/headers'
import { getCloudflareContext } from '@opennextjs/cloudflare'
import { fragmentReads } from '@/lib/fragments/production'
import { fragmentKey } from '@/packages/render/address'
import { contextHTML } from '@/packages/render/context'
import { numberLines } from '@/packages/render/lines'
import type { ReadEnv } from '@/lib/fragments/production'
import type { FragmentEnv } from '@/lib/fragments/http'
import { PreparingRepository } from './PreparingRepository'
import { PENDING_HTML } from '@/packages/render/pending'
import { FileTree, type Entry } from './FileTree'
import { pageIndex } from '@/lib/repo-index'
import s from '@/app/(portal)/[owner]/[repo]/repo.module.css'
import { stillPreparing } from '@/lib/status-pages'

/** Channel object previews read the same prepared source/commit HTML as the
 * standalone page. They cannot invoke the removed Next Git-rendering path. */
export async function PreparedRepositoryObject({ owner, repo, sha, refName, path }: {
  owner: string; repo: string; sha?: string; refName?: string; path?: string
}) {
  const { env, ctx } = await getCloudflareContext()
  const bindings = env as unknown as ReadEnv & FragmentEnv
  const request = new Request(`https://gild.gg/${owner}/${repo}`, { headers: await headers() })
  const pointer = await fragmentReads(bindings, ctx).pointer(request, owner, repo, refName, path, sha ? 'commit' : 'code', sha).catch(error => {
    if (!stillPreparing(error)) throw error
    return undefined
  })
  if (pointer === undefined) return <PreparingRepository />
  if (!pointer) return <p>Object not found.</p>
  let initial: Record<string, Entry[]> | null = null
  if (!sha && pointer.tip !== 'empty') {
    // Direct-child rows are already indexed. No recursive source walk, Git
    // advertisement, parsing or highlighting runs while opening the modal.
    const index = await pageIndex(owner, repo)
    initial = {}
    let dir = '', hash = pointer.manifest.hash
    const parts = (path ?? '').split('/').filter(Boolean)
    for (let depth = 0; ; depth++) {
      const entries = await index.tree(hash)
      if (!entries) return <PreparingRepository />
      initial[dir] = entries.map(entry => ({ name: entry.name, hash: entry.child, type: entry.type }))
        .sort((a, b) => Number(b.type === 'tree') - Number(a.type === 'tree') || a.name.localeCompare(b.name))
      const next = depth < parts.length - 1 ? entries.find(entry => entry.name === parts[depth] && entry.type === 'tree') : null
      if (!next) break
      dir = dir ? `${dir}/${next.name}` : next.name
      hash = next.child
    }
  }
  let html = '<p>No README yet. Pick a file on the left to read it.</p>'
  if (pointer.selected) {
    const object = await bindings.FRAGMENTS.get(fragmentKey(pointer.selected, pointer.scope))
    if (!object) {
      await bindings.RENDER_QUEUE.send({ entity: pointer.entity, repository: pointer.repository,
        oldTip: null, newTip: pointer.tip, meta: pointer.meta,
        item: { fragment: pointer.selected, path: pointer.path, sha: sha ?? pointer.tip } })
      html = PENDING_HTML
    } else {
      const body = object.body as unknown as ReadableStream
      html = contextHTML(numberLines(await new Response(object.httpMetadata?.contentEncoding === 'gzip' ? body.pipeThrough(new DecompressionStream('gzip')) : body).text()), pointer)
    }
  }
  return <div className={s.body}>
    {initial && <div className={s.side}><FileTree owner={owner} repo={repo} refName={pointer.ref} initial={initial} selected={path ?? null} /></div>}
    <main className={s.main}><section className={s.panel}>
      {pointer.path && <div className={s.panelHead}>{pointer.path}</div>}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </section></main>
  </div>
}
