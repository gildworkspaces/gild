import { routes } from '../lib/api/contract.ts'
import { launchChrome } from './chrome.mjs'
import { mkdirSync } from 'node:fs'
import assert from 'node:assert/strict'
mkdirSync('.tmp/api-browser', { recursive: true })
const browser = await launchChrome()
try {
  for (const theme of ['light', 'dark'])
    for (const width of [400, 1280]) {
      const page = await browser.newPage({
        viewport: { width, height: 1000 },
        colorScheme: theme,
      })
      await page.addInitScript(
        (theme) => localStorage.setItem('gild.theme', theme),
        theme,
      )
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      const response = await page.goto('http://localhost:8814/docs/api')
      assert.equal(response.status(), 200)
      await page.locator('article h1').waitFor()
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.theme),
        theme,
      )
      assert.equal(await page.locator('article details').count(), routes.length)
      const size = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
      }))
      assert.ok(
        size.scroll <= size.width,
        `${theme} ${width}: ${JSON.stringify(size)}`,
      )
      await page.locator('article details').first().locator('summary').click()
      await page.screenshot({
        path: `.tmp/api-browser/${theme}-${width}.png`,
        fullPage: true,
      })
      assert.deepEqual(errors, [])
      await page.close()
    }
  console.log(
    'API docs: light/dark at 400/1280 px; disclosures work; no horizontal overflow or page errors',
  )
} finally {
  await browser.close()
}
