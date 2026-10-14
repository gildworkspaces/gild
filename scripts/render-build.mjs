import { build } from 'esbuild'
import { fontCSS } from '../packages/presentation/fonts.ts'
import { readFileSync, mkdirSync, writeFileSync, copyFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { RENDER_VERSION, BROWSER_ASSETS } from '../packages/render/address.ts'
import { createHash } from 'node:crypto'
const root = resolve('.'),
  styles = [
    'app/(marketing)/docs/api/api.module.css',
    'app/(portal)/[owner]/[repo]/repo.module.css',
    'components/repo/health.module.css',
    'components/repo/glance.module.css',
    'components/settings/settings.module.css',
    'components/repo/receipts.module.css',
    'components/repo/actions.module.css',
    'components/repo/Channel.module.css',
  ]
function compileModule(path) {
  const prefix = 'gild-' + createHash('sha256').update(relative(root, path)).digest('hex').slice(0, 8)
  const names = {}
  const css = readFileSync(path, 'utf8').replace(/\.([a-zA-Z_][\w-]*)/g, (_, name) => {
    names[name] = `${prefix}-${name}`
    return '.' + names[name]
  })
  return { css, names }
}
export function presentationCSS(version = RENDER_VERSION, urls = {}) {
  const fonts = Object.fromEntries(['schibsted-grotesk.woff2','jetbrains-mono.woff2'].map(name => [name,urls[name] ?? `/gild-fragments/${version}/${name}`]))
  return fontCSS(fonts) + '\n' + readFileSync('app/globals.css', 'utf8') + styles.map(path => compileModule(resolve(path)).css).join('\n') +
    '\n' + readFileSync('packages/render/fragments.css', 'utf8').replace(/\/gild-fragments\/v1\/([^')]+)/g, (_, name) => urls[name] ?? `/gild-fragments/${version}/${name}`)
}
export const cssModules = ({
  version = RENDER_VERSION,
  assetsDir = `public/gild-fragments/${version}`,
  manifest = JSON.parse(readFileSync('.render/assets.json', 'utf8')),
} = {}) => ({
  name: 'pure-presentation-css',
  setup(b) {
    b.onResolve({ filter: /^gild:tab-styles$/ }, () => ({ path: 'styles', namespace: 'gild-tab-styles' }))
    b.onLoad({ filter: /.*/, namespace: 'gild-tab-styles' }, () => ({ contents: `export default ${existsSync('.render/tab-styles.json') ? readFileSync('.render/tab-styles.json','utf8') : '[]'}`, loader: 'js' }))
    b.onResolve({ filter: /^gild:asset-manifest$/ }, () => ({ path: 'manifest', namespace: 'gild-manifest' }))
    b.onLoad({ filter: /.*/, namespace: 'gild-manifest' }, () => ({ contents: `export default ${JSON.stringify(manifest)}`, loader: 'js' }))
    b.onLoad({ filter: /\.module\.css$/ }, (args) => ({
      contents: `export default ${JSON.stringify(compileModule(args.path).names)}`,
      loader: 'js',
    }))
    b.onResolve({ filter: /^gild:browser-assets$/ }, () => ({
      path: 'assets',
      namespace: 'gild-assets',
    }))
    b.onLoad({ filter: /.*/, namespace: 'gild-assets' }, () => ({
      contents:
        'export default {' +
        BROWSER_ASSETS.map(
          (name) =>
            JSON.stringify(name) +
            ':Uint8Array.from(atob(' +
            JSON.stringify(
              readFileSync(resolve('public', manifest.urls[name].slice(1))).toString('base64'),
            ) +
            '), c=>c.charCodeAt(0))',
        ).join(',') +
        '}',
      loader: 'js',
    }))

  },
})
export function publishAssets(version, assetsDir) {
  const urls = {}
  const publish = (name, bytes) => {
    const hash = createHash('sha256').update(bytes).digest('hex')
    const path = `/gild-fragments/${hash}/${name}`
    mkdirSync(resolve('public/gild-fragments', hash), { recursive: true })
    writeFileSync(resolve('public', path.slice(1)), bytes)
    urls[name] = path
  }
  for (const name of BROWSER_ASSETS.filter(n => n !== 'presentation.css'))
    publish(name, readFileSync(resolve(assetsDir, name)))
  publish('presentation.css', Buffer.from(presentationCSS(version, urls)))
  const manifest = { urls, hash: createHash('sha256').update(JSON.stringify(urls)).digest('hex') }
  return manifest
}
export async function buildTabClient(outdir, additionalPlugins = []) {
  return build({entryPoints:['packages/render/tab-client.tsx'],outdir,bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,jsx:'automatic',
    alias:{'next/navigation':resolve('packages/render/tab-navigation.ts'),'next/link':resolve('packages/render/link.tsx'),'@/components/Link':resolve('packages/render/link.tsx')},
    plugins:[...additionalPlugins,cssModules({manifest:{urls:{},hash:''}})],define:{'process.env.NODE_ENV':'"production"'}})
}
export async function buildAssets() {
  mkdirSync('.render', { recursive: true })
  mkdirSync(`public/gild-fragments/${RENDER_VERSION}`, { recursive: true })
  copyFileSync('public/favicon.svg', `public/gild-fragments/${RENDER_VERSION}/favicon.svg`)
  for (const family of ['schibsted-grotesk', 'jetbrains-mono'])
    copyFileSync(
      `node_modules/@fontsource-variable/${family}/files/${family}-latin-wght-normal.woff2`,
      `public/gild-fragments/${RENDER_VERSION}/${family}.woff2`,
    )

  await build({stdin:{contents:`import {renderToStaticMarkup} from 'react-dom/server';import {TabSkeleton} from './packages/render/tab-skeleton';export default Object.fromEntries(['code','issues','pulls','actions','agents','score'].map(tab=>[tab,renderToStaticMarkup(<TabSkeleton tab={tab}/>)]));`,resolveDir:root,loader:'tsx'},outfile:'.render/tab-skeletons.mjs',bundle:true,platform:'node',format:'esm',jsx:'automatic',packages:'external',plugins:[cssModules({manifest:{urls:{},hash:''}})]})
  const skeletons=(await import(new URL('../.render/tab-skeletons.mjs?'+Date.now(),import.meta.url))).default
  writeFileSync('.render/tab-skeletons.json',JSON.stringify(skeletons))
  await build({
    entryPoints: [
      'packages/render/router.ts',
      'packages/render/source-worker.ts',
      'packages/render/identity-client.tsx',
      'packages/render/commit-client.tsx',
    ],
    outdir: `public/gild-fragments/${RENDER_VERSION}`,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    plugins: [cssModules({ manifest: { urls: {}, hash: '' } })],
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  await buildTabClient(`public/gild-fragments/${RENDER_VERSION}`)
  const manifest = publishAssets(RENDER_VERSION, `public/gild-fragments/${RENDER_VERSION}`)
  writeFileSync('.render/assets.json', JSON.stringify(manifest, null, 2))
  const source = createHash('sha256')
  function sources(dir) {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const path = dir + '/' + item.name
      if (item.isDirectory()) sources(path)
      else if (/\.(?:ts|tsx|css)$/.test(path)) source.update(path).update(readFileSync(path))
    }
  }
  for (const dir of ['app','components','lib','packages/render']) sources(dir)
  writeFileSync('.render/site-version.json', JSON.stringify({ hash: source.digest('hex') }))
  writeFileSync('public/_headers', '/_next/static/*\n  Cache-Control: public, max-age=31536000, immutable\n/favicon.svg\n  Cache-Control: public, max-age=3600\n' + [...new Set(Object.values(manifest.urls).map(url => url.slice(0, url.lastIndexOf('/'))))].map(dir => dir + '/*\n  Cache-Control: public, max-age=31536000, immutable\n').join(''))
  return manifest
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  await buildAssets()
  await build({
    entryPoints: ['gild-render.tsx'],
    outfile: '.render/worker.mjs',
    bundle: true,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'browser'],
    jsx: 'automatic',
    external: ['cloudflare:workers', 'node:*'],
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [cssModules()],
    minify: true,
    metafile: true,
  }).then((r) =>
    writeFileSync('.render/metafile.json', JSON.stringify(r.metafile)),
  )
  console.log('Built independent gild-render Worker (no Next/OpenNext).')
}
