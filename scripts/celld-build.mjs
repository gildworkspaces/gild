// Build gild-site for a self-hosted celld fleet (docs/self-host-celld.md).
// Run after `bun run build:cloudflare`; the inputs are the production build
// outputs and the wrangler configs, unchanged. Writes celld.<worker>.json
// beside wrangler.jsonc (celld resolves paths from the config's directory) and
// prints the deploy order. Secrets come from celld.vars.json (never committed):
// celld has no secret store, so they are deployed as vars into your bucket.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { celldConfig, readWrangler } from './celld-config.mjs'
import { bundleForCelld } from './celld-bundle.mjs'

const secrets = existsSync('celld.vars.json') ? JSON.parse(readFileSync('celld.vars.json', 'utf8')) : {}
const write = (name, config) => {
  writeFileSync(`celld.${name}.json`, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  return `celld.${name}.json`
}

const heavy = write('cqx-heavy', celldConfig(readWrangler('wrangler.cqx-heavy.jsonc')))

// celld 0.6.2 ignores `script_name` on a Durable Object binding and registers
// the class as the binding script's own, so gild-render cannot reach
// gild-site's RepoIndex (upstream issue A in the doc). Drop the binding so the
// fleet starts; fragment rendering stays unavailable until celld supports it.
const renderWrangler = readWrangler('wrangler.render.jsonc'),
  foreign = renderWrangler.durable_objects?.bindings?.filter((b) => b.script_name) ?? []
for (const b of foreign)
  console.warn(`celld: dropping ${b.name} -> ${b.script_name}.${b.class_name} (cross-script Durable Object bindings are unsupported)`)
const render = write('render', celldConfig({
  ...renderWrangler,
  durable_objects: { bindings: renderWrangler.durable_objects.bindings.filter((b) => !b.script_name) },
}))

const out = await bundleForCelld({ entry: 'worker.ts', outfile: '.celld-out/site/worker.mjs' })
const siteWrangler = readWrangler('wrangler.jsonc')
const site = write('site', celldConfig({
  ...siteWrangler,
  main: './' + out,
  no_bundle: true,
  vars: { ...siteWrangler.vars, ...secrets },
}))

console.log(`celld deploy order (the last deploy selects the fleet application):\n  celld deploy ${heavy}\n  celld deploy ${render}\n  celld deploy ${site}\n  celld d1 migrations apply ${siteWrangler.d1_databases[0].database_name} ${site}`)
