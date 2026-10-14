import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
export async function verifyRepoList({
  browser,
  origin,
  request,
  cookie,
  work,
  gitRoot,
  git,
}) {
  const shots = resolve('docs/repo-list/screenshots')
  mkdirSync(shots, { recursive: true })
  const browserErrors = []
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
  })
  page.on('pageerror', (e) => browserErrors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') browserErrors.push(m.text())
  })
  const cookieValue = cookie('avatest')
  await page.context().addCookies([
    {
      name: 'gild_session',
      value: cookieValue,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
    },
  ])
  const names = [
    'demo',
    'tools',
    'runner-images',
    'ky',
    'chi',
    'Alamofire',
    'jsoup',
    'requests',
    'serde',
    'docs',
  ]
  // Start index alarms, then wait for the public REST boundary, not fixed sleeps.
  for (const name of names)
    await fetch(origin + '/__fixture/refresh?key=settingstest/' + name)
  for (const name of names) {
    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      const r = await request('avatest', '/api/v1/repos/settingstest/' + name)
      if (r.status === 200) break
      assert.ok(
        [404, 503].includes(r.status),
        `${name}: ${r.status} ${await r.text()}`,
      )
      await new Promise((r) => setTimeout(r, 200))
    }
    assert.equal(
      (await request('avatest', '/api/v1/repos/settingstest/' + name)).status,
      200,
    )
  }
  for (const name of names) {
    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      const r = await fetch(
        origin + '/__fixture/history?key=settingstest/' + name,
      )
      if ((await r.json()).ready) break
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  const path = '/settingstest?tab=repositories'
  let start = performance.now()
  let first = await fetch(origin + path, {
    headers: { cookie: 'gild_session=' + cookieValue },
  })
  const firstHTML = await first.text()
  const firstMs = performance.now() - start
  assert.equal(first.status, 200)
  assert.equal(
    (firstHTML.match(/aria-label="\d+ commits in the last year"/g) ?? [])
      .length,
    10,
    'first measured view computes all ten summaries',
  )
  assert.match(first.headers.get('cache-control'), /no-store/)
  // Browser rendering sees the same complete catalog as the cold data request.
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    await page.goto(origin + path)
    if (
      (await page
        .getByRole('img', { name: /commits in the last year/ })
        .count()) === 10
    )
      break
    await new Promise((r) => setTimeout(r, 200))
  }
  assert.equal(
    await page.getByRole('img', { name: /commits in the last year/ }).count(),
    10,
  )
  assert.equal(await page.getByRole('link', {name:'1 open issue',exact:true}).count(), 10)
  assert.equal(await page.getByRole('link', {name:'1 open PR',exact:true}).count(), 10)
  start = performance.now()
  const warm = await fetch(origin + path, {
    headers: { cookie: 'gild_session=' + cookieValue },
  })
  await warm.text()
  const cachedMs = performance.now() - start
  assert.equal(warm.status, 200)
  assert.match(warm.headers.get('cache-control'), /no-store/)
  await page.goto(origin + '/settingstest/ky/score')
  await page.goto(origin + path)
  await page
    .getByRole('link', { name: /^cqx \d+/ })
    .first()
    .waitFor()
  const starPath = '/api/v1/user/starred/settingstest/ky',
    repoPath = '/api/v1/repos/settingstest/ky'
  assert.equal((await request('avatest', starPath, 'PUT')).status, 204)
  assert.equal((await request('avatest', starPath, 'PUT')).status, 204)
  assert.equal(
    (await (await request('avatest', repoPath)).json()).stargazers_count,
    1,
  )
  const gazers = await request('avatest', repoPath + '/stargazers')
  assert.match(gazers.headers.get('cache-control'), /no-store/)
  assert.deepEqual(
    (await gazers.json()).map((u) => u.login),
    ['avatest'],
  )
  assert.equal((await fetch(origin + starPath, { method: 'PUT' })).status, 401)
  await page.goto(origin + '/settingstest/ky')
  await page.getByRole('button', { name: '★ Unstar 1' }).waitFor()
  await page.getByRole('button', { name: '★ Unstar 1' }).click()
  await page.getByRole('button', { name: '☆ Star 0' }).waitFor()
  await page.reload()
  await page.getByRole('button', { name: '☆ Star 0' }).waitFor()
  await page.getByRole('button', { name: '☆ Star 0' }).click()
  await page.getByRole('button', { name: '★ Unstar 1' }).waitFor()
  await page.reload()
  await page.getByRole('button', { name: '★ Unstar 1' }).waitFor()
  assert.equal(
    (await (await request('avatest', repoPath)).json()).stargazers_count,
    1,
  )
  const waitRepo = async (collection) => {
    const deadline = Date.now()+90000
    while (Date.now()<deadline) {
      const response=await request('avatest',repoPath+(collection ? '/'+collection : ''))
      if(response.status===200) {
        if(!collection) return
        const rows=await response.json()
        if(rows.filter(row=>collection!=='issues' || !row.pull_request).length===2) return
      } else
      assert.ok([404,503].includes(response.status),await response.text())
      await new Promise(r=>setTimeout(r,200))
    }
    assert.fail('Repository did not become readable after metadata write')
  }
  // Counts on the shared rows use singular and plural from live metadata.
  assert.equal((await request('avatest','/api/v1/repos/settingstest/ky/issues','POST',{title:'Second issue'})).status,201)
  await waitRepo('issues')
  assert.equal((await request('avatest','/api/v1/repos/settingstest/ky/pulls','POST',{title:'Second PR',head:'feature',base:'main'})).status,201)
  await waitRepo('pulls')
  // Next's ref-advertisement memo and the Worker API have separate lifetimes.
  // Navigate until the actual shared list sees the new _meta tip, bounded to 90s.
  const kyRow=page.locator('article').filter({has:page.getByRole('link',{name:'ky',exact:true})})
  const listDeadline=Date.now()+90000
  while(Date.now()<listDeadline) {
    await page.goto(origin + path)
    if(await kyRow.getByRole('link',{name:'2 open issues',exact:true}).count() &&
       await kyRow.getByRole('link',{name:'2 open PRs',exact:true}).count()) break
    await new Promise(r=>setTimeout(r,250))
  }
  assert.equal(await kyRow.getByRole('link',{name:'2 open issues',exact:true}).count(),1)
  assert.equal(await kyRow.getByRole('link',{name:'2 open PRs',exact:true}).count(),1)
  await page.goto(origin + '/settingstest/ky')
  await page.getByRole('button', { name: '★ Unstar 1' }).waitFor()
  // Another user changes the count between this viewer's read and toggle.
  assert.equal((await request('outsider', starPath, 'PUT')).status, 204)
  await page.getByRole('button', { name: '★ Unstar 1' }).click()
  await page.getByRole('button', { name: '☆ Star 1' }).waitFor()
  await page.getByRole('button', { name: '☆ Star 1' }).click()
  await page.getByRole('button', { name: '★ Unstar 2' }).waitFor()
  assert.equal((await request('outsider', starPath, 'DELETE')).status, 204)
  await page.reload()
  await page.getByRole('button', { name: '★ Unstar 1' }).waitFor()
  // Valid cookie mutations pass; the same cookie cannot authorize cross-site intent.
  const cookieStarPath = '/api/user/starred/settingstest/ky'
  for (const method of ['PUT', 'DELETE']) {
    const response = await fetch(origin + cookieStarPath, {
      method, headers: {cookie:'gild_session='+cookieValue, origin:'https://attacker.example', 'sec-fetch-site':'cross-site'},
    })
    assert.equal(response.status, 403)
    assert.equal((await (await request('avatest', repoPath)).json()).stargazers_count, 1, method+' CSRF leaves count unchanged')
  }
  console.log('Cookie star PUT/DELETE: cross-origin 403 and stored count unchanged; same-origin browser toggles passed')
  const legacyCatalog = await fetch(origin + '/api/repos', {
    headers: { cookie: 'gild_session=' + cookieValue },
  })
  assert.equal(legacyCatalog.status, 200)
  assert.match(legacyCatalog.headers.get('cache-control'), /no-store/)
  const legacyData = await legacyCatalog.json()
  assert.equal(
    legacyData.orgs
      .find((o) => o.name === 'settingstest')
      .repos.find((r) => r.name === 'ky').stargazers_count,
    1,
  )
  // Shared ACL denies an outsider before star writes (both PUT and DELETE).
  const privatePath = '/api/v1/user/starred/settingstest/docs'
  const waitDeadline = Date.now() + 90000
  while (Date.now() < waitDeadline) {
    const r = await request('avatest', '/api/v1/repos/settingstest/docs')
    if (r.status === 200 && (await r.json()).private) break
    await new Promise((r) => setTimeout(r, 250))
  }
  for (const method of ['PUT', 'DELETE'])
    assert.equal((await request('outsider', privatePath, method)).status, 404)
  assert.equal(
    (await request('outsider', '/api/v1/repos/settingstest/docs/stargazers'))
      .status,
    404,
  )
  assert.equal((await request('avatest', privatePath, 'PUT')).status, 204)
  assert.equal(
    (await (await request('avatest', '/api/v1/repos/settingstest/docs')).json())
      .stargazers_count,
    1,
  )
  assert.equal((await request('avatest', privatePath, 'DELETE')).status, 204)
  assert.equal(
    (
      await (
        await request('outsider', '/api/v1/orgs/settingstest/repos')
      ).json()
    ).length,
    9,
  )
  const landingTimes = []
  for (let i=0;i<2;i++) {
    const start=performance.now(), r=await fetch(origin+'/'), html=await r.text()
    assert.equal(r.status,200)
    assert.match(html, /href="\/[^"]+\/issues"/, 'landing renders the shared repository rows')
    assert.ok(!html.includes('settingstest/docs'))
    landingTimes.push({ms:Math.round((performance.now()-start)*100)/100,cacheControl:r.headers.get('cache-control')})
  }
  writeFileSync(join(work,'landing-timings.json'),JSON.stringify(landingTimes,null,2))
  console.log('Anonymous landing first/cached HTML (ms): '+JSON.stringify(landingTimes))
  const anon = await browser.newPage()
  await anon.goto(origin + '/settingstest/ky?path=README.md')
  await anon.getByLabel('1 stars').waitFor()
  const signIn = anon.getByRole('link', {name:'Sign in to star',exact:true})
  const destination = new URL(await signIn.getAttribute('href'), origin)
  assert.equal(destination.searchParams.get('next'), '/settingstest/ky?path=README.md')
  // Supply only the terminal-approval result; exercise the actual device page redirect.
  await anon.route('**/api/auth/status?*', route => route.fulfill({json:{status:'ok'}}))
  await signIn.click()
  await anon.waitForURL(origin + '/settingstest/ky?path=README.md')
  await anon.unroute('**/api/auth/status?*')
  console.log('Signed-out star count/link and device sign-in return (including query) passed')
  assert.equal(
    await anon.getByRole('button', { name: /Star|Unstar/ }).count(),
    0,
  )
  await anon.goto(origin + '/settingstest/docs')
  // Streaming not-found pages may send 200; their content and robots directive still deny the private view.
  await anon.getByRole('heading', { name: 'Nothing lives here' }).waitFor()
  assert.equal(await anon.getByRole('button', { name: 'Clone' }).count(), 0)
  assert.equal(await anon.locator('pre').count(), 0)
  assert.match(
    await anon.locator('meta[name=robots]').first().getAttribute('content'),
    /noindex/,
  )
  await anon.close()
  assert.equal(
    (
      await request(
        'avatest',
        '/api/v1/repos/settingstest/Alamofire/archive',
        'PUT',
        { archived: true },
      )
    ).status,
    200,
  )
  const overflow = []
  for (const theme of ['light', 'dark'])
    for (const width of [1400, 400]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.evaluate(
        (theme) => localStorage.setItem('gild.theme', theme),
        theme,
      )
      for (const [area, url] of [
        ['org', path],
        ['repo', '/settingstest/ky'],
      ]) {
        const response = await page.goto(origin + url)
        assert.equal(response.status(), 200)
        try {
          await page.waitForFunction(
            (theme) => document.documentElement.dataset.theme === theme,
            theme,
          )
        } catch (e) {
          writeFileSync(join(work, 'theme-failure.html'), await page.content())
          await page.screenshot({
            path: join(work, 'theme-failure.png'),
            fullPage: true,
          })
          console.log(
            'Theme failure page:',
            await page.title(),
            'browser errors:',
            JSON.stringify(browserErrors),
          )
          throw e
        }
        assert.equal(
          await page.evaluate(() => document.documentElement.dataset.theme),
          theme,
        )
        if (area === 'org') {
          assert.equal(await page.locator('article').count(), 10)
          await page
            .locator('article')
            .filter({
              has: page.getByRole('link', { name: 'Alamofire', exact: true }),
            })
            .getByText('archived', { exact: true })
            .waitFor()
          assert.equal(
            await page
              .locator('article')
              .last()
              .getByRole('link', { name: 'tools', exact: true })
              .count(),
            1,
          )
          assert.equal(
            await page
              .getByRole('img', { name: /commits in the last year/ })
              .count(),
            10,
          )
          assert.equal(
            await page
              .getByRole('img', { name: '0 commits in the last year' })
              .count(),
            1,
          )
          assert.equal(await page.getByRole('textbox').count(), 0)
          assert.equal(await page.getByRole('combobox').count(), 0)
          for (const name of ['ky', 'chi', 'Alamofire', 'jsoup'])
            assert.equal(
              await page.getByRole('link', { name, exact: true }).count(),
              1,
            )
          assert.ok((await page.getByText('MIT', { exact: true }).count()) >= 4)
          assert.equal(
            await page.getByRole('link', { name: '＋ New repo' }).count(),
            1,
          )
          await page
            .locator('article')
            .filter({
              has: page.getByRole('link', { name: 'ky', exact: true }),
            })
            .getByLabel('1 stars')
            .waitFor()
        } else await page.getByRole('button', { name: '★ Unstar 1' }).waitFor()
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          `${area} ${width} overflow`,
        )
        await page.screenshot({
          path: join(shots, `${area}-${width}-${theme}.png`),
          fullPage: true,
        })
        overflow.push({ area, width, theme, overflow: false })
      }
    }
  // The same rows also render on Overview, user and dashboard.
  // Listings intentionally do not wait for a cold refresh. Establish these
  // newly imported fixture repositories through the real API first.
  for (const name of ['glance-test', 'ky']) {
    await fetch(origin + '/__fixture/refresh?key=avatest/' + name)
    const deadline = Date.now() + 60000
    let ready = false
    while (Date.now() < deadline) {
      if ((await request('avatest', '/api/v1/repos/avatest/' + name)).status === 200) { ready = true; break }
      await new Promise(r => setTimeout(r, 100))
    }
    assert.ok(ready, 'fixture user repo indexed: ' + name)
  }
  for (const [url, count] of [
    ['/settingstest', 10],
    ['/avatest', 2],
    ['/dashboard', 12],
  ]) {
    await page.goto(origin + url)
    await page.waitForTimeout(500)
    if ((await page.locator('article').count()) !== count) {
      await page.reload()
      await page.waitForTimeout(500)
    }
    assert.equal(await page.locator('article').count(), count, url)
  }
  // Run the canonical corner checker against the complete local app at three widths.
  const fixture = join(work, 'corner.json')
  // Test-created secret only; this file never contains a repo/remote credential.
  const config = JSON.parse(readFileSync(join(work, 'wrangler.json'), 'utf8'))
  writeFileSync(
    fixture,
    JSON.stringify({
      secret: config.vars.SESSION_SECRET,
      sha: git(
        join(gitRoot, 'u-avatest', 'glance-test.git'),
        'rev-parse',
        'main',
      ),
    }),
  )
  // Keep the local Git transport server responsive while the checker navigates.
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/corner-check.mjs', origin, fixture], { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Corner check failed: ${code ?? signal}`)))
  })
  writeFileSync(
    join(shots, '../evidence.json'),
    JSON.stringify(
      {
        firstMs,
        cachedMs,
        landingTimes,
        repos: 10,
        firstComplete: (firstHTML.match(/aria-label="\d+ commits in the last year"/g) ?? [])
          .length,
        overflow,
      },
      null,
      2,
    ),
  )
  console.log(
    `10-repo org: first ${firstMs.toFixed(1)}ms, cached ${cachedMs.toFixed(1)}ms; D1 toggle persistence/count/API, anonymous/private rejection, all list surfaces, light/dark 1400/400 passed`,
  )
  await page.close()
}
