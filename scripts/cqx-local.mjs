// Full Score tab on workerd + a real service binding, local Git and D1 only.
import { forgeFixture } from './forge-fixture.mjs'
import { cqxReads } from '../lib/cqx-reads.ts'
import { BUILD } from '../lib/cqx-module.ts'
import { READS_VERSION } from '../lib/cqx-reads.ts'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { launchChrome } from './chrome.mjs'
import assert from 'node:assert/strict'

const demos = resolve('.tmp/cqx-demos'), evidence = resolve('.tmp/cqx-review')
mkdirSync(demos, { recursive: true })
mkdirSync(evidence, { recursive: true })
const names = ['cJSON', 'lua', 'tinyxml2', 'Polly', 'jsoup', 'moshi']
const sources = {}, sourceCommits = {}
for (const name of names) {
  const dir = join(demos, name)
  if (!existsSync(join(dir, '.git'))) execFileSync('git', ['clone', '--depth=1', `https://gild.gg/avatest/${name}.git`, dir], { stdio: 'pipe', timeout: 120000 })
  sourceCommits[name] = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  sources[name] = execFileSync('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8' }).split('\0').filter(cqxReads)
    .map(path => ({ path, text: new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(join(dir, path))) }))
}

const f = await forgeFixture({ cqxModules: true })
let browser
try {
  for (const name of names) f.seedRepo('u-avatest', name, sources[name])
  const deadline = Date.now() + 90000
  while (true) {
    try { if ((await fetch(f.origin + '/api/v1/openapi.json')).ok) break } catch {}
    if (f.worker.exitCode !== null || Date.now() > deadline) throw Error('Worker startup failed: ' + f.logs.slice(-4000))
    await new Promise(r => setTimeout(r, 250))
  }
  console.log('Both Workers ready on local workerd; production Score tab, D1 and Git transport')
  const rows = []
  for (const name of names) {
    // This endpoint imports the production scorer directly. The same binding
    // call can be removed for a workerd revert proof without rebuilding Next.
    const scan = await fetch(f.origin + '/__fixture/cqx-scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: sources[name], label: 'avatest/' + name }) })
    assert.equal(scan.status, 200, await scan.clone().text())
    const direct = await scan.json()
    assert.ok(direct.lines > 0, name + ' must score through the service binding')
    if (name === 'cJSON') assert.ok(direct.rules.some(r => r.rule === 'unsafe-buffer-calls' && r.findings.some(h => h.text?.includes('sprintf('))), 'cJSON unbounded sprintf finding')
    if (name === 'Polly') assert.ok(direct.rules.some(r => r.language === 'csharp' && r.total_findings > 0), 'Polly real C# findings')
    if (name === 'moshi') assert.ok(direct.languages.kotlin && direct.languages.java, 'mixed Kotlin/Java breakdown')
    const url = f.origin + '/avatest/' + name + '/score'
    const first = performance.now()
    let html, response, entries, attempts = 0
    // A fresh large fixture can outlast the production index's request budget.
    // Wait for an actual Score section and cache entry, not an HTTP 200 error shell.
    const pageDeadline = performance.now() + 90000
    while (true) {
      attempts++
      response = await fetch(url)
      html = await response.text()
      entries = (await (await fetch(f.origin + '/__fixture/cqx-cache')).json()).results.filter(r => r.key.startsWith('avatest/' + name + '@'))
      if (response.status === 200 && html.includes('id="score"') && html.includes('Code Score of') && entries.length === 1) break
      if (performance.now() > pageDeadline) throw Error(name + ' Score/index did not become ready: ' + f.logs.slice(-2000))
      await new Promise(r => setTimeout(r, 250))
    }
    const firstMs = performance.now() - first
    const cached = performance.now()
    const cachedResponse = await fetch(url)
    assert.equal(cachedResponse.status, 200)
    assert.ok((await cachedResponse.text()).includes('id="score"'), 'cached response is the rendered Score section')
    const cachedMs = performance.now() - cached
    const cachedEntries = (await (await fetch(f.origin + '/__fixture/cqx-cache')).json()).results.filter(r => r.key.startsWith('avatest/' + name + '@'))
    assert.equal(cachedEntries.length, 1, 'one immutable score entry despite repeated page visits')
    assert.ok(entries[0].key.endsWith(`#${BUILD}:${READS_VERSION}`))
    const report = JSON.parse(entries[0].report)
    assert.deepEqual(report, direct, 'Score tab cache stores the same real report')
    writeFileSync(join(evidence, name + '.json'), JSON.stringify(report, null, 2))
    rows.push({ repo: 'avatest/' + name, sourceCommit: sourceCommits[name], cacheKey: entries[0].key, firstScorePageMs: Math.round(firstMs), firstViewAttempts: attempts, cachedScorePageMs: Math.round(cachedMs), lines: report.lines, languages: Object.keys(report.languages ?? {}), findings: report.rules.filter(r => r.total_findings > 0).map(r => ({ language: r.language, rule: r.rule, findings: r.total_findings })) })
    console.log(name, rows.at(-1))
  }
  browser = await launchChrome()
  for (const name of ['cJSON', 'lua', 'tinyxml2', 'Polly', 'moshi']) for (const theme of ['light', 'dark']) for (const width of [1400, 400]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 } })
    await page.addInitScript(theme => localStorage.setItem('gild.theme', theme), theme)
    await page.goto(f.origin + '/avatest/' + name + '/score')
    await page.getByRole('heading', { name: /Code Score of/ }).waitFor()
    if (name === 'moshi') await page.getByLabel('Per-language product lines').waitFor()
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme)
    assert.equal(await page.locator('#score').evaluate(e => e.scrollWidth <= e.clientWidth), true, 'Score section fits viewport')
    const dials = page.locator('#score a[aria-current]')
    assert.equal(await dials.count(), 5)
    if (name === 'moshi') for (const dial of await dials.all()) {
      assert.match(await dial.innerText(), /Kotlin[\s\S]*Java|Java[\s\S]*Kotlin/)
    }
    await page.screenshot({ path: join(evidence, `${name}-${theme}-${width}.png`), fullPage: true })
    await page.close()
  }
  writeFileSync(join(evidence, 'evidence.json'), JSON.stringify({ runtime: 'wrangler dev multi-config: main OpenNext + gild-cqx-heavy', rows, screenshots: 20 }, null, 2))
  console.log('Real findings, immutable cache, mixed breakdown and 20 Score tab screenshots passed:', evidence)
} finally {
  await browser?.close()
  f.worker.kill('SIGTERM')
  f.server.closeAllConnections()
  await new Promise(r => f.server.close(r))
}
