// Post-deploy page-load probe: real headless Chrome against the live site,
// key pages signed out (and signed in with --cookie-file), cold (new browser
// context) and warm (reload). Prints one table: TTFB, settled, the Worker's
// server-timing for the document, and every /api request made on load
// (there should be none). Evidence only; it gates nothing.
//
//   node scripts/latency-live.mjs [--origin https://gild.gg] [--repo avatest/moshi]
//        [--cookie-file <file holding a gild_session value>]
import { readFileSync } from 'node:fs'
import { launchChrome } from './chrome.mjs'

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback }
const origin = arg('--origin', 'https://gild.gg'), repo = arg('--repo', 'avatest/moshi'), owner = repo.split('/')[0]
const cookieFile = arg('--cookie-file')
const pages = [`/${repo}`, `/${repo}/issues`, `/${repo}/pulls`, `/${repo}/actions`, `/${repo}/agents`, `/${owner}`]
const viewers = [['anonymous', null], ...(cookieFile ? [['signed-in', readFileSync(cookieFile, 'utf8').trim()]] : [])]

const browser = await launchChrome()
const rows = []
async function load(context, path) {
  const page = await context.newPage()
  await page.goto(origin + path, { waitUntil: 'networkidle' })
  const r = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0], all = performance.getEntriesByType('resource'), resources = all.filter((e) => new URL(e.name).origin === location.origin && !/\/favicon\./.test(e.name))
    return {
      ttfb: Math.round(nav.responseStart), thirdParty: Math.round(Math.max(0, ...all.filter((e) => !resources.includes(e)).map((e) => e.responseEnd))), settled: Math.round(Math.max(nav.responseEnd, ...resources.map((e) => e.responseEnd))),
      server: nav.serverTiming.filter((t) => t.name.startsWith('w-') && t.duration > 0).map((t) => `${t.name}=${Math.round(t.duration)}`).join(' '),
      api: resources.filter((e) => new URL(e.name).pathname.startsWith('/api/')).map((e) => `${new URL(e.name).pathname} ${Math.round(e.duration)}ms`),
    }
  })
  await page.close()
  return r
}
try {
  for (const [viewer, cookie] of viewers) for (const path of pages) {
    const context = await browser.newContext()
    if (cookie) await context.addCookies([{ name: 'gild_session', value: cookie, url: origin }])
    const cold = await load(context, path), warm = await load(context, path)
    rows.push({ viewer, path, pass: 'cold', ...cold }, { viewer, path, pass: 'warm', ...warm })
    await context.close()
  }
} finally { await browser.close() }
console.log(`${origin} ${new Date().toISOString()}\n`)
console.log('| viewer | page | pass | TTFB | settled (own) | third-party done | /api on load | document server-timing |\n|---|---|---|---|---|---|---|---|')
for (const r of rows) console.log(`| ${r.viewer} | \`${r.path}\` | ${r.pass} | ${r.ttfb} | ${r.settled} | ${r.thirdParty || '-'} | ${r.api.join(', ') || 'none'} | ${r.server} |`)
