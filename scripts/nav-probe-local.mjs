// Repeat the live probe against the compiled worker, without deployment.
import { forgeFixture } from './forge-fixture.mjs'
import { publishRepoTabs } from './nav-fixture.mjs'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

const f = await forgeFixture({ renderBuild: false })
const repo = 'avatest/glance-test'
try {
  await publishRepoTabs(f, '/' + repo)
  for (const mode of ['--cold', '--warm']) {
    const child = spawn(
      process.execPath,
      ['scripts/nav-probe.mjs', repo, f.origin, mode],
      { stdio: 'inherit' },
    )
    const exit = await new Promise((resolve) => child.once('exit', resolve))
    assert.equal(exit, 0, mode + ' probe')
  }
} finally {
  f.worker.kill('SIGTERM')
  await new Promise((resolve) =>
    f.worker.exitCode !== null ? resolve() : f.worker.once('exit', resolve),
  )
  f.server.closeAllConnections()
  await new Promise((resolve) => f.server.close(resolve))
}
