import { test } from 'node:test'
import assert from 'node:assert/strict'
import { settledHTML } from './settled-html.ts'

// The stream shape React emits for a completed boundary that needs CSS ($RR).
const streamed = '<!DOCTYPE html><html><head><link rel="stylesheet" href="/base.css"></head><body>' +
  '<!--$?--><template id="B:0"></template><p>Loading…</p><!--/$-->' +
  '<div hidden id="S:0"><main>channel</main></div>' +
  '<script>$RR("B:0","S:0",[["/_next/static/chunks/channel.css","next"]])</script></body></html>'

test('a boundary revealed with stylesheets ($RR) is settled, and its CSS is linked', () => {
  const html = settledHTML(streamed)
  assert.ok(!html.includes('hidden id="S:0"') && !html.includes('id="S:0"'), 'content is no longer hidden')
  assert.ok(!html.includes('Loading…'), 'the fallback is replaced')
  assert.match(html, /<body>[\s\S]*<main>channel<\/main>/)
  assert.match(html, /<head>[\s\S]*href="\/_next\/static\/chunks\/channel\.css"[\s\S]*<\/head>/)
  assert.equal(html.match(/base\.css/g)?.length, 1, 'existing links are not duplicated')
})
