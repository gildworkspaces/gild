import { build } from 'esbuild'
import { launchChrome } from './chrome.mjs'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { presentationCSS, cssModules } from './render-build.mjs'
export async function highlightChecks() {
  const dir = resolve('.tmp/fast-reads-2')
  mkdirSync(dir, { recursive: true })
  const modules = {}
  for (const [name, entry] of [['before', 'scripts/fixtures/inline-highlight.ts'], ['after', 'packages/render/highlight.ts'], ['lines', 'packages/render/lines.ts']]) {
    await build({ entryPoints: [entry], outfile: `${dir}/${name}.mjs`, bundle: true, platform: 'node', format: 'esm' })
    modules[name] = await import(`${dir}/${name}.mjs`)
  }
  const source = readFileSync('scripts/fixtures/lvm.c', 'utf8')
  const before = await modules.before.highlight(source, 'c')
  const compact = await modules.after.highlight(source, 'c')
  const after = modules.lines.numberLines(compact)
  const bytes = { source: Buffer.byteLength(source), before: Buffer.byteLength(before), after: Buffer.byteLength(compact) }
  assert.ok(bytes.after <= bytes.source * 2.5, `Lua fragment <=2.5x source: ${JSON.stringify(bytes)}`)
  assert.doesNotMatch(compact, /style=/, 'tokens contain no inline style attributes')
  await build({ entryPoints: ['gild-render.tsx'], outfile: `${dir}/renderer-review.mjs`, bundle: true,
    platform: 'node', format: 'esm', jsx: 'automatic', plugins: [cssModules()],
    external: ['react', 'react/*', 'react-dom/*'], define: { 'process.env.NODE_ENV': '"production"' } })
  const { fragmentHTML } = await import(`${dir}/renderer-review.mjs`)
  const actualFragment = await fragmentHTML({ kind: 'blob', text: source, bytes: bytes.source,
    binary: false, language: 'c', markdown: false })
  bytes.afterFragment = Buffer.byteLength(actualFragment)
  bytes.beforeFragment = bytes.before + bytes.afterFragment - bytes.after
  assert.ok(bytes.afterFragment <= bytes.source * 2.5, 'complete stored blob fragment meets the 2.5x source target')
  const plainSource = '<script>alert("escaped")</script>\n'.repeat(5000)
  const plain = await fragmentHTML({ kind: 'blob', text: plainSource, bytes: Buffer.byteLength(plainSource),
    binary: false, language: 'javascript', markdown: false })
  assert.match(plain, /gild-plain/)
  assert.match(plain, /&lt;script&gt;/)
  assert.doesNotMatch(plain, /<script>|<i class=|shiki/,
    'files over 128 KiB contain escaped source and never invoke highlighting')
  const browser = await launchChrome()
  const screenshots = []
  const comparisons = []
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } })
    for (const sample of ['\n\nconst a = 1\n', '\n\n', '', 'a\n\nb\n']) {
      await page.setContent(modules.lines.numberLines(await modules.after.highlight(sample, 'typescript')))
      await page.locator('.gild-ln').evaluateAll(anchors => anchors.forEach(anchor => anchor.remove()))
      assert.equal(await page.locator('pre code').textContent(), sample.replace(/\n$/, ''),
        'highlighting and line numbering preserve leading and internal blank lines')
    }
    await page.route('https://fixture.test/**', async route => {
      const family = route.request().url().includes('jetbrains') ? 'jetbrains-mono' : 'schibsted-grotesk'
      await route.fulfill({ contentType: 'font/woff2', body: readFileSync(`node_modules/@fontsource-variable/${family}/files/${family}-latin-wght-normal.woff2`) })
    })
    const css = presentationCSS().replaceAll('/gild-fragments/v2/', 'https://fixture.test/')
    const codeClass = 'gild-' + createHash('sha256').update('app/(portal)/[owner]/[repo]/repo.module.css').digest('hex').slice(0, 8) + '-code'
    for (const theme of ['light', 'dark']) {
      const unstyled = await modules.after.highlight('plain unknown-language source', 'unknown')
      await page.setContent(`<html data-theme=${theme}><head><style>${css}</style></head><body>${unstyled}</body></html>`)
      assert.equal(await page.locator('pre code').evaluate(code => getComputedStyle(code).color),
        theme === 'light' ? 'rgb(36, 41, 46)' : 'rgb(225, 228, 232)',
        'unknown languages retain the GitHub theme foreground')
      const pixels = new Map(), colors = new Map()
      for (const [label, html] of [['before', before], ['after', after]]) {
        await page.setContent(`<html data-theme=${theme}><head><style>${css}</style></head><body><div class=${codeClass}>${html}</div></body></html>`)
        await page.evaluate(() => document.fonts.ready)
        const tokens = await page.evaluate(() => {
          const walk = document.createTreeWalker(document.querySelector('pre code'), NodeFilter.SHOW_TEXT), out = []
          for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            if (n.parentElement.closest('.gild-ln')) continue
            const color = getComputedStyle(n.parentElement).color
            for (const char of n.textContent) if (!/\s/.test(char)) out.push([char, color])
          }
          return out
        })
        colors.set(label, tokens)
        for (const line of [1, 600, 1500]) {
          if (line === 1) await page.evaluate(() => scrollTo(0, 0))
          else await page.locator('#L' + line).scrollIntoViewIfNeeded()
          const path = `${dir}/lua-${theme}-${line}-${label}.png`
          const pixel = await page.screenshot({ path })
          pixels.set(`${label}:${line}`, pixel)
          screenshots.push(path)
        }
        assert.equal(await page.locator('.gild-ln').count(), source.trimEnd().split('\n').length)
      }
      assert.deepEqual(colors.get('after'), colors.get('before'), `${theme}: every visible source character keeps its original Shiki color`)
      for (const line of [1, 600, 1500]) {
        const comparison = await page.evaluate(async ([a, b]) => {
          const read = async data => {
            const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + data)).blob())
            const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
            const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0)
            return ctx.getImageData(0, 0, canvas.width, canvas.height).data
          }
          const [before, after] = await Promise.all([read(a), read(b)])
          let different = 0, max = 0
          for (let i = 0; i < before.length; i += 4) {
            const delta = Math.max(...[0, 1, 2].map(c => Math.abs(before[i + c] - after[i + c])))
            if (delta) different++; max = Math.max(max, delta)
          }
          return { different, total: before.length / 4, max, ratio: different / (before.length / 4) }
        }, [pixels.get(`before:${line}`).toString('base64'), pixels.get(`after:${line}`).toString('base64')])
        comparisons.push({ theme, line, ...comparison })
        console.log('Screenshot comparison', theme, line, comparison)
        assert.ok(comparison.ratio < 0.001, `${theme} line ${line}: at least 99.9% of screenshot pixels match`)
      }
    }
  } finally { await browser.close() }
  writeFileSync(`${dir}/highlight.json`, JSON.stringify({ bytes, ratio: bytes.after / bytes.source, screenshots, comparisons }, null, 2))
  console.log('PASS Lua fragment size, exact palette and light/dark screenshot comparisons', bytes)
}
if (process.argv[1] === new URL(import.meta.url).pathname) await highlightChecks()
