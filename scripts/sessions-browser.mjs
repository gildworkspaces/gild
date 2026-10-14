import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFileSync, mkdirSync } from 'node:fs'
import { launchChrome } from './chrome.mjs'
import assert from 'node:assert/strict'
export async function verifyReceipts(origin, token) {
  await build({
    entryPoints: ['scripts/sessions-browser-entry.tsx'],
    outdir: '.tmp/sessions-browser',
    bundle: true,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    plugins: [
      {
        name: 'link-adapter',
        setup(b) {
          b.onResolve({ filter: /^next\/link$/ }, () => ({
            path: 'next-link',
            namespace: 'fixture',
          }))
          b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents:
              "import React from 'react';export default function Link({href,children,...props}){return React.createElement('a',{href,...props},children)}",
            loader: 'js',
            resolveDir: process.cwd(),
          }))
        },
      },
    ],
  })
  const server = createServer(async (req, res) => {
    if (req.url === '/receipts') {
      const r = await fetch(
        origin + '/api/v1/repos/acme/demo/pulls/2/sessions',
        { headers: { authorization: 'Bearer ' + token } },
      )
      res.setHeader('content-type', 'application/json')
      res.end(await r.text())
      return
    }
    if (req.url === '/app.js' || req.url === '/app.css') {
      res.setHeader(
        'content-type',
        req.url.endsWith('css') ? 'text/css' : 'text/javascript',
      )
      res.end(
        readFileSync(
          '.tmp/sessions-browser/sessions-browser-entry.' +
            (req.url.endsWith('css') ? 'css' : 'js'),
        ),
      )
      return
    }
    res.setHeader('content-type', 'text/html')
    res.end(
      '<!doctype html><html data-theme="dark"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><body><div id="app" style="padding:16px"></div><script type="module" src="/app.js"></script></body></html>',
    )
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const browser = await launchChrome(),
    page = await browser.newPage({ viewport: { width: 400, height: 1000 } }),
    errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.goto('http://127.0.0.1:' + server.address().port)
    await page.getByRole('heading', { name: 'How this was made' }).waitFor()
    await page
      .locator('section[aria-label="Agent session receipts"] summary')
      .first()
      .click()
    await page.getByText('Reported exit 1 · 0.010s').waitFor()
    await page.getByRole('heading', { name: 'Reported files read' }).waitFor()
    assert.equal(await page.locator('[data-receipt-read="true"]').count(), 2)
    assert.equal(await page.locator('[data-receipt-written="true"]').count(), 1)
    await page.getByText(/Stored revision 2 · Agent reported completion/).waitFor()
    assert.equal(await page.getByText('Receipt proof', {exact:true}).count(), 0)
    assert.equal(await page.locator('section[aria-label="Agent session receipts"] > p').count(), 0)
    assert.match(await page.locator('section[aria-label="Agent session receipts"]').textContent(), /Reported model:.*Reported usage:.*Reported cost:/s)
    const command = page.locator('section[aria-label="Agent session receipts"] li details').first()
    assert.equal(await command.getAttribute('open'), null)
    await command.locator('summary').click()
    assert.ok((await command.locator('code').textContent()).length <= 1024)
    assert.match(await page.locator('section[aria-label="Agent session receipts"]').textContent(), /Reported notes:.*redacted/)
    assert.doesNotMatch(await page.locator('body').textContent(), /ghp_abcdefghijklmnopqrstuvwxyz/)
    assert.match(await page.locator('body').textContent(), /USD 0.0123/)
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      )
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      )
      mkdirSync('.tmp/sessions-browser-evidence', { recursive: true })
      await page.screenshot({
        path: '.tmp/sessions-browser-evidence/' + theme + '-400.png',
        fullPage: true,
      })
    }
    assert.deepEqual(errors, [])
    console.log(
      'Receipt browser: command outcomes, times/usage/cost, files, proof, actual Glance read/write overlays; light/dark 400px passed',
    )
  } finally {
    await browser.close()
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
}
