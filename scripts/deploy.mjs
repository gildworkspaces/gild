import { spawnSync } from 'node:child_process'
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
// MANUAL ONLY. Never use scripts/deploy.mjs as the Workers Builds command:
// Builds renames every wrangler deploy to gild-site, including the render
// deployment, and would replace the site with the wrong Worker.
// Deploy gild-render by hand: npx wrangler deploy -c wrangler.render.jsonc.
if (process.env.WORKERS_CI) throw new Error('Manual deploy only; configure Workers Builds with opennextjs-cloudflare deploy')
run(process.execPath, ['scripts/render-build.mjs'])
run(process.execPath, ['scripts/cqx-artifacts.mjs'])
run(process.execPath, [
  'node_modules/@opennextjs/cloudflare/dist/cli/index.js',
  'build',
])
run(process.execPath, ['scripts/public-build.mjs'])
for (const config of ['wrangler.cqx-heavy.jsonc', 'wrangler.render.jsonc'])
  run(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js',
    'deploy',
    '--config',
    config,
  ])
run(process.execPath, [
  'node_modules/@opennextjs/cloudflare/dist/cli/index.js',
  'deploy',
])
