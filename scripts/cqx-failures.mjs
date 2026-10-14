// Real production pages, D1 and a fault-injecting heavy RPC Worker on workerd.
import { forgeFixture } from './forge-fixture.mjs'
import { HEAVY_MAX_BYTES, HEAVY_MAX_FILES } from '../lib/cqx-heavy-limits.ts'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { launchChrome } from './chrome.mjs'

const c = [
  { path: 'CMakeLists.txt', text: 'add_library(demo src/lib.c)' },
  {
    path: 'src/lib.c',
    text: '#include <stdio.h>\nvoid format(char *out, const char *s) { sprintf(out, "%s", s); }\n',
  },
]
const ts = [
  { path: 'package.json', text: '{"name":"demo"}' },
  {
    path: 'src/index.ts',
    text: 'export function unsafe() { eval("hello") }\n',
  },
]
const pullGlanceOnly=process.argv.includes('--outage-pull-glance-only')
const focused=process.argv.includes('--outage-score-only')||pullGlanceOnly
const permanentPending=focused&&process.argv.includes('--permanent-pending')
const f = await forgeFixture({ cqxModules: true, cqxFaults: true, renderBuild: !focused, staticReview: pullGlanceOnly })
mkdirSync('.tmp/cqx-review', { recursive: true })
let browser
const evidence = []
try {
  const shas = {}
  const fixtures = [
    ['partial', [...c, ...ts]],
    ['c-only', c],
    ['mismatch', [...c, ...ts]],
    [
      'too-many',
      [
        ...ts,
        ...Array.from({ length: HEAVY_MAX_FILES + 1 }, (_, i) => ({
          path: `src/f${i}.c`,
          text: 'int n;\n',
        })),
      ],
    ],
    [
      'too-many-bytes',
      [
        ...ts,
        ...Array.from({ length: 12 }, (_, i) => ({
          path: `src/b${i}.c`,
          text: '// ' + 'x'.repeat(450 * 1024),
        })),
      ],
    ],
    [
      'too-big',
      [
        ...ts,
        { path: 'src/huge.c', text: '// ' + 'x'.repeat(HEAVY_MAX_BYTES) },
      ],
    ],
  ]
  for (const [name,files] of focused ? fixtures.slice(0,1) : fixtures)
    shas[name] = f.seedRepo('u-avatest', name, files)
  // Exercise the parent comparison as well as PR base coverage.
  const partialDir = f.gitRoot + '/u-avatest/partial.git'
  appendFileSync(partialDir + '/src/index.ts', '// child commit\n')
  f.git(partialDir, 'add', '.')
  f.git(
    partialDir,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'Fixture child',
  )
  shas.partial = f.git(partialDir, 'rev-parse', 'HEAD')
  if(!focused)f.seedRepo('o-settingstest', 'partial', [...c, ...ts])
  const deadline = Date.now() + 90000
  while (true) {
    try {
      if ((await fetch(f.origin + '/api/v1/openapi.json')).ok) break
    } catch {}
    if (f.worker.exitCode !== null || Date.now() > deadline)
      throw Error('Worker startup failed: ' + f.logs.slice(-4000))
    await new Promise((r) => setTimeout(r, 250))
  }
  const mode = async (value) =>
    assert.equal(
      (await fetch(f.origin + '/__fixture/cqx-mode?mode=' + value)).status,
      200,
    )
  browser = await launchChrome()
  const page = await browser.newPage()
  let sawPending=false,heldDelivery=false
  const preparedDocument = async (response,path) => {
    const html=await response.text(),pending=response.headers()['x-gild-state']==='pending'||html.includes('data-artifact-pending')
    evidence.push({readiness:{path,status:response.status(),state:response.headers()['x-gild-state']??null,pending}})
    if(pending){
      sawPending=true;writeFileSync('.tmp/cqx-review/preparation-pending.html',html)
      if(permanentPending&&!heldDelivery){
        // Transport challenge replays an ACTUAL captured fixture response.
        // This is not evidence that the underlying producer is blocked.
        await page.route(f.origin+'/avatest/partial/score?cat=security',route=>route.fulfill({status:200,headers:{'content-type':'text/html','x-gild-state':'pending'},body:html}))
        heldDelivery=true;evidence.push({transportPermanentPending:true,path})
      }
    }
    return ![404,503].includes(response.status())&&!pending
  }
  // The publisher refuses a render whose input changed while it rendered
  // (the index is still writing); the Worker then answers 503 + retry-after.
  // Wait for the publisher's own acceptance, not for a fixed time.
  const gotoPublished = async (route, deadline) => {
    while (true) {
      const publish = await fetch(f.origin + '/__fixture/public-pages?route=' + encodeURIComponent(route))
      assert.equal(publish.status, 200, await publish.clone().text())
      if ((await publish.json()).published) {
        const response = await page.goto(f.origin + route)
        if (await preparedDocument(response,route)) return response
      }
      if (Date.now() > deadline) throw new Error('publication did not settle: ' + route)
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  const check = async (
    name,
    path,
    note,
    { scored = true, redirect = false, partial = true } = {},
  ) => {
    const started = performance.now()
    let response
    const until = Date.now() + 90000
    // Direct fixture Git writes have no production push hook. Wait for the
    // real index/Queue publication; requests themselves only stitch HTML.
    do {
      if(path.startsWith('/pulls/')){
        const publication=await fetch(f.origin+'/__fixture/public-pages?route='+encodeURIComponent('/avatest/'+name+path))
        evidence.push({publication:{route:name+path,status:publication.status,body:await publication.text()}})
      }
      response = await page.goto(f.origin + '/avatest/' + name + path)
      if (await preparedDocument(response,name+path)) break
      if (Date.now() > until)
        throw Error('render publication did not settle: ' + name + path)
      await page.waitForTimeout(200)
    } while (true)
    if(pullGlanceOnly){
      writeFileSync('.tmp/cqx-review/public-pull-glance.html',await response.text())
      const body=await page.locator('body').innerText()
      writeFileSync('.tmp/cqx-review/public-pull-glance-dom.txt',body)
      const calls=JSON.parse(response.headers()['x-fixture-calls'])
      for(const key of ['do','render','queue','next','publication'])assert.equal(calls[key],0,'prepared public Glance GET must not call '+key)
      evidence.push({document:{url:page.url(),status:response.status(),state:response.headers()['x-gild-state']??null,cache:response.headers()['cache-control'],calls,scoreNodes:await page.locator('#score').count(),body}})
    }
    assert.equal(response.status(), 200, path)
    const score =
      path === ''
        ? page
            .getByRole('heading', { name: 'Code Score', exact: true })
            .locator('..')
        : page.locator('#score')
    assert.match(
      await score.innerText(),
      note,
      name + path + ' must explain C-family failure',
    )
    if (scored && path !== '') {
      assert.equal(
        await score.locator('svg').count(),
        5,
        'keep other-language dials',
      )
      assert.match(
        await score.innerText(),
        /dynamic-code/,
        'other-language finding remains visible',
      )
      if(partial)assert.doesNotMatch(
        await score.innerText(),
        /\[c\/|\[cpp\/|\[csharp\//,
        'no C-family finding or score',
      )
    }
    if (!scored)
      assert.equal(
        await score.locator('svg').count(),
        0,
        'C-only failure must not show 100 or 0 dials',
      )
    if (redirect)
      assert.match(
        page.url(),
        /\/score\?cat=security$/,
        'health preserves query when redirecting',
      )
    console.log('PASS page', name + path)
    evidence.push({
      repo: name,
      path,
      ms: Math.round(performance.now() - started),
      note: await score.innerText(),
    })
  }
  const checkOrg = async () => {
    const deadline = Date.now() + 30000
    while (true) {
      const response = await page.goto(
        f.origin + '/settingstest/partial/score?cat=security',
      )
      if (await preparedDocument(response,'settingstest/partial/score?cat=security')) break
      if (Date.now() > deadline) throw Error('org publication pending')
      await page.waitForTimeout(200)
    }
  }
  const unavailable = /C\/C\+\+\/C# couldn’t be scored right now/
  await mode('outage')
  for (const path of focused ? [pullGlanceOnly?'/pulls/2?tab=glance&cat=security':'/score?cat=security'] : [
    '/score?cat=security',
    '',
    '/commit/' + shas.partial + '?cat=security',
    '/pulls/2?tab=glance&cat=security',
    '/health?cat=security',
  ])
    await check('partial', path, unavailable, {
      redirect: path.startsWith('/health'),
    })
  if(focused){
    if(!pullGlanceOnly)assert.equal(sawPending,true,'focused cold outage proof must observe a real Pending document')
    if(pullGlanceOnly)assert.equal(evidence.find(e=>e.document)?.document.cache,'no-store','actual partial SSR keeps canonical noStore intent')
    console.log('PASS focused actual partial-score explanation/dials/finding')
    if(pullGlanceOnly){
      await mode('ok')
      // Reuse the full gate's recovery bound and actual score predicate:
      // background retry/publication and the existing one-second grant lease
      // may finish after the mode change, so an old truthful partial200 is not
      // evidence that recovery has completed.
      const recoveryDeadline=Date.now()+45000,route='/avatest/partial/pulls/2?tab=glance&cat=security'
      while(true){
        await fetch(f.origin+'/__fixture/public-pages?route='+encodeURIComponent(route))
        const response=await page.goto(f.origin+route),score=page.locator('#score')
        if(response.status()===200&&await score.count()&&!unavailable.test(await score.innerText()))break
        if(Date.now()>recoveryDeadline)throw Error('healthy queued publication did not recover: '+route)
        await page.waitForTimeout(200)
      }
      await check('partial','/pulls/2?tab=glance&cat=security',/Code Score|cqx review/,{partial:false})
      const recovered=await page.locator('#score').innerText()
      assert.doesNotMatch(recovered,unavailable,'recovery must replace the actual partial score view')
      assert.match(recovered,/unsafe-buffer-calls/,'actual C-family finding returns after recovery')
      evidence.push({recovery:{path:'partial/pulls/2?tab=glance&cat=security',score:recovered}})
      assert.equal(evidence.filter(e=>e.document).at(-1).document.cache,'public, max-age=0, must-revalidate','recovered document regains its normal public cache policy')
      const request=(path,viewer,method='GET',body)=>fetch(f.origin+path,{method,headers:{...(viewer?(path.startsWith('/api/')?{authorization:'Bearer '+f.tokens[viewer]}:{cookie:'gild_session='+f.cookie(viewer)}):{}),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'})
      const update=async(path,viewer,method,body)=>{const r=await request(path,viewer,method,body);assert.equal(r.status,200,await r.clone().text());return r.json()}
      const prefix='/api/v1/repos/avatest/partial'
      // Revoke an actually published and read public document via the normal
      // local fixture API; current ACL must precede reuse of its stored HTML.
      await update(prefix+'/visibility','avatest','PATCH',{visibility:'private'})
      for(const viewer of [null,'outsider']){
        const r=await request(route,viewer),body=await r.text()
        assert.equal(r.status,404,'revoked public Glance denies '+(viewer??'anonymous'))
        assert.equal(r.headers.get('cache-control'),'private, no-store')
        assert.ok(!body.includes('dynamic-code'),'no private health finding in denial')
        evidence.push({policy:{viewer:viewer??'anonymous',status:r.status,cache:r.headers.get('cache-control')}})
      }
      await update(prefix+'/collaborators/outsider','avatest','PUT',{permission:'read'})
      const invites=await (await request('/api/v1/user/repository_invitations','outsider')).json()
      await update('/api/v1/user/repository_invitations/'+invites[0].id,'outsider','PATCH',{})
      const granted=await request(route,'outsider')
      assert.equal(granted.status,200,await granted.clone().text())
      assert.equal(granted.headers.get('cache-control'),'private, no-store')
      assert.match(await granted.text(),/dynamic-code/,'authorized private Glance retains prepared finding')
      await update(prefix+'/collaborators/outsider','avatest','DELETE',{})
      const revoked=await request(route,'outsider')
      assert.equal(revoked.status,404,'current collaborator revocation overrides earlier private render')
      assert.equal(revoked.headers.get('cache-control'),'private, no-store')
      assert.ok(!(await revoked.text()).includes('dynamic-code'))
      evidence.push({policy:{acceptedPrivate:granted.status,revoked:revoked.status,noStore:true}})
      console.log('PASS actual pull Glance partial→recovered, no producer calls on public GET, and current private/revoked ACL')
    }
  } else {
  await page
    .context()
    .addCookies([
      { name: 'gild_session', value: f.cookie('avatest'), url: f.origin },
    ])
  await checkOrg()
  assert.match(await page.locator('#score').innerText(), unavailable)
  // A new repository is omitted from catalogs until its index is ready.
  const orgDeadline = Date.now() + 30000
  const orgCard = page
    .locator('article')
    .filter({ has: page.locator('a[href="/settingstest/partial"]') })
  // Exercise cold publication even when the real Queue beats the first visit.
  // Later visits still use the actual Worker and its real repository card.
  let pendingOrgResponse = true
  await page.route(f.origin + '/settingstest', async (route) => {
    if (pendingOrgResponse) {
      pendingOrgResponse = false
      await route.fulfill({ status: 503, contentType: 'text/html', body: 'Publication pending' })
    } else await route.continue()
  })
  while (true) {
    const orgResponse = await gotoPublished('/settingstest', orgDeadline)
    assert.equal(orgResponse.status(), 200, 'organization page')
    if (await orgCard.count()) break
    if (Date.now() > orgDeadline)
      throw new Error('organization fixture index did not become ready')
    await new Promise((r) => setTimeout(r, 200))
  }
  await page.unroute(f.origin + '/settingstest')
  assert.equal(pendingOrgResponse, false, 'exercise an initial pending publication')
  // Listings use the write-time status note; partial reports never become a headline score.
  const cardText = await orgCard.innerText()
  assert.match(
    cardText,
    unavailable,
    'organization card reports write-time partial coverage',
  )
  assert.doesNotMatch(
    cardText,
    /cqx\s*\d+/,
    'organization card shows no score for an unscored C-family repo',
  )
  await check('c-only', '/score', unavailable, { scored: false })
  await check('c-only', '', unavailable, { scored: false })
  await mode('mismatch')
  await check('mismatch', '/score?cat=security', unavailable)
  const apiHealth = async (name) => {
    const url =
      f.origin +
      '/__fixture/cqx-api-health?' +
      new URLSearchParams({ owner: 'avatest', repo: name, sha: shas[name] })
    const response = await fetch(url)
    assert.equal(response.status, 200, await response.clone().text())
    return response.json()
  }
  await mode('outage')
  for (const name of ['partial', 'c-only']) {
    const response = await fetch(
      f.origin + '/api/v1/repos/avatest/' + name + '/health/' + shas[name],
      {
        headers: {
          authorization: 'Bearer ' + f.tokens.avatest,
          'if-none-match': '*',
        },
      },
    )
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(
      response.headers.get('cache-control'),
      'no-store',
      'partial health API never permits immutable HTTP caching or 304',
    )
    assert.equal(response.headers.get('etag'), null)
    const report = await response.json()
    assert.equal(
      report.incomplete,
      'c-family-unavailable',
      'response contract preserves failure status',
    )
    if (name === 'c-only')
      assert.equal(
        report.scores,
        null,
        'API must not claim 100 or 0 for C-only outage',
      )
  }
  assert.equal(
    (await apiHealth('partial')).incomplete,
    'c-family-unavailable',
    'API reports heavy outage without caching',
  )
  await mode('healthy')
  for (const name of ['too-many', 'too-big', 'too-many-bytes']) {
    await check(name, '/score?cat=security', /too large to score C-family here/)
    await check(name, '/score?cat=security', /too large to score C-family here/)
  }
  for (const name of ['too-many', 'too-big', 'too-many-bytes']) {
    const report = await apiHealth(name)
    assert.equal(
      report.incomplete,
      'c-family-too-large',
      'API shares the C-family limits',
    )
    assert.equal(report.lines, 1)
  }
  await mode('healthy')
  const entries = async () =>
    (await (await fetch(f.origin + '/__fixture/cqx-cache')).json()).results
  assert.ok(
    (await entries()).every((r) => !JSON.parse(r.report)?.incomplete),
    'no partial headline enters the shared cache',
  )
  assert.ok(
    (await entries()).every((r) => !JSON.parse(r.report)?.incomplete),
    'failures and partial reports never enter D1; successful queued retries may already have completed',
  )
  // Each repository's healthy re-render is its own queued publication; wait
  // for that publication per repository rather than assuming they land together.
  const recovered = async (path, ready = text => !unavailable.test(text)) => {
    const recoveryDeadline = Date.now() + 45000
    do {
      const response = await page.goto(f.origin + path)
      if (![404, 503].includes(response.status()))
        assert.equal(response.status(), 200, 'score publication: ' + path)
      const score = page.locator('#score')
      if (response.status() === 200 && await score.count() && ready(await score.innerText())) return
      if (Date.now() > recoveryDeadline)
        throw Error('healthy queued publication did not recover: ' + path)
      await page.waitForTimeout(200)
    } while (true)
  }
  await recovered('/settingstest/partial/score?cat=security')
  assert.equal((await gotoPublished('/settingstest', Date.now() + 30000)).status(), 200, 'organization page after outage')
  assert.doesNotMatch(
    await page
      .locator('article')
      .filter({ has: page.locator('a[href="/settingstest/partial"]') })
      .innerText(),
    unavailable,
    'organization summary retries after outage',
  )
  await recovered('/avatest/partial/score?cat=security')
  assert.doesNotMatch(
    await page.locator('#score').innerText(),
    unavailable,
    'same commit retries successfully after outage',
  )
  assert.match(
    await page.locator('#score').innerText(),
    /unsafe-buffer-calls/,
    'C score/finding returns after recovery',
  )
  const cached = (await entries()).filter((r) =>
    r.key.startsWith('avatest/partial@'),
  )
  assert.equal(
    cached.filter((r) => r.key.includes('@' + shas.partial + '#')).length,
    1,
    'one complete report per immutable commit',
  )
  assert.equal(
    JSON.parse(
      cached.find((r) => r.key.includes('@' + shas.partial + '#')).report,
    ).incomplete,
    undefined,
  )
  await recovered('/avatest/partial/commit/' + shas.partial + '?cat=security', text => !unavailable.test(text) && /same as its parent|vs its parent/.test(text))
  await mode('outage')
  assert.equal(
    (await apiHealth('partial')).incomplete,
    undefined,
    'API and web reuse the same complete score cache',
  )
  await page.goto(
    f.origin + '/avatest/partial/commit/' + shas.partial + '?cat=security',
  )
  assert.doesNotMatch(
    await page.locator('#score').innerText(),
    unavailable,
    'commit and parent reports were published by the healthy write-time job; outage cannot recompute or replace them',
  )
  assert.match(
    await page.locator('#score').innerText(),
    /same as its parent|vs its parent/,
    'complete parent comparison stays available from immutable fragments',
  )
  await page.goto(f.origin + '/avatest/partial/score?cat=security')
  assert.match(
    await page.locator('#score').innerText(),
    /unsafe-buffer-calls/,
    'complete cached report needs no heavy RPC',
  )
  writeFileSync(
    '.tmp/cqx-review/failures.json',
    JSON.stringify(evidence, null, 2) + '\n',
  )
  console.log(
    'PASS: outage, BUILD mismatch, partial and C-only pages; repo/commit/PR/health; file/byte limits; no failure cache; recovery/cache hit',
  )
  }
} catch (error) {
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0]
    if (page)
      writeFileSync('.tmp/cqx-review/failure-page.html', await page.content())
  }
  throw error
} finally {
  writeFileSync('.tmp/cqx-review/failures.json',JSON.stringify(evidence,null,2)+'\n')
  await browser?.close()
  f.worker.kill('SIGTERM')
  f.server.closeAllConnections()
  await new Promise((r) => f.server.close(r))
}
