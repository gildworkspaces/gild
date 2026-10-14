// Contest status pages against the full OpenNext worker on local workerd:
// Unpublished public pages return Pending without rendering in the request;
// gild-site#64 (missing/private repos and missing owners get the site's real
// 404 page, identical bytes), gild-site#66 (no hydration error on / or on
// profiles, signed out, in both themes).
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { forgeFixture } from './forge-fixture.mjs'

const fixture = await forgeFixture({ repoList: true })
const { origin, worker, server, tokens, cookie, work } = fixture
const html = { accept: 'text/html,application/xhtml+xml' }
const get = (path, headers = html) => fetch(origin + path, { headers, redirect: 'manual' })
const hydration = /hydrat|Minified React error #4(?:18|19|22|23|25)|did(?:n't| not) match/i
let browser
async function until(label, probe, ms = 90000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await probe()) return
    await new Promise(r => setTimeout(r, 200))
  }
  throw Error('Timed out: ' + label)
}
/** Load a page in Chrome and return every console/page error it logged. */
async function pageErrors(path, colorScheme) {
  const page = await browser.newPage({ colorScheme })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  const response = await page.goto(origin + path, { waitUntil: 'networkidle' })
  // Hydration errors are reported asynchronously after the scripts run.
  await page.waitForFunction(() => document.readyState === 'complete')
  await page.waitForTimeout(500)
  assert.equal(page.url(), origin + path, 'hydration keeps the address the visitor typed')
  const status = response.status(), heading = await page.locator('h1').first().textContent().catch(() => null)
  await page.close()
  return { status, errors, heading }
}
async function verify() {
  await until('worker start', async () => {
    if (worker.exitCode !== null) throw Error(fixture.logs)
    try { return (await fetch(origin + '/api/v1/openapi.json')).ok } catch { return false }
  })
  const names = ['ky', 'chi', 'docs']
  for (const name of names) await fetch(origin + '/__fixture/refresh?key=settingstest/' + name)
  for (const name of names)
    await until('index ' + name, async () => (await fetch(origin + '/api/v1/repos/settingstest/' + name, {
      headers: { authorization: 'Bearer ' + tokens.avatest },
    })).status === 200)
  for (const name of names)
    await until('history ' + name, async () => (await (await fetch(origin + '/__fixture/history?key=settingstest/' + name)).json()).ready)

  // An unpublished owner view is a completed Pending document. The request
  // queues publication and never invokes the Next producer.
  for (const path of ['/settingstest', '/avatest', '/settingstest?tab=repositories']) {
    const response = await get(path)
    const body = await response.text()
    assert.equal(response.status, 200, `${path} without published HTML: ${response.status} ${body.slice(0, 200)}`)
    assert.match(response.headers.get('content-type'), /text\/html/)
    assert.match(response.headers.get('server-timing') ?? '', /pending publication/, path + ' took the unpublished path')
    assert.equal(response.headers.get('x-gild-state'), 'pending')
    assert.match(body, /data-artifact-pending.*Pending/s)
    assert.doesNotMatch(body, /http-equiv="refresh"/)
  }

  // #64: one themed 404 document for missing repos, private repos the viewer
  // cannot read, and missing owners; the bytes reveal nothing about which.
  const missing = await get('/settingstest/no-such-repo')
  const missingHTML = await missing.text()
  assert.equal(missing.status, 404)
  assert.match(missing.headers.get('content-type'), /text\/html/)
  writeFileSync(join(work, 'missing.html'), missingHTML)
  assert.ok(missingHTML.includes('Nothing lives here'), 'the site 404 message')
  assert.ok(missingHTML.includes('</header>') && missingHTML.includes('</footer>'), 'the site header and footer')
  const same = async (path, headers = html, label = path) => {
    const response = await get(path, headers)
    assert.equal(response.status, 404, label)
    assert.equal(response.headers.get('content-type'), missing.headers.get('content-type'), label)
    assert.equal(response.headers.get('cache-control'), missing.headers.get('cache-control'), label)
    assert.equal(await response.text(), missingHTML, label + ' must be byte-identical to a missing repository')
  }
  await same('/settingstest/docs', html, 'private repo, anonymous')
  await same('/settingstest/docs', { ...html, cookie: 'gild_session=' + cookie('outsider') }, 'private repo, signed-in outsider')
  await same('/settingstest/no-such-repo', { ...html, cookie: 'gild_session=' + cookie('outsider') }, 'missing repo, signed in')
  await same('/settingstest/docs/issues', html, 'private repo issues')
  await same('/settingstest/no-such-repo/issues', html, 'missing repo issues')
  await same('/zzznotauser123', html, 'missing owner')
  const member = await get('/settingstest/docs', { ...html, cookie: 'gild_session=' + cookie('avatest') })
  assert.equal(member.status, 200, 'a member still reads the private repository')
  await member.text()
  // Machines keep the short text bodies; Git still asks for credentials.
  for (const path of ['/settingstest/no-such-repo', '/settingstest/docs']) {
    const text = await get(path, {})
    assert.equal(text.status, 404)
    assert.equal(await text.text(), 'Not found')
    assert.equal((await get(path + '.git/info/refs?service=git-upload-pack', {})).status, 401)
  }

  // #66: publish the anonymous pages, then load them (and the rendered
  // fallbacks above) in Chrome. Any hydration error fails the check.
  // The publisher refuses a render whose input changed while it rendered (an
  // index still writing); wait for its own acceptance.
  for (const route of ['/', '/settingstest', '/settingstest?tab=repositories', '/avatest'])
    await until('publication of ' + route, async () =>
      (await (await fetch(origin + '/__fixture/public-pages?route=' + encodeURIComponent(route))).json()).published, 60000)
  const profile = await (await get('/settingstest?tab=repositories')).text()
  // The page must contain the SVG title that used to render empty, or this check proves nothing.
  assert.match(profile, /<title>\d+ commits in the last year<\/title>/, 'sparkline titles are server rendered')
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const evidence = []
  for (const path of ['/', '/settingstest', '/settingstest?tab=repositories', '/avatest', '/settingstest/no-such-repo'])
    for (const scheme of ['dark', 'light']) {
      const { status, errors, heading } = await pageErrors(path, scheme)
      evidence.push({ path, scheme, status, heading, errors })
      assert.deepEqual(errors.filter(e => hydration.test(e)), [], `${path} (${scheme}) hydration errors`)
      if (path === '/settingstest/no-such-repo') {
        assert.equal(status, 404)
        assert.equal(heading, 'Nothing lives here')
      } else assert.equal(status, 200, path)
    }
  writeFileSync(join(work, 'status-pages.json'), JSON.stringify(evidence, null, 2))
  console.log('Status pages: unpublished pages return Pending (3), one 404 document for missing/private repos and owners (7 reads), no hydration errors on 5 pages x 2 themes')
}
try {
  await verify()
} catch (e) {
  writeFileSync(join(work, 'failure.log'), String(e.stack))
  console.error('Evidence: ' + work)
  throw e
} finally {
  await browser?.close()
  worker.kill('SIGTERM')
  await new Promise(r => worker.exitCode !== null ? r() : worker.once('exit', r))
  await new Promise(r => server.close(r))
}
