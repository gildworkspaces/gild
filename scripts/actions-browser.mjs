// Production React components + CSS, attached to the actual wrangler fixture
// API. Navigation adapters replace Next's router in this isolated harness.
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { launchChrome } from './chrome.mjs'
import assert from 'node:assert/strict'
process.env.TMPDIR = resolve('.tmp')
const fixture = JSON.parse(
  readFileSync('.tmp/actions-browser-fixture.json', 'utf8'),
)
await build({
  entryPoints: ['scripts/actions-browser-entry.tsx'],
  outdir: '.tmp/actions-browser',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  plugins: [
    {
      name: 'navigation-adapter',
      setup(build) {
        build.onResolve({ filter: /^next\/(link|navigation)$/ }, (a) => ({
          path: a.path,
          namespace: 'fixture-next',
        }))
        build.onLoad({ filter: /.*/, namespace: 'fixture-next' }, (a) => ({
          contents: a.path.endsWith('link')
            ? "import React from 'react';export default function Link({href,children,...props}){return React.createElement('a',{href,...props},children)}"
            : 'export function usePathname(){return location.pathname};export function useRouter(){return {push:(url)=>location.assign(url)}}',
          loader: 'js',
          resolveDir: process.cwd(),
        }))
      },
    },
  ],
})
const server = createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    const data = []
    for await (const chunk of req) data.push(chunk)
    const r = await fetch(fixture.origin + req.url, {
      method: req.method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${fixture.token}`,
      },
      body: ['GET', 'HEAD'].includes(req.method)
        ? undefined
        : Buffer.concat(data),
    })
    res.writeHead(r.status, { 'content-type': 'application/json' })
    res.end(await r.text())
    return
  }
  if (req.url === '/fixture-props') {
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({ view: fixture.view, workflows: fixture.workflows }),
    )
    return
  }
  if (req.url === '/app.js' || req.url === '/app.css') {
    res.setHeader(
      'content-type',
      req.url.endsWith('css') ? 'text/css' : 'text/javascript',
    )
    res.end(
      readFileSync(
        `.tmp/actions-browser/actions-browser-entry.${req.url.endsWith('css') ? 'css' : 'js'}`,
      ),
    )
    return
  }
  res.setHeader('content-type', 'text/html')
  res.end(
    '<!doctype html><html data-theme="dark" style="--font-schibsted:Arial;--font-jetbrains:monospace"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>',
  )
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
mkdirSync('.tmp/actions-evidence', { recursive: true })
const browser = await launchChrome(),
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } }),
  errors = []
page.on('pageerror', (e) => errors.push(e.message))
try {
  await page.goto(`${origin}/acme/demo/actions`)
  await page.getByText('Runners — your machines').waitFor()
  await page.getByText('All runs', { exact: true }).waitFor()
  assert.equal(
    await page
      .getByRole('navigation', { name: 'Repository' })
      .getByRole('link', { name: 'Actions' })
      .getAttribute('aria-current'),
    'page',
  )
  await page.screenshot({
    path: '.tmp/actions-evidence/board-dark.png',
    fullPage: true,
  })
  await page.getByRole('button', { name: 'ci.yml', exact: true }).click()
  await page
    .getByRole('button', { name: 'Run workflow', exact: true })
    .waitFor()
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'))
  await page.screenshot({
    path: '.tmp/actions-evidence/board-light.png',
    fullPage: true,
  })
  await page.setViewportSize({ width: 400, height: 844 })
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= 400),
    true,
  )
  await page.screenshot({ path: '.tmp/actions-evidence/board-phone.png' })
  await page.goto(`${origin}/acme/demo/actions/${fixture.detail.run.id}`)
  await page.getByText('Echo', { exact: true }).waitFor()
  await page.getByText('Node', { exact: true }).waitFor()
  await page.getByText('Echo', { exact: true }).click()
  await page.getByText('Node', { exact: true }).click()
  await page.getByText('hello from gild', { exact: false }).waitFor()
  await page.getByText('answer=42', { exact: false }).waitFor()
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= 400),
    true,
  )
  assert.doesNotMatch(
    await page.locator('body').textContent(),
    /local-fixture-secret/,
  )
  await page.screenshot({ path: '.tmp/actions-evidence/run-phone.png', fullPage: true })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.screenshot({ path: '.tmp/actions-evidence/run-dark.png', fullPage: true })
  await page.goto(`${origin}/acme/demo/actions/${fixture.failure.run.id}`)
  const failedLog = page.locator('details[open] pre')
  await failedLog.getByText("gild doesn't run unsupported/action@v1 yet", { exact: false }).waitFor()
  const logsLink = page.getByRole('link', { name: 'View job logs' }).first()
  const logURL = await logsLink.getAttribute('href')
  const apiLogs = await (await page.request.get(origin + logURL)).json()
  assert.ok(apiLogs.logs.some(chunk => chunk.text.includes("gild doesn't run unsupported/action@v1 yet")))
  await page.screenshot({ path: '.tmp/actions-evidence/failed-step-logs.png', fullPage: true })
  await page.goto(`${origin}/acme/demo/actions/${fixture.detail.run.id}`)
  await page.getByRole('button', { name: 'Re-run', exact: true }).click()
  await page.waitForURL(
    (u) => u.pathname !== `/acme/demo/actions/${fixture.detail.run.id}`,
  )
  await page.getByRole('button', { name: 'Cancel run', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
  await page.getByRole('button', { name: 'Re-run', exact: true }).waitFor()
  await page.goto(`${origin}/acme/demo/actions`)
  await page.getByRole('button', { name: 'ci.yml', exact: true }).click()
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await page.waitForURL(/\/actions\/\d+$/)
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
  await page.getByRole('button', { name: 'Re-run', exact: true }).waitFor()
  assert.deepEqual(errors, [])
  console.log(
    'Chrome: actual Actions components, dark/light, 400px board/run, masked logs, workflow selection, dispatch, re-run and cancellation passed.',
  )
} finally {
  await browser.close()
  await new Promise((r) => server.close(r))
}
