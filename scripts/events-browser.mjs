import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFileSync, mkdirSync } from 'node:fs'
import { launchChrome } from './chrome.mjs'
import assert from 'node:assert/strict'
export async function verifyWebhooks(origin, token, secret) {
  await build({
    entryPoints: ['scripts/events-browser-entry.tsx'],
    outdir: '.tmp/events-browser',
    bundle: true,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
  })
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/api/')) {
      const body = []
      for await (const chunk of req) body.push(chunk)
      const r = await fetch(origin + req.url.replace('/api/', '/api/v1/'), {
        method: req.method,
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
        },
        body: ['GET', 'HEAD'].includes(req.method)
          ? undefined
          : Buffer.concat(body),
      })
      res
        .writeHead(r.status, { 'content-type': 'application/json' })
        .end(await r.text())
      return
    }
    if (req.url === '/app.js' || req.url === '/app.css') {
      res.setHeader(
        'content-type',
        req.url.endsWith('css') ? 'text/css' : 'text/javascript',
      )
      res.end(
        readFileSync(
          '.tmp/events-browser/events-browser-entry.' +
            (req.url.endsWith('css') ? 'css' : 'js'),
        ),
      )
      return
    }
    res.setHeader('content-type', 'text/html')
    res.end(
      '<!doctype html><html data-theme="dark"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><body><div style="padding:16px" id="app"></div><script type="module" src="/app.js"></script></body></html>',
    )
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const browser = await launchChrome(),
    page = await browser.newPage({ viewport: { width: 400, height: 900 } }),
    errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.goto('http://127.0.0.1:' + server.address().port)
    await page
      .getByLabel('Payload URL')
      .fill('https://receiver.example/browser')
    await page.getByLabel('Secret', { exact: true }).fill(secret)
    await page.getByRole('button', { name: 'Create webhook' }).click()
    const hook = page.locator('article').filter({
      has: page.getByRole('heading', {
        name: 'https://receiver.example/browser',
      }),
    })
    await hook.waitFor()
    await hook.getByRole('button', { name: 'Recent deliveries' }).click()
    await hook.locator('details').first().waitFor()
    await page.waitForTimeout(500)
    await hook.getByRole('button', { name: 'Recent deliveries' }).click()
    await hook.locator('summary').first().click()
    await hook.getByRole('button', { name: 'Redeliver' }).first().click()
    await hook.getByRole('button', { name: 'Disable', exact: true }).click()
    await hook.getByRole('button', { name: 'Enable', exact: true }).waitFor()
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      )
      const contrast = await page
        .getByRole('button', { name: 'Create webhook' })
        .evaluate((button) => {
          const c = getComputedStyle(button),
            luminance = (value) => {
              const rgb = value
                .match(/[0-9.]+/g)
                .slice(0, 3)
                .map(Number)
                .map((n) => {
                  const x = n / 255
                  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
                })
              return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
            },
            a = luminance(c.color),
            b = luminance(c.backgroundColor)
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
        })
      assert.ok(contrast >= 4.5, theme + ' create button contrast ' + contrast)
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      )
      mkdirSync('.tmp/events-browser-evidence', { recursive: true })
      await page.screenshot({
        path: '.tmp/events-browser-evidence/' + theme + '-400.png',
        fullPage: true,
      })
    }
    assert.deepEqual(errors, [])
    assert.equal((await hook.textContent()).includes(secret), false)
    await hook.getByRole('button', { name: 'Delete', exact: true }).click()
    await hook.waitFor({ state: 'detached' })
    console.log(
      'Webhooks browser: create, delivery log, redeliver, toggle/delete; light/dark 400px passed',
    )
  } finally {
    await browser.close()
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
}
