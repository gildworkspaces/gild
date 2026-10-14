import { build } from 'esbuild'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { launchChrome } from './chrome.mjs'
import assert from 'node:assert/strict'

mkdirSync('.tmp/picture-review', { recursive: true })
const entry = `import {useState} from 'react';import {Picture} from '../../components/Picture';
export function App(){const [picture,setPicture]=useState({url:'https://www.gravatar.com/avatar/'+ 'a'.repeat(64)+'?d=404',source:'Gravatar'});
return <><Picture name="fixture" picture={picture} size={52} showSource/>
<button onClick={()=>setPicture({url:'https://www.gravatar.com/avatar/'+ 'b'.repeat(64)+'?d=404',source:'Gravatar'})}>Present</button>
<button onClick={()=>setPicture({url:'https://www.gravatar.com/avatar/'+ 'a'.repeat(64)+'?d=404',source:'Gravatar'})}>Missing</button>
<button onClick={()=>setPicture({url:'/photo.png',source:'Uploaded'})}>Upload</button>
<button onClick={()=>setPicture({url:null,source:'None'})}>No email</button></>}`
writeFileSync('.tmp/picture-review/App.tsx', entry)
await build({
  stdin: {
    contents: `import {renderToString} from 'react-dom/server';import {App} from './.tmp/picture-review/App';export const html=renderToString(<App/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  jsx: 'automatic',
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: '.tmp/picture-review/ssr.mjs',
})
const { html } = await import('../.tmp/picture-review/ssr.mjs')
await build({
  stdin: {
    contents: `import {hydrateRoot} from 'react-dom/client';import {App} from './.tmp/picture-review/App';hydrateRoot(document.getElementById('root'),<App/>);window.__hydrated=true;`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: '.tmp/picture-review/client.js',
})
const server = createServer((req, res) => {
  if (req.url === '/client.js')
    setTimeout(
      () =>
        res
          .writeHead(200, { 'content-type': 'text/javascript' })
          .end(readFileSync('.tmp/picture-review/client.js')),
      500,
    )
  else if (req.url === '/photo.png')
    res
      .writeHead(200, { 'content-type': 'image/png' })
      .end(readFileSync('public/sami.png'))
  else
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        `<!doctype html><html><body><div id="root">${html}</div><script defer src="/client.js"></script></body></html>`,
      )
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const browser = await launchChrome()
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route('https://www.gravatar.com/avatar/**', (route) =>
    route.fulfill(
      route.request().url().includes('a'.repeat(64))
        ? { status: 404, body: '' }
        : {
            status: 200,
            contentType: 'image/png',
            body: readFileSync('public/sami.png'),
          },
    ),
  )
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const source = async (value) => {
    await page.locator(`[data-picture-source="${value}"]`).waitFor()
    if (value === 'None')
      assert.equal(await page.locator('[data-picture-source] svg').count(), 1)
    else
      await page.waitForFunction(
        () =>
          document.querySelector('[data-picture-source] img')?.naturalWidth > 0,
      )
  }
  await source('None')
  assert.ok(await page.getByRole('link', { name: 'Set up Gravatar' }).count())
  for (const [button, value] of [
    ['Present', 'Gravatar'],
    ['Missing', 'None'],
    ['Present', 'Gravatar'],
    ['Upload', 'Uploaded'],
    ['No email', 'None'],
  ]) {
    await page.getByRole('button', { name: button, exact: true }).click()
    await source(value)
  }
  assert.deepEqual(errors, [])
  console.log(
    'Picture browser: 404 before hydration -> silhouette; URL changes retry, present Gravatar/upload/no email passed',
  )
} finally {
  await browser.close()
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
}
