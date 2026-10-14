// Derive a celld deployment config from a wrangler config. The wrangler files
// stay the single source of truth; celld 0.6.2 refuses the keys that only mean
// something on Cloudflare's edge, so they are dropped here and nowhere else.
// See docs/self-host-celld.md.
import { readFileSync } from 'node:fs'

const EDGE_ONLY = ['build', 'limits', 'routes', 'workers_dev', 'preview_urls', 'send_metrics', 'observability']

export const readWrangler = (path) =>
  JSON.parse(readFileSync(path, 'utf8').replace(/^\s*\/\/.*$/gm, ''))

export function celldConfig(wrangler) {
  const config = { ...wrangler }
  for (const key of EDGE_ONLY) delete config[key]
  // wrangler defines NODE_ENV=production for a deploy; celld's esbuild does
  // not, which would ship React's development build.
  if (!config.no_bundle)
    config.define = { 'process.env.NODE_ENV': '"production"', ...config.define }
  return config
}
