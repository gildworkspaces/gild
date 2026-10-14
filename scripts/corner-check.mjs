// Design rule (Sami, 8 Oct): signed in, the search pill floats alone in
// the top-right corner, and every page leaves that corner empty at rest, so
// content only passes under the pills when you scroll. This opens each
// signed-in page at three widths and fails on any glyph or painted box inside
// the pills' box plus a 12px margin.
//
//   node scripts/corner-check.mjs [base]   (default http://localhost:1438 — `wrangler dev` on a build)
//
// Signs a local session with SESSION_SECRET from .dev.vars; the pages use the
// throwaway avatest repos.
import { cornerHits } from './corner-probe.mjs'
import { launchChrome } from './chrome.mjs'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { publicPageRoute } from '../lib/public-page-route.ts'
const base = process.argv[2] ?? 'http://localhost:1438'
const fixture=process.argv[3]?JSON.parse(readFileSync(process.argv[3],'utf8')):null
const pages = ['/settingstest', '/settingstest?tab=repositories', '/settingstest/ky', '/orgs/settingstest/settings/runners','/orgs/settingstest/settings/runners/new/macos','/orgs/settingstest/settings/runner-groups','/orgs/settingstest/settings/runner-groups/default','/settings/runner-groups','/settings/runners/new/linux','/avatest/glance-test/settings/runners/new/windows','/settings/profile','/settings/organizations','/settings/keys','/settings/tokens','/settings/agents','/settings/runners', '/orgs/settingstest/settings/general','/orgs/settingstest/settings/members','/orgs/settingstest/settings/webhooks', '/avatest/glance-test/settings/general','/avatest/glance-test/settings/actions','/avatest/glance-test/settings/webhooks','/dashboard', '/agents', '/keys', '/settings', '/new', '/runners', '/avatest',
  '/avatest/glance-test', '/avatest/glance-test?path=lib/pulls.ts', '/avatest/glance-test/issues', '/avatest/glance-test/pulls',
  '/avatest/glance-test/pulls/1', '/avatest/glance-test/pulls/1?tab=glance', '/avatest/glance-test/pulls/1?tab=files',
  '/avatest/glance-test/actions', '/avatest/glance-test/actions/2', '/avatest/glance-test/agents', '/avatest/glance-test/score',
  '/avatest/glance-test/commit/9a540d9982c68d611895b496e0e5979b160c0ae0', '/avatest/glance-test/search?q=createPull', '/search?q=createPull']
const secret = fixture?.secret ?? readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').match(/^SESSION_SECRET=["']?([^"'\n]+)/m)[1]
const payload = Buffer.from(JSON.stringify({ publicKey: 'ed25519:corner-test', name: 'avatest', at: new Date().toISOString() })).toString('base64url')
const mac = createHmac('sha256', secret).update(payload).digest('base64url')
const b = await launchChrome()
let bad = 0
for (const width of [1400, 1100, 400]) {
  const ctx = await b.newContext({ viewport: { width, height: 900 }, colorScheme: 'dark' })
  await ctx.addCookies([{ name: 'gild_session', value: `${payload}.${mac}`, domain: new URL(base).hostname, path: '/', httpOnly: true, secure: base.startsWith('https') }])
  const p = await ctx.newPage()
  for (let path of pages) {
    if(fixture)path=path.replaceAll('9a540d9982c68d611895b496e0e5979b160c0ae0',fixture.sha).replace('/pulls/1','/pulls/2')
    // Next can deliver these redirects after the streamed response has loaded.
    // Measure the destination, and let navigation errors fail the check.
    const destination = ({ '/keys': '/settings/keys', '/settings': '/settings/profile', '/runners': '/settings/runners' })[path] ?? path
    // This fixture writes refs directly and has no cron scheduler. Prepare
    // its snapshots through the production producer before measuring them.
    if (fixture && publicPageRoute(new URL(path, base))) {
      const prepared = await fetch(base + '/__fixture/public-pages?route=' + encodeURIComponent(path))
      assert.equal(prepared.status, 200, `prepare ${path}`)
      assert.equal((await prepared.json()).published, true, `published ${path}`)
    }
    const response = await p.goto(base + path, { waitUntil: 'commit' })
    assert.ok(response.status() === 200 || (destination !== path && [301, 302, 307, 308].includes(response.status())),
      `${width}px ${path}: document HTTP ${response.status()}`)
    await p.waitForURL(new URL(destination, base).href, { waitUntil: 'load' })
    await p.waitForTimeout(900)
    const hits = await p.evaluate(cornerHits).catch(error => { throw new Error(`${width}px ${path}: ${error.message}`, { cause: error }) })
    if (hits.length) { bad++; console.log(`✗ ${width}px ${path}\n    ${hits.join('\n    ')}`) }
  }
  await ctx.close()
}
// Cover the immutable Code shell signed out and with a signed-in cookie,
// before the identity/router bundle is allowed to execute.
for (const signedIn of [false, true]) {
  const ctx = await b.newContext({ viewport: { width: 400, height: 900 } })
  if (signedIn) await ctx.addCookies([{ name: 'gild_session', value: `${payload}.${mac}`, url: base }])
  const p = await ctx.newPage()
  await p.route('**/router.js', route => route.abort())
  await p.goto(base + '/avatest/glance-test', { waitUntil: 'load' })
  await p.locator('[data-fragment-root]').waitFor()
  await p.evaluate(() => document.fonts.ready)
  const hits = await p.evaluate(cornerHits)
  if (hits.length) { bad++; console.log(`✗ 400px cold Code ${signedIn ? 'owner' : 'anonymous'}: ${hits.join(', ')}`) }
  await ctx.close()
}
console.log(bad ? `${bad} page/width combos intrude on the corner` : 'corner clear on every page at every width')
await b.close()
process.exit(bad ? 1 : 0)
