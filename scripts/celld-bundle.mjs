// Bundle a Worker entry for celld (https://celld.dev) as a prebuilt
// `no_bundle` Worker. The inputs are the same as for wrangler; this only
// bridges celld 0.6.2 runtime gaps, each drafted as an upstream issue in
// docs/self-host-celld.md. Nothing here runs on Cloudflare.
import { build } from 'esbuild'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { builtinModules } from 'node:module'

// Builtins celld stubs out entirely; unenv is the polyfill set wrangler ships.
const unenv = (name) => resolve(`node_modules/unenv/dist/runtime/node/${name}.mjs`)
const polyfill = Object.fromEntries(
  ['http', 'https', 'net'].flatMap((name) => [[name, unenv(name)], [`node:${name}`, unenv(name)]]),
)
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))
// celld's Request constructor assigns this.url, which throws in a subclass with
// a getter-only url (NextRequest). Give such getters a setter.
const urlGetter = /get url\(\)\s*\{\s*return this\[([\w$.]+)\]\.url;?\s*\}/g

/** Bundle `entry` into `outfile` (ESM, every module inlined, `.wasm` files
 *  copied beside it) for a wrangler-shaped config with `no_bundle: true`. */
export async function bundleForCelld({ entry, outfile }) {
  const outdir = dirname(outfile),
    entryFile = resolve(entry),
    prelude = resolve('scripts/celld-prelude.mjs')
  mkdirSync(outdir, { recursive: true })
  const pass = (required, banner) =>
    build({
      stdin: {
        contents: `import ${JSON.stringify(prelude)}\nexport * from ${JSON.stringify(entryFile)}\nexport { default } from ${JSON.stringify(entryFile)}\n`,
        resolveDir: dirname(entryFile),
        loader: 'js',
      },
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      mainFields: ['module', 'main'],
      conditions: ['workerd', 'worker', 'browser'],
      external: ['cloudflare:*'],
      define: { 'process.env.NODE_ENV': '"production"' },
      banner: { js: banner },
      logLevel: 'error',
      plugins: [
        {
          name: 'celld',
          setup(b) {
            b.onResolve({ filter: /\.wasm$/ }, (args) => {
              const file = resolve(args.resolveDir, args.path)
              copyFileSync(file, resolve(outdir, basename(file)))
              return { path: './' + basename(file), external: true }
            })
            b.onResolve({ filter: /^[a-z_:/]+$/ }, (args) => {
              if (!builtins.has(args.path)) return undefined
              if (polyfill[args.path]) return { path: polyfill[args.path] }
              const spec = args.path.startsWith('node:') ? args.path : `node:${args.path}`
              if (args.kind === 'require-call') required.add(spec)
              return { path: spec, external: true }
            })
            b.onLoad({ filter: /\.open-next\/.*\.m?js$/ }, (args) => {
              const text = readFileSync(args.path, 'utf8')
              if (!text.includes('get url()')) return undefined
              return {
                contents: text.replace(urlGetter, (_, key) => `get url(){return this[${key}]?.url??this.__celldUrl}set url(v){this.__celldUrl=v}`),
                loader: 'js',
              }
            })
          },
        },
      ],
    })
  // A no_bundle ESM Worker on celld has no require(); serve CommonJS
  // require() of a builtin from static imports instead.
  const required = new Set()
  await pass(required, '')
  const specs = [...required].sort()
  await pass(
    new Set(),
    specs.map((spec, i) => `import * as __celldBuiltin${i} from ${JSON.stringify(spec)};`).join('') +
      `const __celldBuiltins={${specs.map((spec, i) => `${JSON.stringify(spec)}:__celldBuiltin${i}`).join(',')}};` +
      'const require=(name)=>{const m=__celldBuiltins[name.startsWith("node:")?name:"node:"+name];' +
      'if(!m)throw new Error("celld bundle: no builtin "+name);return m.default??m};',
  )
  return outfile
}
