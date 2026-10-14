import assets from '../.render/assets.json'
import { fontCSS } from '../packages/presentation/fonts'
import { renderToStaticMarkup } from 'react-dom/server'
import { SiteHeaderView, IdentityView, SignInView } from '../packages/presentation/Headers'

// Exercise the real public-header identity view with a DNS handle; portal
// parity separately exercises its real session/island/sidebar path.
export function headerHTML(name: string | null) {
  return `<style>${fontCSS(assets.urls)}</style>` + renderToStaticMarkup(<SiteHeaderView search={<button className="search-trigger"><span>Type / to search</span><kbd>/</kbd></button>}
    identity={name ? <IdentityView name={name} picture={<img width="22" height="22" alt="" />} /> : <SignInView />} />)
}
