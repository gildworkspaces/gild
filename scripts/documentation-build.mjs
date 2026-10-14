import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cssModules } from './render-build.mjs'
import { documentationAsset, documentationRoutes } from '../lib/documentation-routes.ts'
import { RENDER_VERSION } from '../packages/render/address.ts'

export async function buildDocumentation() {
  const root = resolve('.'), deployment = readFileSync('.next/BUILD_ID', 'utf8').trim()
  const imports = documentationRoutes.map((d, i) => `import Page${i}, {metadata as metadata${i}} from ${JSON.stringify(resolve(d.source))};`).join('\n')
  // Execute the canonical page components and their schema generation once in
  // the build process, using the same presentation/CSS/asset functions as Code.
  await build({
    stdin: { contents: `import {renderToStaticMarkup} from 'react-dom/server';import {Shell} from './packages/render/Shell';${imports}
      const shell='<!doctype html>'+renderToStaticMarkup(<Shell version=${JSON.stringify(RENDER_VERSION)}/>);
      export default [${documentationRoutes.map((d, i) => `shell.replace('<title>gild</title>', '<title>'+metadata${i}.title+'</title>').replace('<!--gild-content-->',renderToStaticMarkup(<div data-prepared-document=${JSON.stringify(d.path)}><Page${i}/></div>))`).join(',')}];`, resolveDir: root, loader: 'tsx' },
    outfile: '.render/documentation-pages.mjs', bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', packages: 'external',
    alias: { '@': root }, plugins: [cssModules()],
  })
  const pages = (await import(new URL('../.render/documentation-pages.mjs?' + Date.now(), import.meta.url))).default
  for (const [i, document] of documentationRoutes.entries()) {
    const asset = documentationAsset(deployment, document.id)
    for (const directory of ['.open-next/assets']) {
      const target = resolve(directory + asset)
      mkdirSync(resolve(target, '..'), { recursive: true })
      writeFileSync(target, pages[i])
    }
  }
  console.log('Prepared immutable documentation:', documentationRoutes.length, 'actual page components, no runtime Next rendering')
}
