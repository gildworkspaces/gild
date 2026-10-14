import { chromium } from 'playwright-core'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
const reqs = []
page.on('requestfinished', async (q) => {
  const t = q.timing()
  reqs.push({
    u: q.url().replace('https://gild.gg', '').slice(0, 70),
    ms: Math.round(t.responseEnd),
    type: q.resourceType(),
  })
})
const repo = process.argv[2] || 'avatest/mediatr'
const origin = process.argv[3] || 'https://gild.gg'
const cold = process.argv.includes('--cold')
if (cold)
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'connection', {
      value: { saveData: true, effectiveType: '4g' },
    }),
  )
if (process.argv.includes('--warm'))
  await page.addInitScript(() => {
    window.__prefetchedTabs = []
    document.addEventListener('gild:prefetched', (e) =>
      window.__prefetchedTabs.push(new URL(e.detail).pathname),
    )
  })
console.log(
  'mode',
  cold
    ? 'cold browser cache, Save-Data'
    : process.argv.includes('--warm')
      ? 'prefetched browser cache'
      : 'default',
)
let t0 = Date.now()
await page.goto(origin + '/' + repo, { waitUntil: 'load' })
console.log('landing', Date.now() - t0, 'ms')
await page.waitForTimeout(1500)
if (process.argv.includes('--warm')) {
  await page.locator('nav[aria-label=Repository] a[data-tab]').evaluateAll(links => {
    for (const link of links) link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
  await page.waitForFunction(
    (repo) =>
      ['issues', 'pulls', 'actions', 'agents', 'score'].every((tab) =>
        window.__prefetchedTabs.includes('/' + repo + '/' + tab),
      ),
    repo,
  )
}
const tabs = await page.evaluate(
  (r) =>
    [...document.querySelectorAll('a[href]')]
      .map((a) => [a.textContent.trim().slice(0, 20), a.getAttribute('href')])
      .filter(
        ([, h]) =>
          (h.startsWith('/' + r + '/') && h.split('/').length === 4) ||
          h === '/' + r,
      ),
  repo,
)
console.log(JSON.stringify(tabs.slice(0, 12)))
const order = ['issues', 'pulls', 'actions', 'agents', '', 'issues', '']
for (const t of order) {
  const href = '/' + repo + (t ? '/' + t : '')
  const link = page
    .locator(`nav[aria-label=Repository] a[data-tab="${t || 'code'}"]`)
    .first()
  if (!(await link.count())) {
    console.log('no link', href)
    continue
  }
  const before = reqs.length
  const marker = await page.evaluate(() => (window.__m = Math.random()))
  t0 = Date.now()
  await link.click()
  await page
    .waitForURL((u) => u.pathname === href, { timeout: 15000 })
    .catch(() => {})
  const urlAt = Date.now() - t0
  let n = -1
  while (n !== reqs.length && Date.now() - t0 < 15000) {
    n = reqs.length
    await page.waitForTimeout(300)
  }
  const settled = Date.now() - t0 - 300
  const soft = await page.evaluate((m) => window.__m === m, marker)
  const news = reqs.slice(before)
  console.log(
    `${(t || 'code').padEnd(8)} url@${String(urlAt).padStart(5)}ms settled@${String(settled).padStart(5)}ms ${soft ? 'soft' : 'FULL-RELOAD'} scrollY=${await page.evaluate(() => scrollY)}`,
  )
  console.log(
    '   ',
    news
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 4)
      .map((r) => `${r.type}:${r.u} ${r.ms}`)
      .join(' | '),
  )
}
await browser.close()
