import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { execFileSync } from 'node:child_process'
import { buildDocumentation } from './documentation-build.mjs'
const routes = []
function walk(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = dir + '/' + item.name
    if (item.isDirectory()) walk(path)
    else routes.push('/' + path.slice('.open-next/assets/'.length))
  }
}
// These are trusted generated build artifacts. Keep their CSS addresses in the
// standalone shell, without importing Next's browser runtime or Flight data.
const styles = new Set()
for (const tab of ['issues', 'pulls', 'actions', 'agents']) {
  const globalThis = {}
  runInNewContext(
    readFileSync(
      `.next/server/app/(portal)/[owner]/[repo]/${tab}/page_client-reference-manifest.js`,
      'utf8',
    ),
    { globalThis },
    { timeout: 1000 },
  )
  for (const manifest of Object.values(globalThis.__RSC_MANIFEST))
    for (const css of Object.values(manifest.entryCSSFiles).flat()) {
      if (!/^static\/chunks\/[^/]+\.css$/.test(css.path))
        throw Error('Unexpected tab stylesheet address')
      styles.add('/_next/' + css.path)
    }
}
writeFileSync('.render/tab-styles.json', JSON.stringify([...styles].sort()))
// Next's CSS filenames only exist after its build. Browser asset bytes remain
// identical; recompile the independent renderer with the finished CSS list.
execFileSync(process.execPath, ['scripts/render-build.mjs'], {
  stdio: 'inherit',
})
// Use the final immutable presentation graph, after Next supplies its CSS.
await buildDocumentation()
walk('.open-next/assets/_next/static')
writeFileSync('.render/next-assets.json', JSON.stringify({ build: readFileSync('.next/BUILD_ID', 'utf8').trim(), routes }))
console.log('Archived asset manifest:', routes.length, 'immutable Next/documentation assets')
console.log(
  'Prepared first-transition CSS:',
  styles.size,
  'immutable stylesheets',
)
