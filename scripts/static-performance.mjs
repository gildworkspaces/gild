import { launchChrome } from './chrome.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
/** Timing evidence only. No wall-clock thresholds are a CI pass/fail gate. */
export async function staticPerformance(origin, paths, label = 'after', cookies = []) {
  const browser = await launchChrome()
  const evidence = []
  try {
    for (const path of paths) {
      console.log('MEASURE',label,path)
      const context = await browser.newContext()
      if(cookies.length) await context.addCookies(cookies)
      const page = await context.newPage()
      await page.addInitScript(() => {
        window.__bundleReady = null
        new MutationObserver(() => {
          if (window.__bundleReady === null && document.documentElement.dataset.sourceReady)
            window.__bundleReady = performance.now()
        }).observe(document, { attributes: true, subtree: true })
      })
      for (const state of ['cold', 'warm']) {
        const bundleRequests = []
        const listener = r => { if (/\/bundle\//.test(r.url())) bundleRequests.push(r) }
        page.on('request', listener)
        const response = await page.goto(origin + path)
        const status = response.status()
        if (status !== 200) throw new Error(path + ': ' + status)
        if (await page.locator('#gild-pointer').count()) await page.waitForFunction(() => document.documentElement.dataset.sourceReady || document.documentElement.dataset.sourceError)
        else await page.waitForTimeout(40)
        await page.waitForFunction(()=>performance.getEntriesByName('first-contentful-paint').length>0)
        let metrics
        for(let attempt=0;attempt<3;attempt++)try {metrics = await page.evaluate(() => {
          const nav = performance.getEntriesByType('navigation')[0]
          const paint = performance.getEntriesByName('first-contentful-paint')[0]
          return { ttfbMs: nav.responseStart - nav.requestStart, fcpMs: paint?.startTime ?? null,
            loadMs: nav.loadEventEnd, bundleReadyMs: window.__bundleReady, sourceReady:document.documentElement.dataset.sourceReady??null, sourceError:document.documentElement.dataset.sourceError??null, timeOrigin: performance.timeOrigin }
        })
          break
        }catch(error){if(!String(error).includes('Execution context was destroyed')||attempt===2)throw error;await page.waitForLoadState('load')}
        if (!label.startsWith('before') && metrics.sourceError) throw Error(path + ': source Worker: ' + metrics.sourceError)
        const bundles = await Promise.all(bundleRequests.map(async r => ({ path: new URL(r.url()).pathname,
          startMs: r.timing().startTime - metrics.timeOrigin, durationMs: r.timing().responseEnd,
          ...await r.sizes() })))
        let calls=null
        for(let request=response.request();request;request=request.redirectedFrom()) {
          const headers=await (await request.response()).allHeaders(),trace=headers['x-fixture-trace']
          const value=trace?await (await fetch(origin+'/__fixture/calls?trace='+trace)).json():JSON.parse(headers['x-fixture-calls']??'null')
          if(value){calls??={do:0,d1:0,r2:0,render:0};for(const key of Object.keys(calls))calls[key]+=value[key]}
        }
        evidence.push({ path, state, status, ...metrics, bundles,
          calls })
        page.off('request', listener)
      }
      await context.close()
    }
    mkdirSync('.tmp/static-review', { recursive: true })
    writeFileSync(`.tmp/static-review/${label}-browser.json`, JSON.stringify(evidence, null, 2))
    console.log('Headless browser timing evidence:', JSON.stringify(evidence))
    return evidence
  } finally { await browser.close() }
}
