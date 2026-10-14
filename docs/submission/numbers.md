# gild: numbers

Measured facts only. Each one says where it came from and how it was measured.
If a number is reused in the pitch, the video or the form, it comes from this
page. **Re-measure the page timings on 12 Oct** (after the feature freeze) and
update this page before submitting: a deploy can move them.

## 1. Page speed on gild.gg

**When and where:** 9 Oct 2026, 20:24–20:28 UTC, from Sami's iMac on a home
connection. Cloudflare served it from Seattle (`cf-ray …-SEA`). These are
measurements from one place, not a global average.

**Method (browser):** [`measurements/measure.mjs`](measurements/measure.mjs)
uses headless Chromium through playwright-core at 1280×800. Each URL is loaded
three times, and each load gets a **new browser context**, so the browser cache
is always empty:
- run 1 is the first request for that URL in the session (**cold**);
- runs 2 and 3 follow it (**warm**: the edge cache now holds the page).

TTFB is the Navigation Timing `responseStart`. LCP comes from a buffered
`largest-contentful-paint` observer, read 1.5 s after `load`. Raw rows are in
[`measurements/chrome-2026-10-09.jsonl`](measurements/chrome-2026-10-09.jsonl),
including each response's `server-timing` and `cf-cache-status`.

To re-run:

```sh
bun install --frozen-lockfile        # in gild-site; brings playwright-core
node docs/submission/measurements/measure.mjs "$PWD/node_modules/playwright-core" \
  "https://gild.gg/avatest/lua?path=lauxlib.c" "https://gild.gg/avatest/PHPMailer/issues"
```

Pick files and repos nobody has opened recently for the cold runs: a URL is
only cold once.

### Code page (a file open in the repo view)

| URL | run | TTFB | LCP | server-timing (Worker) |
|---|---|---|---|---|
| `/avatest/lua?path=lauxlib.c` | cold | 551 ms | 852 ms | 177 ms: index 33, R2 fragments 132, render 0 ("stitch only") |
| | warm | 190 ms | 512 ms | 33 ms "stitched edge hit" |
| | warm | 236 ms | 576 ms | 35 ms "stitched edge hit" |
| `/avatest/cJSON?path=cJSON_Utils.c` | cold | 360 ms | 812 ms | 176 ms: index 48, R2 fragments 122, render 0 |
| | warm | 450 ms | 1196 ms | 121 ms "stitched edge hit" |
| | warm | 208 ms | 512 ms | 37 ms "stitched edge hit" |
| `/avatest/moshi?path=CHANGELOG.md` (already warm) | warm | 189 / 337 / 221 ms | 356 / 528 / 400 ms | 27–43 ms "stitched edge hit" |

### Issues page

| URL | run | TTFB | LCP | server-timing (Worker) |
|---|---|---|---|---|
| `/avatest/Alamofire/issues` | cold | 426 ms | 576 ms | 180 ms: published HTML read from R2 |
| | warm | 146 / 222 ms | 272 / 372 ms | 35 / 102 ms (edge) |
| `/avatest/PHPMailer/issues` | cold | 580 ms | 736 ms | 313 ms: published HTML read from R2 |
| | warm | 137 / 143 ms | 344 / 284 ms | 35 / 47 ms (edge) |
| `/avatest/moshi/issues` | cold | 308 ms | 460 ms | 176 ms: published HTML read from R2 |
| | warm | 182 / 838 ms | 336 / 1088 ms | 44 / 30 ms (edge) |

### Summary of the browser runs

| | runs | median TTFB | median LCP | range of TTFB |
|---|---|---|---|---|
| cold (first request for the URL) | 5 | 426 ms | 736 ms | 308–580 ms |
| warm (edge cache holds it) | 12 | 215 ms | 456 ms | 137–838 ms |

In every run, `render;dur=0`: no request rendered a page. Cold requests read
stored fragments or stored HTML from R2. Warm requests were answered from the
edge cache in 27–121 ms of Worker time.

**Honest caveat:** the Worker's own time on a warm hit is 27–121 ms, but the
TTFB that a browser sees has a long tail (838 ms above; 1–2.7 s seen earlier on
9 Oct). The cause is under investigation on the `claude/nav-gate` lane. Quote
medians, not best cases.

### curl, warm, 5 requests each (20:28 UTC)

[`measurements/curl-2026-10-09.txt`](measurements/curl-2026-10-09.txt):
`curl -s -o /dev/null -w "%{http_code} %{time_starttransfer}"`, so this
includes DNS, TCP and TLS on every request.

| URL | TTFB, sorted (s) | median |
|---|---|---|
| `/` (landing) | 0.177 0.181 0.250 0.342 1.687 | 250 ms |
| `/avatest/moshi` (repo home) | 0.143 0.225 0.799 0.928 1.092 | 799 ms |
| `/avatest/moshi/issues` | 0.134 0.207 0.263 0.331 0.334 | 263 ms |
| `/avatest/moshi/score` | 0.114 0.189 0.224 0.244 0.348 | 224 ms |
| `/api/v1/openapi.json` | 0.156 0.209 0.252 0.708 1.021 | 252 ms |

An earlier curl series at 20:19 UTC gave 0.16–0.34 s for the repo home and
0.15–0.93 s for the issues page. The variance is real; see the caveat above.

## 2. Isolation: microVM, container, host

**Source:** gildforge/cli `FINDINGS.md` on main, plus the PR bodies of
[cli#32](https://github.com/gildforge/cli/pull/32) and
[cli#35](https://github.com/gildforge/cli/pull/35). Measured on demon (Linux
x86_64, KVM, 4 cores, Firecracker 1.15.1, stock 5.10 guest kernel), 9 Oct.

| measure | result |
|---|---|
| cold boot to a guest agent answering on vsock, original boot args (3 runs) | 1212 / 1196 / 1192 ms |
| **cold boot with `i8042.noaux i8042.nokbd i8042.nopnp i8042.dumbkbd quiet` (3 runs)** | **308 / 312 / 309 ms** |
| microVM ready inside a real Actions job (`executeJob`, 2 runs) | 327 / 301 ms |
| packing the checkout into the per-job ext4 image | about 48 ms (small repo) |
| whole 7-step probe job in a VM (clone, boot, steps, teardown) | about 620 ms |
| the same job with `--isolation none` / `container` | 3.5 s / 2.0 s (includes first-run git warm-up) |
| exec round trip over vsock (`echo hi`) | 4.7–7.0 ms |
| `gild spawn --vm` ready, including Bun start-up | 1.1 s (FINDINGS), 1.26 s (9 Oct rehearsal) |
| `gild sync` (guest changes back to the host) | 0.30 s |
| guest agent, Rust, musl release build | 640 KB |
| macOS container tier (Colima 0.10.3, vz): a full job | 7.5 s wall clock, including Bun, a git server, clone, container start and 7 steps |

The 0.31 s boot needs no snapshot and no warm pool: the stock kernel spent
about 500 ms probing a PS/2 keyboard that does not exist, and the boot
arguments above remove that.

**Isolation proof (cli#32, live on demon):**

| probe | host (control) | container | vm |
|---|---|---|---|
| https://gild.gg and DNS | n/a | reachable | reachable |
| LAN, bridge, tailnet IPs, 100.100.100.100 | reachable | blocked | blocked |
| 169.254.169.254 (metadata) | no route | blocked | blocked |
| one VM to another VM | | | blocked |

## 3. Code Score languages

**13 languages**, from `lib/cqx-reads.ts` (the one table that both the reads and
the UI's language list are built from) and `cqx/manifest.json` (cqx 0.1.26):

Rust, TypeScript, JavaScript, Go, Java, Kotlin, Swift, Zig, Python, PHP, C,
C++ and C#.

The five categories are the same for every language: Quality, Containment,
Legibility, Security and Modularity.

| WebAssembly module | languages | size | where it runs |
|---|---|---|---|
| `core.wasm` | the first 10 | 8.7 MB | inside `gild-site` |
| `c.wasm` | C, C++ | 4.7 MB | `gild-cqx-heavy`, over RPC |
| `csharp.wasm` | C# | 9.8 MB | `gild-cqx-heavy`, over RPC |

## 4. API size and contract coverage

| fact | number | how |
|---|---|---|
| operations in the canonical contract (`lib/api/contract.ts`) | **203** | count of `routes` |
| operations in the live OpenAPI document | **203** across 143 paths | `GET https://gild.gg/api/v1/openapi.json`, 9 Oct 20:20 UTC |
| GitHub-shaped operations (GitHub's paths and field names) | 104 | routes whose `github` flag is set |
| by method | 85 GET, 62 POST, 16 PATCH, 14 PUT, 26 DELETE | |
| Phase A operations exercised end to end through the production Worker fixture | 136 | CI step `test:api`: "API contract: 136 Phase A operations exercised … coverage check passed" (run 37984434173, main 8791cb7) |
| token scopes | 9 | `repo:read`, `repo:write`, `channel:write`, `issues:write`, `pulls:write`, `actions`, `hooks`, `agents`, `admin` |
| Octokit compatibility proven in the gate | list repos, read contents, create issue, create pull | `scripts/api-local.mjs` evidence |

The contract is the one source: runtime validation, routing, docs, OpenAPI and
the CLI's generated client all read it.

## 5. Tests

| suite | count | where |
|---|---|---|
| gild-site unit tests (`bun run test`) | **281 pass, 0 fail** | CI run 37984434173 on main 8791cb7, 9 Oct 20:05 UTC |
| gild-site `test:events` / `test:sessions` | 16 / 9 pass | same run |
| gild-site CI gates | 26 steps in `api.yml` (unit, typecheck, API, privacy, channel, orchestrator, import, static, fragments, cqx bundles, runners, and their revert proofs), plus `theme.yml` | `.github/workflows/` |
| gild CLI main suite | **228 tests: 215 pass, 13 skip, 0 fail** | CI run 37980463254 on cli main 72550ab |
| gild CLI PTY and npm-launcher suites | 68 pass; 3 + 3 pass (setup-node on macOS 15 and macOS 15 Intel) | same run |
| Cloudflare OS Gatekeeper (gild-site#67) | 3 unit + 11 workerd tests, 5 revert proofs | PR body |

**State of main on 9 Oct, 20:10 UTC:** the gild-site `api` workflow on
8791cb7 failed at `test:channel:web` (a browser wait that timed out). The same
step flaked on gild-site#59, so treat it as a flake. Check main is green
before quoting "all gates green".

Locally (iMac, without the full Cloudflare build), `node --test lib/*.test.ts`
gave 278 of 280 passing. The 2 failures need `.render/next-assets.json`, which
only `bun run build:cloudflare` produces, and CI runs that build first.

## 6. Size of what ships

| piece | number |
|---|---|
| Workers | 3: `gild-site` (OpenNext + forge), `gild-render`, `gild-cqx-heavy` |
| Durable Object classes bound by gild-site | 8 |
| D1 migrations | 18 (`migrations/0001`–`0018`) |
| Queues | 4 (`gild-render`, `gild-webhooks`, `gild-webhooks-dead`, `gild-public-pages`) |
| `gild-render` bundle | 3.6 MB (`.render/worker.mjs`, no Next.js, no scorer WASM) |
| CPU limit | 30 s per request, set in all three wrangler configs |
| gild CLI on npm | `gildforge@0.6.0`, MIT |
