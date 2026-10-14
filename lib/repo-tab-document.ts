import assets from '../.render/assets.json'
import { repoTabRoute } from './repo-tab-route'
import { settledHTML } from './settled-html'
declare const HTMLRewriter: typeof import('@cloudflare/workers-types').HTMLRewriter
/** Runs once per immutable public publication input, or after private SSR auth.
 * Preserve the real server markup/CSS; remove the competing Next runtime.
 * Live controls mount as explicit islands using their existing components. */
export async function repoTabDocument(html: string, url: URL) {
  const tab = repoTabRoute(url)
  if (!tab || ['code', 'score'].includes(tab.tab)) return html
  const theme = `try{const t=localStorage.getItem('gild.theme')||'dark';document.documentElement.dataset.theme=t==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t}catch{}`
  const head = `<script>${theme}</script><link rel="stylesheet" href="${assets.urls['presentation.css']}"><script id="gild-assets" type="application/json">${JSON.stringify(assets.urls).replaceAll('<', '\\u003c')}</script><script type="module" src="${assets.urls['router.js']}"></script><link rel="modulepreload" href="${assets.urls['tab-client.js']}">`
  // Workers' streaming parser handles quoted attributes and script contents;
  // no regex HTML parsing, no client-side Flight decoding.
  return new HTMLRewriter()
    .on('html', {
      element(e) { e.setAttribute('data-repo-router', '') },
    })
    .on('script', {
      element(e) {
        if (
          (!e.hasAttribute('data-island-props') && e.getAttribute('id') !== 'gild-islands') ||
          e.getAttribute('type') !== 'application/json'
        )
          e.remove()
      },
    })
    .on('link[as="script"]', {
      element(e) {
        e.remove()
      },
    })
    .on('[data-repository]', {
      element(e) {
        e.setAttribute('data-fragment-root', '')
      },
    })
    .on('head', {
      element(e) {
        e.append(head, { html: true })
      },
    })
    .transform(
      new Response(
        settledHTML(html),
      ) as unknown as import('@cloudflare/workers-types').Response,
    )
    .text()
}
