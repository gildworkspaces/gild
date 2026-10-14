import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryStore } from './drivers/memory.ts'
import { privacyHTTP } from './privacy-http.ts'
import { htmlNavigation, missingPage, preparingPage, routingFailure, stillPreparing, PREPARING_REFRESH_S, MISSING_DOCUMENT } from './status-pages.ts'
import { ApiError } from './api/errors.ts'
import type { EdgeCache } from './fragments/edge.ts'

const browser = { accept: 'text/html,application/xhtml+xml' }
const SHELL = '<!doctype html><html lang="en"><head><title>gild</title></head><body><header class="site-header">gild</header><main><div data-fragment-root=""><!--gild-content--></div></main><footer>site footer</footer></body></html>'
const NOT_FOUND = '<!doctype html><html lang="en"><body><header>gild</header><h1>Nothing lives here</h1><footer>site footer</footer></body></html>'

function edgeFixture() {
  const entries = new Map<string, Response>(), pending: Promise<unknown>[] = []
  const edge: EdgeCache = {
    async match(r) { return entries.get(r.url)?.clone() },
    async put(r, value) { entries.set(r.url, value) },
  }
  return { edge, ctx: { waitUntil(p: Promise<unknown>) { pending.push(p) } }, flush: () => Promise.all(pending.splice(0)) }
}

test('browser navigations are told apart from API, Git and asset reads', () => {
  assert.equal(htmlNavigation(new Request('https://gild.gg/acme/repo', { headers: browser })), true)
  assert.equal(htmlNavigation(new Request('https://gild.gg/acme', { headers: browser, method: 'HEAD' })), true)
  assert.equal(htmlNavigation(new Request('https://gild.gg/acme/repo')), false, 'no Accept: text/html')
  assert.equal(htmlNavigation(new Request('https://gild.gg/api/v1/repos/acme/repo', { headers: browser })), false)
  assert.equal(htmlNavigation(new Request('https://gild.gg/acme/repo.git/info/refs', { headers: browser })), false)
  assert.equal(htmlNavigation(new Request('https://gild.gg/acme/repo', { headers: browser, method: 'POST' })), false)
})

test('missing and private repositories get the same site 404 document, rendered anonymously once per build (#64)', async () => {
  const store = memoryStore()
  await store.createOrg('acme', null, 'owner')
  await store.publishRepoAccess('acme/secret', 'meta-private', { visibility: 'private', read: ['@reader'] })
  const { edge, ctx, flush } = edgeFixture()
  const renders: Request[] = []
  const render = async (r: Request) => { renders.push(r); return new Response(NOT_FOUND, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } }) }
  const services = { store, index: async () => null, viewer: async () => null, missingPage: (r: Request) => missingPage(r, 'build-1', render, ctx, edge) }
  let forwarded = 0
  const read = async (path: string, headers: Record<string, string> = browser) => {
    const response = await privacyHTTP(new Request('https://gild.gg' + path, { headers: { ...headers, cookie: 'gild_session=viewer' } }), services,
      async () => { forwarded++; return new Response('private-marker') })
    await flush()
    return { status: response.status, type: response.headers.get('content-type'), cache: response.headers.get('cache-control'), body: await response.text() }
  }
  const missing = await read('/acme/nothing')
  assert.deepEqual(missing, { status: 404, type: 'text/html; charset=utf-8', cache: 'private, no-store', body: NOT_FOUND })
  assert.deepEqual(await read('/acme/secret'), missing, 'a private repository is indistinguishable from a missing one')
  assert.deepEqual(await read('/acme/secret/issues'), missing)
  assert.equal(forwarded, 0)
  assert.equal(renders.length, 1, 'one render per build, then the edge copy')
  assert.equal(new URL(renders[0].url).pathname, MISSING_DOCUMENT)
  assert.equal(renders[0].headers.get('cookie'), null, 'the 404 never depends on the viewer')
  // API and Git callers keep their short bodies and statuses.
  assert.deepEqual(await read('/acme/nothing', {}), { status: 404, type: 'text/plain;charset=UTF-8', cache: 'private, no-store', body: 'Not found' })
  assert.deepEqual(await read('/acme/secret', {}), { status: 404, type: 'text/plain;charset=UTF-8', cache: 'private, no-store', body: 'Not found' })
  assert.equal((await read('/acme/secret.git/info/refs', browser)).status, 401)
  // A render that is not an anonymous HTML document is never cached or served.
  const broken = await missingPage(new Request('https://gild.gg/acme/x', { headers: browser }), 'build-2',
    async () => new Response('<html></html>', { headers: { 'content-type': 'text/html', 'set-cookie': 'a=b' } }), ctx, edge)
  assert.equal(broken.status, 404)
  assert.equal(await broken.text(), 'Not found')
  // Nor one that left its content to the client (an empty streamed body).
  const empty = await missingPage(new Request('https://gild.gg/acme/x', { headers: browser }), 'build-3',
    async () => new Response('<html><body><template data-dgst="BAILOUT_TO_CLIENT_SIDE_RENDERING"></template></body></html>', { headers: { 'content-type': 'text/html' } }), ctx, edge)
  assert.equal(await empty.text(), 'Not found')
})

test('pending content returns a complete themed document without reloading or blocking', async () => {
  const request = new Request('https://gild.gg/acme/repo/score', { headers: browser })
  const page = await preparingPage(request, async () => SHELL)
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(page.headers.get('retry-after'), String(PREPARING_REFRESH_S))
  const body = await page.text()
  assert.equal(page.headers.get('x-gild-state'), 'pending')
  assert.ok(!body.includes('http-equiv="refresh"'), 'pending does not reload the entire page')
  assert.ok(body.includes('<header class="site-header">') && body.includes('site footer'), 'inside the site shell')
  assert.ok(body.includes('Pending'))
  // The renderer being down still yields a themed document.
  const fallback = await (await preparingPage(request, async () => { throw Error('renderer down') })).text()
  assert.ok(fallback.includes("localStorage.getItem('gild.theme')") && fallback.includes('html[data-theme=dark]'))
  assert.ok(fallback.includes('Pending') && !fallback.includes('http-equiv="refresh"'))
  // Callers get an explicit pending state, distinct from an error.
  const api = await preparingPage(new Request('https://gild.gg/api/v1/repos/acme/repo/commits'), async () => SHELL)
  assert.equal(api.status, 202)
  assert.deepEqual(await api.json(), { state: 'pending', retryAfter: PREPARING_REFRESH_S })
})

test('only indexing errors look like indexing; other errors are logged as errors (#63)', async () => {
  assert.equal(stillPreparing(new ApiError(503, 'Repository is indexing; retry shortly')), true)
  assert.equal(stillPreparing(new Error('Pointer unavailable')), true)
  assert.equal(stillPreparing(new Error('Fragment unavailable')), true)
  assert.equal(stillPreparing(new TypeError("Cannot read properties of undefined (reading 'tip')")), false)
  const request = new Request('https://gild.gg/acme/repo', { headers: browser })
  const logged: unknown[][] = [], original = console.error
  console.error = (...args: unknown[]) => { logged.push(args) }
  try {
    const preparing = await routingFailure(request, new ApiError(503, 'Commit records are indexing; retry shortly'), async () => SHELL)
    assert.equal(preparing.status, 200)
    assert.equal(logged.length, 0)
    const bug = new TypeError('fixture bug')
    const failed = await routingFailure(request, bug, async () => SHELL)
    assert.equal(failed.status, 500)
    const body = await failed.text()
    assert.ok(body.includes('Something went wrong') && !body.includes('http-equiv="refresh"'))
    assert.equal(logged.length, 1)
    assert.ok(logged[0].includes(bug), 'the original error is logged')
    const api = await routingFailure(new Request('https://gild.gg/api/v1/repos/acme/repo'), bug, async () => SHELL)
    assert.equal(api.status, 500)
    assert.equal(await api.text(), 'Internal error')
  } finally { console.error = original }
})
