import { join } from 'node:path'
import assert from 'node:assert/strict'

export async function verifyRepoRefresh({ origin, page, call, tokens, gitRoot, git, label }) {
  await call('/api/v1/user/starred/settingstest/demo', undefined, 'PUT', tokens.avatest, 204)
  const dir = join(gitRoot, 'o-settingstest', 'demo.git')
  const before = git(dir, 'rev-parse', '_meta')
  await call('/api/v1/repos/settingstest/demo', { description: `Refresh proof ${label}` }, 'PATCH')
  await call('/api/v1/repos/settingstest/demo/agents', { agent: 'avatest/codex', grants: ['pr'] }, 'POST')
  assert.notEqual(git(dir, 'rev-parse', '_meta'), before, 'settings must change _meta')
  const pending = await (await fetch(origin + '/__fixture/refresh?key=settingstest/demo')).json()
  assert.equal(pending.ready, false, 'navigation starts during a real product refresh')
  const started = performance.now()
  const response = await page.goto(origin + '/settingstest/demo/settings/actions')
  assert.equal(response.status(), 200, 'first repo navigation during _meta refresh')
  assert.equal(await page.getByRole('heading', { name: 'Nothing lives here', exact: true }).count(), 0)
  await page.getByRole('heading', { name: 'Actions', exact: true }).waitFor()
  const firstMs = Math.round(performance.now() - started)
  const repeated = performance.now()
  assert.equal((await page.goto(origin + '/settingstest/demo')).status(), 200, 'repo code page after refresh')
  assert.equal(await page.getByRole('heading', { name: 'Nothing lives here', exact: true }).count(), 0)
  console.log(`Immediate _meta navigation (${label}): HTTP 200 in ${firstMs}ms; repo code page HTTP 200 in ${Math.round(performance.now() - repeated)}ms`)
  assert.equal((await page.goto(origin + '/settingstest/demo/settings/actions')).status(), 200)
}
