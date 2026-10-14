import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  copyFileSync,
} from 'node:fs'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('npm run deploy builds once, deploys heavy → render → site, and fails closed at every stage', () => {
  mkdirSync('.tmp', { recursive: true })
  const dir = mkdtempSync(resolve('.tmp/cqx-deploy-'))
  const bin = join(dir, 'node_modules/.bin'),
    log = join(dir, 'calls.log')
  mkdirSync(bin, { recursive: true })
  const {
    scripts: { deploy },
  } = JSON.parse(readFileSync('package.json', 'utf8'))
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ scripts: { deploy } }),
  )
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  copyFileSync('scripts/deploy.mjs', join(dir, 'scripts/deploy.mjs'))
  const fake = `import {appendFileSync} from 'node:fs'; const name=process.argv[1].split('/').pop(); const args=process.argv.slice(2).join(' ');appendFileSync(process.env.CQX_TEST_LOG,name+' '+args+'\\n'); const stage=name==='render-build.mjs'?'RENDER_BUILD':name==='cqx-artifacts.mjs'?'ARTIFACTS':name==='public-build.mjs'?'PUBLIC_ASSETS':args==='build'?'BUILD':args.includes('cqx-heavy')?'HEAVY':args.includes('wrangler.render')?'RENDER':'SITE';process.exit(Number(process.env['CQX_TEST_'+stage+'_EXIT']??0));`
  for (const path of [
    'scripts/render-build.mjs',
    'scripts/cqx-artifacts.mjs',
    'scripts/public-build.mjs',
    'node_modules/wrangler/bin/wrangler.js',
    'node_modules/@opennextjs/cloudflare/dist/cli/index.js',
  ]) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), fake)
  }
  try {
    const calls = [
      'render-build.mjs ',
      'cqx-artifacts.mjs ',
      'index.js build',
      'public-build.mjs ',
      'wrangler.js deploy --config wrangler.cqx-heavy.jsonc',
      'wrangler.js deploy --config wrangler.render.jsonc',
      'index.js deploy',
    ]
    for (const [stage, cut] of [
      ['RENDER_BUILD', 1],
      ['ARTIFACTS', 2],
      ['BUILD', 3],
      ['PUBLIC_ASSETS', 4],
      ['HEAVY', 5],
      ['RENDER', 6],
      ['SITE', 7],
      ['SUCCESS', 7],
    ] as const) {
      writeFileSync(log, '')
      const run = spawnSync('npm', ['run', 'deploy'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          TMPDIR: resolve('.tmp'),
          CQX_TEST_LOG: log,
          ['CQX_TEST_' + stage + '_EXIT']: '7',
        },
      })
      assert.equal(
        run.status,
        stage === 'SUCCESS' ? 0 : 7,
        run.stdout + run.stderr,
      )
      assert.deepEqual(
        readFileSync(log, 'utf8')
          .trimEnd()
          .split('\n')
          .map((line) => line.trim()),
        calls.slice(0, cut).map((line) => line.trim()),
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
