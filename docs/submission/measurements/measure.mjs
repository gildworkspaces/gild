// Headless Chrome page timings against gild.gg: TTFB, FCP, LCP, server-timing.
// Each URL loads in a fresh browser context (empty HTTP cache) three times:
// run 1 is the first request for that URL in this session ("cold"), runs 2-3
// follow it ("warm"). Usage: node measure.mjs <playwright-core dir> <url>...
const [, , pw, ...urls] = process.argv
const { chromium } = await import(pw + '/index.mjs')
const browser = await chromium.launch({ headless: true })
const out = []
for (const url of urls) {
  for (let run = 1; run <= 3; run++) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await ctx.newPage()
    await page.addInitScript(() => {
      globalThis.__lcp = 0
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) globalThis.__lcp = e.startTime
      }).observe({ type: 'largest-contentful-paint', buffered: true })
    })
    let serverTiming = null, cache = null, status = null
    page.on('response', async (r) => {
      if (r.url() === url && r.request().resourceType() === 'document') {
        const h = await r.allHeaders()
        serverTiming = h['server-timing'] ?? null
        cache = h['cf-cache-status'] ?? null
        status = r.status()
      }
    })
    await page.goto(url, { waitUntil: 'load', timeout: 60000 })
    await page.waitForTimeout(1500)
    const t = await page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0]
      const fcp = performance.getEntriesByName('first-contentful-paint')[0]
      return {
        ttfb: Math.round(n.responseStart),
        fcp: fcp ? Math.round(fcp.startTime) : null,
        lcp: Math.round(globalThis.__lcp),
        load: Math.round(n.loadEventEnd),
      }
    })
    out.push({ url, run, kind: run === 1 ? 'cold' : 'warm', status, cache, ...t, serverTiming })
    console.log(JSON.stringify(out.at(-1)))
    await ctx.close()
  }
}
await browser.close()
