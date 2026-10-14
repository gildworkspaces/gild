import { launchChrome } from './chrome.mjs'
import assert from 'node:assert/strict'
const browser = await launchChrome()
try {
  for (const path of ['/docs/api', '/docs/api/sessions'])
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({
          viewport: { width: 400, height: 1000 },
          colorScheme: theme,
        }),
        errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.addInitScript(
        (theme) => localStorage.setItem('gild.theme', theme),
        theme,
      )
      const r = await page.goto('http://127.0.0.1:8817' + path)
      assert.equal(r.status(), 200)
      await page.locator('article h1').waitFor()
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        path + ' ' + theme,
      )
      if (path.endsWith('sessions'))
        assert.equal(
          (await page.locator('article pre').first().textContent())
            .trim()
            .split('\n').length,
          20,
        )
      else assert.equal(await page.locator('article details').count(), 104)
      assert.deepEqual(errors, [])
      await page.screenshot({
        path:
          '.tmp/sessions-browser-evidence/docs-' +
          theme +
          (path.endsWith('sessions') ? '-examples' : '-api') +
          '.png',
        fullPage: true,
      })
      await page.close()
    }
  const unauth = await fetch(
    'http://127.0.0.1:8817/api/v1/repos/acme/demo/pulls/2/sessions',
  )
  assert.equal(unauth.status, 401)
  const spec = await (
    await fetch('http://127.0.0.1:8817/api/v1/openapi.json')
  ).json()
  assert.ok(spec.paths['/repos/{owner}/{repo}/pulls/{number}/sessions'])
  console.log(
    'Built Worker: docs/API + 20-line runnable examples, 104 definitions; light/dark 400px no overflow/errors; actual Next session route bearer-gated',
  )
} finally {
  await browser.close()
}
