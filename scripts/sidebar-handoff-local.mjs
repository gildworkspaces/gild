import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { buildTabClient } from './render-build.mjs'
import { forgeFixture } from './forge-fixture.mjs'
import { publishRepoTabs } from './nav-fixture.mjs'
import { launchChrome } from './chrome.mjs'
import { fixturePendingMenus, verifyAccountMenu } from './signed-in-shell.mjs'

// The real React work loop yields AFTER Sidebar's actual initializer, retaining
// its work-in-progress state. A fixture-only transition selects the concurrent
// lane; hold its continuation until a real pointer click.
// No Suspense remount, fake ready marker, synthetic click or product test hook.
const dir = resolve('.tmp/fragments-review/sidebar-handoff')
mkdirSync(dir, { recursive: true })
const require = createRequire(import.meta.url), schedulerPath = require.resolve('scheduler')
const scheduler = require('scheduler'), proxy = resolve(dir, 'scheduler.mjs')
writeFileSync(proxy, `import actual from ${JSON.stringify(schedulerPath)};
${Object.keys(scheduler).filter(key => !['unstable_shouldYield','unstable_scheduleCallback'].includes(key)).map(key => `export const ${key}=actual.${key};`).join('\n')}
export function unstable_shouldYield(){return window.__sidebarCaptured&&!window.__sidebarReleased||actual.unstable_shouldYield()}
export function unstable_scheduleCallback(priority,callback,options){
 function wrap(fn){return function(...args){const more=fn(...args);if(typeof more!=='function')return more;
  if(window.__sidebarCaptured&&!window.__sidebarReleased){window.__sidebarHeld.push(()=>actual.unstable_scheduleCallback(priority,wrap(more),options));return null}
  return wrap(more)}}
 return actual.unstable_scheduleCallback(priority,wrap(callback),options)
}
`)
const bootstrapPath = resolve('packages/presentation/sidebar-bootstrap.ts')
await buildTabClient(dir, [{ name: 'owned-concurrent-render-hold', setup(build) {
  build.onResolve({ filter: /^scheduler$/ }, () => ({ path: proxy }))
  build.onLoad({filter:/packages\/render\/tab-client\.tsx$/},args=>{
    const source=readFileSync(args.path,'utf8')
    const start='const render = (child: ReactNode) => root.render(',end='      </ViewerProvider>,\n    )'
    assert.equal(source.split(start).length,2);assert.equal(source.split(end).length,2)
    return {loader:'tsx',contents: "import {startTransition} from 'react';\n"+source.replace(start,'const render = (child: ReactNode) => startTransition(() => root.render(').replace(end,'      </ViewerProvider>,\n    ))')}
  })
  build.onLoad({ filter: /sidebar-bootstrap\.ts$/ }, args => {
    assert.equal(args.path, bootstrapPath)
    const original = readFileSync(args.path, 'utf8')
    const mark = "  return intent === 'expanded' ? true : intent === 'collapsed' ? false : undefined"
    assert.equal(original.split(mark).length, 2)
    return { loader: 'ts', contents: original.replace(mark,
      "  if (!(window as any).__sidebarCaptured) (window as any).__sidebarCaptured = { intent: intent ?? null }\n" + mark) }
  })
} }])
const compiled = readFileSync(resolve(dir, 'tab-client.js'))
const evidence = { scenario: 'Genuine click after actual collapsed state initialization, before retained concurrent commit',
  controlledBundleSha256: createHash('sha256').update(compiled).digest('hex'), events: [], outcomes: [] }
const save = () => writeFileSync(resolve(dir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
let releaseModule
const moduleHeld=new Promise(resolve=>{releaseModule=resolve})
const fixture = await forgeFixture({ renderBuild: false, staticReview: true }), base = '/avatest/sidebar-handoff'
fixture.seedRepo('u-avatest', 'sidebar-handoff', [{ path: 'README.md', text: '# Owned sidebar handoff fixture\n' }])
let browser
try {
  await publishRepoTabs(fixture, base)
  browser = await launchChrome()
  const response = await fetch(fixture.origin + '/api/v1/repos' + base + '/visibility', {
    method: 'PATCH', headers: { authorization: 'Bearer ' + fixture.tokens.avatest, 'content-type': 'application/json' },
    body: JSON.stringify({ visibility: 'private' }),
  })
  assert.equal(response.status, 200, await response.text())
  const controlled = { async newContext(options) {
    const context = await browser.newContext(options), newPage = context.newPage.bind(context)
    await context.addInitScript(() => {
      window.__sidebarHeld = []; window.__sidebarReleased = false
      window.__releaseSidebar = () => { window.__sidebarReleased = true; for (const callback of window.__sidebarHeld.splice(0)) callback() }
    })
    context.newPage = async () => {
      const page = await newPage()
      page.on('pageerror', error => evidence.events.push(error.message))
      await page.route('**/gild-fragments/**/tab-client.js', async route => {await moduleHeld; await route.fulfill({ contentType: 'text/javascript', body: compiled })})
      return page
    }
    return context
  } }
  await fixturePendingMenus({ browser: controlled, fixture, base, widths: [400], verifyMenu: async (page, width, label) => {
    // Establish a real prior collapsed intent, rather than allowing the passive
    // storage fallback to accidentally repair an omitted latest-intent handoff.
    assert.equal(await page.locator('.sidebar[data-sidebar-client-ready]').count(),0)
    await page.getByRole('button',{name:'Menu',exact:true}).click()
    assert.equal(await page.getByRole('button',{name:'Menu',exact:true}).getAttribute('aria-expanded'),'true')
    await page.getByRole('button',{name:'Menu',exact:true}).click()
    assert.equal(await page.getByRole('button',{name:'Menu',exact:true}).getAttribute('aria-expanded'),'false')
    releaseModule()
    try { await page.waitForFunction(() => window.__sidebarCaptured && window.__sidebarHeld.length > 0,undefined,{timeout:5000}) }
    catch(error){evidence.holdDiagnostic=await page.evaluate(()=>({captured:window.__sidebarCaptured??null,held:window.__sidebarHeld.length,ready:document.querySelector('.sidebar')?.hasAttribute('data-sidebar-client-ready')}));save();throw error}
    evidence.initialization = await page.evaluate(() => window.__sidebarCaptured)
    assert.equal(evidence.initialization.intent, 'collapsed', 'actual initializer captured the prior real collapsed intent')
    assert.equal(await page.locator('.sidebar[data-sidebar-client-ready]').count(), 0, 'actual render continuation is held before commit')
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: 'Menu', exact: true }).getAttribute('aria-expanded'), 'true', 'genuine click opens SSR rail during retained render')
    evidence.outcomes.push('genuine pointer click opens after captured collapsed initialization and before commit')
    await page.evaluate(() => window.__releaseSidebar())
    await page.locator('.sidebar[data-sidebar-client-ready]').waitFor()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await page.getByRole('button', { name: 'Menu', exact: true }).getAttribute('aria-expanded'), 'true', 'latest click survives retained render commit')
    evidence.outcomes.push('latest intent retained through actual concurrent commit')
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: 'Menu', exact: true }).getAttribute('aria-expanded'), 'false', 'Menu closes once after handoff without pointerdown reopening')
    assert.equal(await page.getByRole('button', { name: 'Expand', exact: true }).count(), 1)
    evidence.outcomes.push('Menu closes once after handoff')
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await verifyAccountMenu(page, width, label)
    assert.deepEqual(evidence.events, [], 'actual component and controlled scheduler have no browser exception')
    save()
  } })
  evidence.outcomes.push('original Collapse checks and prepared recovery complete'); save()
  console.log('PASS genuine initialization-to-commit click, retained open state, Menu-to-close and original Collapse/recovery')
} catch (error) { evidence.failure = error.message; save(); throw error }
finally {
  releaseModule(); await browser?.close()
  fixture.worker.kill('SIGTERM')
  await new Promise(resolve => fixture.worker.exitCode !== null ? resolve() : fixture.worker.once('exit', resolve))
  await new Promise(resolve => fixture.server.close(resolve))
}
