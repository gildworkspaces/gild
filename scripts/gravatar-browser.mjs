import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const hash = (email) =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
// Only Gravatar's external image responses are controlled. App HTML, auth, D1,
// uploads, deletes and profile resolution all run through the production Worker.
export async function gravatarNetwork(page) {
  const present = new Set(
    ['avatest@example.com', 'adminuser@example.com', 'hello@example.com'].map(
      hash,
    ),
  )
  await page.route('https://www.gravatar.com/avatar/**', async (route) => {
    const url = new URL(route.request().url())
    assert.equal(url.searchParams.get('d'), '404')
    assert.match(url.pathname, /^\/avatar\/[a-f0-9]{64}$/)
    assert.ok(!url.href.includes('@'))
    await route.fulfill(
      present.has(url.pathname.split('/').pop())
        ? {
            status: 200,
            contentType: 'image/png',
            body: readFileSync('public/sami.png'),
            headers: { 'cache-control': 'no-store' },
          }
        : { status: 404, body: '', headers: { 'cache-control': 'no-store' } },
    )
  })
  return present
}

export async function verifyGravatar({
  page,
  browser,
  origin,
  request,
  cookie,
  picture,
  present,
  org = 'settingstest',
}) {
  const shots = resolve('docs/gravatar/screenshots')
  mkdirSync(shots, { recursive: true })
  const photo = page.locator('[data-picture-label]')
  const assertSource = async (source) => {
    await photo.filter({ hasText: new RegExp('^' + source) }).waitFor()
    assert.match(await photo.innerText(), new RegExp('^' + source))
    const current = page
      .locator('[data-picture-label]')
      .locator('..')
      .locator('[data-picture-source]')
    assert.equal(await current.getAttribute('data-picture-source'), source)
    if (source === 'None') {
      assert.equal(await current.locator('svg').count(), 1)
      assert.equal(
        await page
          .getByRole('link', { name: 'Set up Gravatar' })
          .getAttribute('href'),
        'https://gravatar.com',
      )
    } else {
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-picture-label]')
            ?.parentElement?.querySelector('img')?.naturalWidth > 0,
      )
      assert.equal(
        await current
          .locator('img')
          .evaluate((img) => img.complete && img.naturalWidth > 0),
        true,
      )
    }
  }
  const capture = async (area, path, source) => {
    for (const theme of ['light', 'dark'])
      for (const width of [1400, 400]) {
        await page.setViewportSize({ width, height: 1000 })
        await page.evaluate(
          (value) => localStorage.setItem('gild.theme', value),
          theme,
        )
        const response = await page.goto(origin + path)
        assert.equal(response.status(), 200)
        if (source) await assertSource(source)
        const images = page.locator('[data-picture-source] img')
        for (const image of await images.elementHandles())
          if (await image.isVisible()) await image.scrollIntoViewIfNeeded()
        await page.waitForFunction(() =>
          [...document.querySelectorAll('[data-picture-source] img')].every(
            (img) =>
              !img.checkVisibility({
                visibilityProperty: true,
                contentVisibilityAuto: true,
              }) || img.complete,
          ),
        )
        await page.evaluate(() => window.scrollTo(0, 0))
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
          path + ' overflow',
        )
        await page.screenshot({
          path: join(shots, `${area}-${width}-${theme}.png`),
          fullPage: true,
        })
      }
  }
  // Legacy cookie route through the real form: PUT upload -> DELETE -> Gravatar.
  await page.goto(origin + '/settings/profile')
  await assertSource('Uploaded')
  await capture('account-uploaded', '/settings/profile', 'Uploaded')
  await page.getByRole('button', { name: 'Use Gravatar', exact: true }).click()
  await page
    .getByRole('status')
    .filter({ hasText: 'Picture updated' })
    .waitFor()
  await assertSource('Gravatar')
  assert.equal(
    (await (await request('avatest', '/api/v1/user/profile')).json()).picture,
    null,
  )
  assert.equal(
    await page.getByRole('button', { name: 'Use Gravatar' }).count(),
    0,
  )
  await capture('account-gravatar', '/settings/profile', 'Gravatar')
  const ownHash = hash('avatest@example.com')
  assert.ok(
    (
      await page
        .locator('header [data-picture-source] img')
        .first()
        .getAttribute('src')
    ).includes(ownHash),
  )
  assert.ok(
    (await page.locator('.sidebar-identity img').getAttribute('src')).includes(
      ownHash,
    ),
  )
  await page.locator('header details').first().locator('summary').click()
  assert.ok(
    (
      await page
        .locator('header details a[href="/settings/profile"] img')
        .getAttribute('src')
    ).includes(ownHash),
  )
  // A missing Gravatar is a real image-error event, including after a URL change.
  present.delete(ownHash)
  await capture('account-none', '/settings/profile', 'None')
  present.add(ownHash)
  await request('member', '/api/v1/user/picture', 'DELETE')
  await request('adminuser', '/api/v1/user/picture', 'DELETE')
  // Account stays uploaded, admin uses Gravatar, member has no Gravatar.
  await request('avatest', '/api/v1/user/picture', 'PUT', { data: picture })
  await page.goto(origin + `/orgs/${org}/settings/members`)
  for (const [name, source] of [
    ['avatest', 'Uploaded'],
    ['adminuser', 'Gravatar'],
    ['member', 'None'],
  ]) {
    await page
      .getByLabel('Role for ' + name)
      .locator('..')
      .locator(`[data-picture-source="${source}"]`)
      .waitFor()
  }
  await capture('members', `/orgs/${org}/settings/members`)
  await capture('overview', `/${org}`)
  // Organization DELETE uses the same component and resolves its public email.
  await page.goto(origin + `/orgs/${org}/settings/general`)
  await page.getByRole('button', { name: 'Use Gravatar', exact: true }).click()
  await page
    .getByRole('status')
    .filter({ hasText: 'Picture updated' })
    .waitFor()
  await assertSource('Gravatar')
  assert.ok(
    (await photo.locator('..').locator('img').getAttribute('src')).includes(
      hash('hello@example.com'),
    ),
  )
  await capture(
    'org-gravatar',
    `/orgs/${org}/settings/general`,
    'Gravatar',
  )
  // Public email edits update the same mounted picture, including recovery from 404.
  for (const [email, source] of [
    ['', 'None'],
    ['member@example.com', 'None'],
    ['hello@example.com', 'Gravatar'],
  ]) {
    await page.getByLabel('Public email', { exact: true }).fill(email)
    await page
      .getByRole('button', { name: 'Update profile', exact: true })
      .click()
    await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor()
    await assertSource(source)
  }
  await page.goto(origin + '/settings/organizations')
  await page
    .getByRole('img', { name: `Profile picture for ${org}`, exact: true })
    .waitFor()
  // Authenticated outsider and anonymous crawl include streamed RSC props in HTML.
  // The earlier Members form test promoted 'outsider'; 'second' has no membership.
  for (const actor of ['', 'second']) {
    const ctx = await browser.newContext()
    if (actor)
      await ctx.addCookies([
        {
          name: 'gild_session',
          value: cookie(actor),
          domain: '127.0.0.1',
          path: '/',
        },
      ])
    for (const path of [
      `/${org}`,
      `/${org}?tab=people`,
      '/avatest',
      '/adminuser',
      '/member',
    ]) {
      const response = await ctx.request.get(origin + path)
      assert.equal(response.status(), 200, actor + path)
      const html = await response.text()
      for (const name of ['avatest', 'adminuser', 'member', 'second'])
        assert.ok(
          !html.includes(name + '@example.com'),
          'Private claim email leaked in ' + path,
        )
      if (path.startsWith(`/${org}`))
        assert.ok(html.includes(hash('adminuser@example.com')))
    }
    const forbidden = await ctx.request.get(
      origin + `/orgs/${org}/settings/members`,
    )
    assert.equal(forbidden.status(), 404)
    await ctx.close()
  }
  // Cross-site DELETE must leave both existing uploads untouched.
  for (const [path, read] of [
    ['/api/account/picture', '/api/v1/user/profile'],
    [`/api/orgs/${org}/picture`, `/api/v1/orgs/${org}/profile`],
  ]) {
    const uploadPath = read.replace('/profile', '/picture')
    await request('avatest', uploadPath, 'PUT', { data: picture })
    const before = (await (await request('avatest', read)).json()).picture
    const response = await fetch(origin + path, {
      method: 'DELETE',
      headers: {
        cookie: 'gild_session=' + cookie('avatest'),
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
    })
    assert.equal(response.status, 403)
    assert.equal(
      (await (await request('avatest', read)).json()).picture,
      before,
    )
  }
  // Scope is identical to PUT: only owners/admins can delete an org picture.
  for (const actor of ['', 'member', 'second', 'adminuser', 'avatest']) {
    await request('avatest', `/api/v1/orgs/${org}/picture`, 'PUT', { data: picture })
    const before = (await (await request('avatest', `/api/v1/orgs/${org}/profile`)).json()).picture
    const allowed = ['avatest', 'adminuser'].includes(actor)
    const response = await request(actor, `/api/v1/orgs/${org}/picture`, 'DELETE')
    assert.equal(response.status, allowed ? 200 : actor ? 404 : 401, actor + ' org DELETE')
    const after = (await (await request('avatest', `/api/v1/orgs/${org}/profile`)).json()).picture
    assert.equal(after, allowed ? null : before)
  }
  const before = (await (await request('avatest', '/api/v1/user/profile')).json()).picture
  await request('member', '/api/v1/user/picture', 'DELETE')
  assert.equal((await (await request('avatest', '/api/v1/user/profile')).json()).picture, before)
  console.log(
    'Gravatar browser proof: upload -> DELETE -> Gravatar -> image 404 silhouette; mixed Members/Overview; account/org/switcher/rail; outsider HTML contains no private claim emails. 24 screenshots.',
  )
}
