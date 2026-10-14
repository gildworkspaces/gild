# Self-hosting gild on celld

celld (<https://celld.dev>, Apache-2.0) is a self-hosted Workers platform. It
runs Workers, Durable Objects, D1, R2, Queues, Cron and static assets on V8,
and keeps each object's SQLite in one S3-compatible bucket. The aim was to run
the same gild-site build that serves gild.gg on celld, with no separate
self-host edition.

Spike: celld v0.6.2 on demon (Linux x86_64, 4 cores, shared with other lanes),
9 Oct 2026. The release digest
`sha256:ce0ee355…646c` matched GitHub's asset digest, and
`gh attestation verify --repo denoland/celld` passed (workflow
`release.yml@refs/heads/candidate`).

## Verdict

**v1 self-host path: not yet.** The Workers platform part works. gild's
Durable Objects, D1, Queues, cron, R2, service bindings, static assets and the
compiled cqx WebAssembly all run on celld. The complete API gate (`test:api`,
126 operations) passes there, and so do the channel WebSockets.

Three things block a self-hosted forge:

1. **Git storage is Cloudflare Artifacts.** `lib/artifacts.ts` and
   `lib/repo-index-do.ts` call `api.cloudflare.com/.../artifacts` and
   `<account>.artifacts.cloudflare.net` for a hard-coded account. A self-hosted
   gild cannot create, push, clone or browse a repository without a Cloudflare
   account. celld has no Artifacts equivalent. This is a design decision for
   Sami (see the last section).
2. **The Next.js/OpenNext layer needs workerd's Node.js surface.** celld 0.6.2
   has partial `nodejs_compat`, and OpenNext's bundle does not load on it
   unchanged. Six gaps are bridged in `scripts/celld-bundle.mjs` and
   `scripts/celld-prelude.mjs` (issues B–G below). With those bridges, pages
   and Next route handlers serve. A request-body bug (issue H) still breaks
   every POST after the first one in a warm isolate. That bug blocks sign-in.
3. **gild-render cannot reach gild-site's RepoIndex.** celld ignores
   `script_name` on a Durable Object binding (issue A), so static-at-commit
   fragment rendering cannot run. The service binding itself works.

When A, B–G and H are fixed upstream and the git backend is decided, gild on
celld becomes "the same Workers app, your hardware". The bundle bridges here
are temporary and can be deleted one by one as celld fixes each gap.

## Binding table

| binding | result | evidence |
|---|---|---|
| RepoIndex (DO, SQLite, alarms) | works | `test:api:celld`: indexing via alarm, reads, search |
| RunQueue (DO, alarms) | works | `test:api:celld`: dispatch, runner poll/step/logs/finish |
| ForgeEvents (DO) | works | `test:api:celld`: 19 event contracts, SSE, long-poll, durable resume |
| ApiControl (DO) | works | `test:api:celld`: rate limits, token budgets |
| SettingsRename (DO, alarms) | deploys, not exercised | no fixture covers it on any runtime |
| RunnerPool (DO, alarms) | works | `test:api:celld`: groups, eligibility, leases. The fixture needed one change (below) |
| RepoImport (DO) | works | `test:api:celld` import operations |
| RepoChannel (DO, hibernatable WebSockets, alarms) | works | `test:api:celld`: two live browser clients, presence, @mention targeting, revocation |
| DOQueueHandler, DOShardedTagCache, BucketCachePurge | works (exported, unbound) | wrangler.jsonc binds none of them; they load as exports |
| DO migration tags | works | celld accepts `tag` plus `new_sqlite_classes`, which is all gild uses |
| D1 + migrations | works | `celld d1 migrations apply gildforge celld.site.json` applied 0001–0016 in 0.12 s, with wrangler's table and columns |
| R2 | works | gild-render stored `assets/v3/*` through the binding; read back with `celld r2 list` |
| Queues: webhooks producer and consumer | works | `test:api:celld`: signed deliveries, real retries, auto-disable |
| Queues: dead-letter queue | works with change | deploy validated. Retention is a fixed 4 days. There is no backoff, so the delay must come from `attempts` |
| Queues: gild-render consumer | missing | it runs, but every job needs RepoIndex (issue A) |
| Cron (`* * * * *`) | works | added a `repo_access` probe row; the scheduled handler wrote its `fragment_backfill` row on the next minute |
| `cqx/core.wasm` (CompiledWasm import) | works | site and fixture bundles import it and load. The health endpoints in `test:api:celld` pass |
| `gild-cqx-heavy` (WorkerEntrypoint plus RpcTarget wasm) | likely missing | it deploys, but `open()` returns an RpcTarget (`Scan`) to gild-site, and celld documents that an RPC stub cannot cross an isolate boundary. C-family scoring was not exercised |
| service bindings (GILD_RENDER, CQX_HEAVY) | works | `/gild-fragments/v3/router.js` went through GILD_RENDER, which stored it to R2 |
| cross-script DO binding (gild-render → gild-site RepoIndex) | missing | issue A |
| static assets (`.open-next/assets`) | works | `_next/static` p50 1 ms |
| vars | works | `vars` in the derived config |
| secrets | works with change | celld has no secret store. `celld.vars.json` is merged into `vars`, so secrets sit in the bucket's deployment manifest |
| Workers Builds equivalent | works with change | `bun run build:cloudflare && bun run build:celld`, then `celld deploy` per config (cqx-heavy, render, site last). A running node picks up the new version within 30 s, with no restart. Any CI job with bucket credentials can run this |
| Next.js / OpenNext worker | works with change | needs the bridges for B–G, and POST is still broken (issue H) |
| Cloudflare Artifacts (git) | missing | not a celld binding; see the verdict |

## gild-site's own gates on celld

Only `test:corner` accepts a base URL. Every other gate builds its own fixture
Worker and starts it with `wrangler dev`. This PR adds `GILD_TEST_RUNTIME=celld`
to `scripts/api-local.mjs`, and the same fixture then runs on a celld node
(`bun run test:api:celld`). Each run uses its own bucket prefix.

| gate | wrangler (workerd) | celld 0.6.2 |
|---|---|---|
| `test:api`, which includes events, sessions, channel, the webhooks/receipt/channel browsers and stars | pass | **pass** (126 operations) |
| `test:runners:local` | pass | not run: `forge-fixture.mjs` runs the full OpenNext app as three Workers with a cross-script DO (issues A and H) |

Manual pass on the real build:
- **Landing, docs and 404 pages:** these serve.
- **Sign-in:** the key challenge flow works only on a cold isolate, because of issue H.
- **Creating a repo, git push, browsing, issues, Actions with `--isolation vm`:** all blocked, because they need Cloudflare Artifacts.

The same runner, channel and API contracts pass on celld through `test:api:celld`, which uses a disposable git fixture.

Anonymous API calls need `CF-Connecting-IP` (gild rate-limits by client IP).
On celld, the ingress proxy must set that header to the client address and
strip any value the client sends.

## Numbers

These are from demon, a shared 4-core box with a load average of 7–36 from
other lanes during the runs. Read them as orders of magnitude.

| measure | celld | comparison |
|---|---|---|
| node start → serving | 4.05 s, then first `/` in 0.14 s | — |
| cold isolate (first `/` after 45 s idle) | 1.12–1.23 s; warm 28–47 ms | celld retires idle stateless isolates at about 30 s |
| `/` page p50/p95 | 26 / 42 ms (loopback) | gild.gg from demon: 178 / 433 ms (WAN plus edge) |
| `/docs` page p50/p95 | 83 / 306 ms | gild.gg: 500 / 870 ms |
| API `openapi.json` p50/p95 | 25 / 46 ms | gild.gg: 363 / 758 ms |
| code-path API (`contents/README.md`, fixture) p50/p95 | 33 / 47 ms | wrangler dev on the same box: 136 / 163 ms; gild.gg answered 429 to anonymous calls |
| memory, fixture node idle → 50 repos | 139 → 149 MB RSS | wrangler dev plus workerd: 742 → 1030 MB |
| memory, real build node (OpenNext, about 20 MB bundle) | 331 MB RSS | — |
| repo create (D1 plus DOs plus `_meta` git push) | 118–198 ms each | wrangler dev: 219 ms |
| kill -9 mid-create, then restart | 3 creates were acknowledged before the kill, one was in flight. All 53 repos read back. A never-created control repo returned 404. Restart → serving took 0.67–1.15 s | single node: each write waits for the bucket (RPO 0) |

Operational note: while demon was at load 37 on 4 cores, the local SeaweedFS
took 2.5 s or more to answer a lease renewal. Both celld nodes logged
`SELF-FENCE: node lease not renewed within TTL — halting` and exited. This is
the documented safe behaviour. Run celld under a supervisor (systemd or Docker
with restart), and do not put the bucket on the same overloaded host. A run of
`test:api:celld` that coincided with the fence failed with "other side
closed". The rerun under the shared heavy-build lock passed.

## What this PR changes

| change | purpose |
|---|---|
| `scripts/celld-config.mjs` | Derives each celld config from the wrangler config, which stays the single source of truth. It drops the edge-only keys celld refuses and defines `NODE_ENV` the way wrangler does. |
| `scripts/celld-bundle.mjs` and `scripts/celld-prelude.mjs` | Prebuild a `no_bundle` Worker from the same inputs. They bridge B–G, and nothing in them runs on Cloudflare. |
| `scripts/celld-build.mjs` (`bun run build:celld`) | Writes `celld.{cqx-heavy,render,site}.json` and prints the deploy order. It warns when it drops the cross-script DO binding. |
| `scripts/celld-runtime.mjs`, plus the `api-local.mjs` switch | Run the API gate on celld (`bun run test:api:celld`). |
| `scripts/api-fixture/runtime.ts` | Reads the fixture remote and bindings from `cloudflare:workers` `env` when `configure()` ran in another isolate. celld always places Durable Objects in their own isolates; workerd shares one isolate per script. |

Nothing changes for gild.gg: `worker.ts`, `lib/` and the wrangler configs are
untouched.

## Self-host steps (as run)

```sh
# bucket: any qualified S3 store. MinIO is archived (2025) and its images are gone;
# SeaweedFS passes `celld diagnose` (conditional writes) for local use.
export CELLD_BUCKET=s3://gild-celld S3_ENDPOINT=http://127.0.0.1:9100 AWS_REGION=us-east-1 AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=…
bun install --frozen-lockfile && bun run build:cloudflare && bun run build:celld   # Node 26
celld deploy celld.cqx-heavy.json && celld deploy celld.render.json && celld deploy celld.site.json
celld --listen 127.0.0.1:8790 --internal-listen 127.0.0.1:8791 &
celld d1 migrations apply gildforge celld.site.json
# TLS + CF-Connecting-IP at your ingress (celld serves plain HTTP)
```

## Upstream celld issues (drafts, not filed)

**A. A Durable Object binding ignores `script_name`.**
`durable_objects.bindings[].script_name` is dropped at deploy
(`deploy.rs` keeps only `name` and `class_name`). The class is then registered
as the binding script's own, and the node refuses to start with "Durable
Object class RepoIndex is exported by more than one co-hosted script". Without
that collision, `idFromName` would also derive ids under the wrong namespace
key, because the key contains the script name. Expected behaviour: bind the
named script's namespace, as wrangler does. Until that works, deploy should
reject `script_name` loudly.

**B. `node:http`, `node:https` and `node:net` are inert stubs.** workerd
provides them under `nodejs_compat`, with dates from 2025-08-15. OpenNext
builds every request on `http.IncomingMessage` and `ServerResponse`, and Next
constructs `http.Agent` at startup. `net.isIP` is the usual SSRF guard. The
stubs cannot be patched, because their `get` trap ignores assigned members.

**C. `globalThis.process` lacks the EventEmitter methods.** `on`, `listeners`,
`emit` and the rest are missing. Next calls `process.listeners()` at load.

**D. The `node:fs` namespace answers `__esModule` with a truthy stub.** Babel
and TypeScript interop (`_interop_require_default(require('fs')).default`)
then reach `node:fs.default.existsSync`, which throws.

**E. `Readable.toWeb` and `Writable.toWeb` throw.** They fail with
`lazyWebStreams(...).newReadableStreamFromStreamReadable is not a function`.
Next's render pipeline uses them. The symptom is a request that never answers
("handler is waiting on nothing").

**F. The `Request` constructor assigns `this.url` as an own property.** A
subclass with a getter-only `url`, such as Next's `NextRequest`, therefore
throws "Cannot set property url of #<NextRequest> which has only a getter".
workerd keeps `url` internal.

**G. `console.createTask` exists but throws.** React's development build
feature-detects it, so any bundle that includes React development code fails
to load. workerd does not define it.

**H. The inbound request body is empty on a warm isolate (gild-site
bundle).** With the bundle bridged as above, the first POST after an isolate
starts reads its 89-byte JSON body. Every later POST in the same isolate reads
0 bytes from its first `arrayBuffer()`. The identical bundle under
`wrangler dev` reads 89 bytes every time. Minimal probes (clone, `new Request`,
`waitUntil`, streamed responses) did not reproduce it, so the repro is this PR's
`celld.site.json` plus `POST /api/auth/answer` twice.

**I. Configuration and bundling papercuts.**
- `celld deploy` refuses `build`, `limits`, `routes: []`, `workers_dev` and `preview_urls` instead of ignoring them with a warning.
- It has no `alias`.
- It does not define `process.env.NODE_ENV="production"` the way wrangler does, so React's development build ships.
- A `no_bundle` ESM Worker gets no `require()` for CommonJS dependencies.

**J. A Durable Object RPC error loses the callee's stack.** `__rpcDes`
replaces the stack with the caller's, which hides where a DO method failed.

**K. There are no secrets.** Secrets can only be deployed as `vars`, so they
are stored in the fleet bucket's manifest. A `celld secret put` that keeps
secrets out of the deployment manifest would match wrangler.

## Decision needed (Sami)

Where do self-hosted repositories live?

- **(a) Bring your own Cloudflare Artifacts account.** Make the hard-coded
  account a config var. Compute is self-hosted, storage stays Cloudflare-shaped.
  This is the smallest change.
- **(b) A self-hosted git backend behind the same `lib/artifacts.ts` surface.**
  For example, git on R2 or a cell.

Recommendation: (a) for v1, because it keeps the CF shape the pitch depends on.
(b) belongs in an APS entry, since it is the only route to fully self-hosted.
