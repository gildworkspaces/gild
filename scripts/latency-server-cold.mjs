// Evidence for first page requests after restarting workerd, with prepared
// immutable storage preserved. No HTTP warm-up precedes each measured page.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { launchChrome } from './chrome.mjs'
import { forgeFixture } from './forge-fixture.mjs'
import { documentationRoutes } from '../lib/documentation-routes.ts'

const prepareWork = process.argv[2]
assert.ok(prepareWork, 'Pass the prepared latency fixture directory')
const docsOnly = process.argv.includes('--docs-only')
const paths = docsOnly ? documentationRoutes.map(d => d.path) : ['/settingstest/demo', '/settingstest/demo/issues', '/settingstest/demo/actions', '/settingstest/demo/agents', '/', '/docs/api']
const rows = [], browser = await launchChrome()
try {
  for (const viewer of ['anonymous', 'signed-in']) for (const path of paths) {
    const fixture = await forgeFixture({ reuseWork: prepareWork, renderBuild: false, latency: 25, staticReview: docsOnly })
    let context
    try {
      const end = Date.now() + 60000
      while (!/Ready on http/.test(fixture.logs)) {
        assert.equal(fixture.worker.exitCode, null, 'fresh worker stays alive')
        assert.ok(Date.now() < end, 'fresh worker starts')
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      context = await browser.newContext()
      if (viewer === 'signed-in') await context.addCookies([{ name: 'gild_session', value: fixture.cookie('avatest'), url: fixture.origin }])
      const page = await context.newPage()
      const response = await page.goto(fixture.origin + path, { waitUntil: 'networkidle' })
      const measurements = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0]
        const own = performance.getEntriesByType('resource').filter(r => new URL(r.name).origin === location.origin && !/\/favicon\./.test(r.name))
        return {
          ttfb: Math.round(nav.responseStart), settled: Math.round(Math.max(nav.responseEnd, ...own.map(r => r.responseEnd))),
          serverTotal: Math.round(nav.serverTiming.find(t => t.name === 'w-total')?.duration ?? 0),
          serverStages: nav.serverTiming.filter(t => t.name.startsWith('w-')).map(t => ({name:t.name,ms:Math.round(t.duration)})),
          pending: !!document.querySelector('[data-artifact-pending]'),
          api: own.filter(r => new URL(r.name).pathname.startsWith('/api/')).map(r => new URL(r.name).pathname),
        }
      })
      const trace = response.headers()['x-fixture-io']
      const ioTrace = trace ? await (await fetch(fixture.origin + '/__fixture/io?trace=' + trace)).json() : null
      const calls = response.headers()['x-fixture-calls'] ? JSON.parse(response.headers()['x-fixture-calls']) : null
      rows.push({ viewer, path, status: response.status(), ...measurements, ioTrace, ...(docsOnly ? { calls } : {}) })
      writeFileSync(docsOnly ? '.tmp/documentation-server-cold.json' : '.tmp/latency-server-cold.json', JSON.stringify(rows, null, 2) + '\n')
      assert.equal(response.status(), 200, viewer + ' ' + path)
      assert.deepEqual(measurements.api, [], 'no viewer waterfall on server-cold ' + viewer + ' ' + path)
      assert.equal(measurements.pending, false, 'prepared storage remains available after server restart')
      if (docsOnly) {
        assert.equal(calls.next, 0, 'cold prepared documentation does not enter Next')
        assert.equal(calls.render, 0, 'cold prepared documentation does not compute renderer HTML')
        assert.ok(measurements.serverTotal <= 150, 'unchanged 150ms document server budget')
        assert.ok(measurements.settled <= 600, 'unchanged 600ms cold-browser settled budget')
      }
      console.log(JSON.stringify(rows.at(-1)))
    } finally {
      await context?.close()
      fixture.worker.kill('SIGTERM')
      await new Promise(resolve => fixture.worker.exitCode !== null ? resolve() : fixture.worker.once('exit', resolve))
      await new Promise(resolve => fixture.server.close(resolve))
    }
  }
  const stats = key => {
    const values = rows.map(row => row[key]).sort((a, b) => a - b)
    return { p50: values[Math.ceil(values.length * .5) - 1], p95: values[Math.ceil(values.length * .95) - 1], max: values.at(-1) }
  }
  console.log(docsOnly ? 'Docs first-worker observations (one per route/viewer; not production tails)' : 'Server-cold tails', JSON.stringify({ ttfb: stats('ttfb'), settled: stats('settled'), server: stats('serverTotal') }))
} finally { await browser.close() }
