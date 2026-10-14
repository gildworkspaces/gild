import { createRoot, type Root } from 'react-dom/client'
import type { ComponentProps, ReactNode } from 'react'
import { ViewerProvider, RepoViewerProvider, type Viewer } from '../../components/PublicViewer'
import { ActionsBoard } from '../../components/repo/Actions'
import { RepoChannel, type ChannelBootstrap } from '../../components/repo/Channel'
import { CreateItemView } from '../../components/repo/PublicCreateItem'
import { Sidebar } from './Sidebar'
import { RepoSearch, type LocalSearch } from '../../components/RepoSearch'
// Viewer data stays in this document, never in a public HTML/cache artifact.
// At most two repository snapshots, two reads each, and a 30-second lifetime.
const channels = new Map<string, { at: number; controller: AbortController; data: Promise<ChannelBootstrap> }>()
function channelData(owner: string, repo: string) {
  const key = `${owner}/${repo}`, held = channels.get(key)
  if (held && performance.now() - held.at < 30000) return held.data
  held?.controller.abort()
  channels.delete(key)
  while (channels.size >= 2) {
    const oldest = channels.keys().next().value!
    channels.get(oldest)!.controller.abort()
    channels.delete(oldest)
  }
  const controller = new AbortController()
  const read = async (path: string) => {
    const response = await fetch(`/api/v1/repos/${key}/channel/${path}`, { signal: controller.signal })
    if (!response.ok) throw Error(`Channel unavailable (${response.status})`)
    return response.json()
  }
  const data = Promise.all([read('messages'), read('participants')])
    .then(([page, people]) => ({ page, people }))
    .catch(error => { if (channels.get(key)?.controller === controller) channels.delete(key); throw error })
  // createRoot may commit after a fast failed/aborted read. Keep rejection
  // ownership here until the component attaches its own error handler.
  void data.catch(() => {})
  channels.set(key, { at: performance.now(), controller, data })
  return data
}
export async function prefetchTab(repository: string, tab: string, html: string) {
  if (tab !== 'agents') return
  const template = document.createElement('template')
  template.innerHTML = html
  const json = template.content.querySelector('[data-repo-island="agents"] [data-island-props]')?.textContent
  // Current server documents already carry their authorized channel snapshot.
  // Only older cached documents need the legacy two-request bootstrap.
  if (json && JSON.parse(json).initial) {
    document.dispatchEvent(new CustomEvent('gild:channel-prefetched', { detail: repository }))
    return
  }
  const [owner, repo] = repository.split('/')
  const data = channelData(owner, repo)
  await data
  if (channels.get(repository)?.data !== data) return
  document.dispatchEvent(new CustomEvent('gild:channel-prefetched', { detail: repository }))
}
document.addEventListener('gild:private-cleared', () => {
  for (const entry of channels.values()) entry.controller.abort()
  channels.clear()
  unmountTabs()
})
const roots = new Map<Element, Root>()
const chromeRoots = new Map<Element, Root>()
/** One lifecycle per content swap: unmount polling/WebSockets before removal. */
export function unmountTabs() {
  for (const root of roots.values()) root.unmount()
  roots.clear()
}
export function mountTabs(
  container: ParentNode = document,
  clearPrivate: () => Promise<void>,
  local?: LocalSearch,
) {
  const viewerJSON = document.querySelector('#gild-islands')?.textContent
  const viewer: Viewer & { repository?: string } = viewerJSON ? JSON.parse(viewerJSON) : { name: null }
  const search = document.querySelector('.search-trigger')
  if (search && !document.querySelector('[data-search-island], [data-search-ready]')) {
    const slot = document.createElement('span')
    slot.dataset.searchIsland = ''
    slot.style.display = 'contents'
    search.replaceWith(slot)
    // Keep the painted button until React commits its replacement. An empty
    // async root briefly collapses the mobile header and shifts the whole page.
    slot.append(search)
    const root = createRoot(slot)
    chromeRoots.set(slot, root)
    root.render(<RepoSearch local={local} />)
  }
  for (const slot of container.querySelectorAll<HTMLElement>(
    '[data-repo-island]',
  )) {
    const body = slot.querySelector<HTMLElement>('[data-island-body]'),
      json = slot.querySelector('[data-island-props]')?.textContent
    if (!body || !json || roots.has(body) || chromeRoots.has(body)) continue
    const props = JSON.parse(json),
      root = createRoot(body)
    const render = (child: ReactNode) => root.render(
      <ViewerProvider viewer={viewer}>
        {viewer.repository ? <RepoViewerProvider repository={viewer.repository} value={viewer}>{child}</RepoViewerProvider> : child}
      </ViewerProvider>,
    )
    ;(slot.closest('[data-page-body]') ? roots : chromeRoots).set(body, root)
    if (slot.dataset.repoIsland === 'actions')
      render(
        <ActionsBoard {...(props as ComponentProps<typeof ActionsBoard>)} />,
      )
    else if (slot.dataset.repoIsland === 'agents')
      render(
        <RepoChannel {...(props as ComponentProps<typeof RepoChannel>)} bootstrap={props.initial ? undefined : channelData(props.owner,props.repo)} />,
      )
    else if (slot.dataset.repoIsland === 'sidebar')
      render(
        <Sidebar
          {...(props as Pick<ComponentProps<typeof Sidebar>, 'identity'>)}
          onSignOut={async () => {
            await clearPrivate()
            await fetch('/api/auth/signout', { method: 'POST' })
            location.assign('/')
          }}
        />,
      )
    else
      render(
        <CreateItemView
          {...(props as ComponentProps<typeof CreateItemView>)}
        />,
      )
  }
}
