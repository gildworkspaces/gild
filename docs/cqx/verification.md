PR #37 now integrates `origin/main` at `9d08414` (PR #36) with a merge on `codex/cqx-modules`.

The old organization-only cards and `lib/org-summary.ts` are removed. Their score calculation, partial-scan note and retry behavior now live in the shared `repoList()`/`RepoList` path; #36's language, license, activity, stars and shared row layout remain. Successful scores reuse the immutable commit/cqx BUILD/reads-version cache through the same `scoreHead()` cache as the Score page. Incomplete reports are never cached, and a report with zero scored lines has no numeric headline. Mutable refs are resolved before lookup. Viewer/ACL and live star counts stay outside the immutable code-facts cache. Notes use the existing gild Score warning text in #36's row metadata; the score categories continue the cqx.bio pattern.

The merge preserves both script sets, #36's empty-body 204 handling and #37's `noStore` ETag/304 guard. The API fixture now waits through refreshes using the production readiness helper instead of treating an existing repository as missing. Non-blocking index reads remain non-blocking. The corner checker waits for the three known streamed redirect destinations before measuring and fails on navigation errors. The repo-list and runner gates pass with that corrected checker. The Score-page test requires a rendered `#score` section and actual cache entry, so an HTTP 200 error shell cannot pass.

cqx **v0.1.26 is not released**: `gh release view v0.1.26 --repo cqxai/cqx --json tagName,url,assets` returned `release not found` at the final release check. The v0.1.25 pin, hashes and BUILD remain unchanged. The version/integrity/BUILD update and upstream partial-parse coverage labels are deferred. [cqx #82](https://github.com/cqxai/cqx/issues/82) remains visible in the [Lua and tinyxml2 screenshots](./score-pages.md); their clean C/C++ 100s do not prove complete coverage.

Workers Builds remains compatible with the configured sequence: `npm run build:cloudflare`, followed by `npx wrangler deploy -c wrangler.cqx-heavy.jsonc && npx wrangler deploy`. The private heavy binding and both configurations remain intact. Bundle checks use Wrangler dry runs only.

Local verification on Node 26.3.1 and Google Chrome 154.0.8037.98:

- CLI prerequisite (`codex/owner-runners`, `df3ca7c`): `bun install --frozen-lockfile` and `bun run build` passed.
- Site `bun install --frozen-lockfile` passed with no dependency changes.
- `bun run test`: 205 passed, 0 failed. `bunx tsc --noEmit` passed.
- `bun run test:api`: all 122 Phase A operations, actual CLI and Octokit passed. The first run caught the stale fixture refresh behavior; the corrected adapter passes the full suite.
- `bun run test:events`: all unit/runtime tests, 19 event contracts and full API coverage passed.
- `bun run test:sessions`: all receipt tests, four real contracts, browser overlays and full API coverage passed.
- `bun run build:cloudflare`: OpenNext build and release-integrity checks passed.
- `bun run test:cqx:bundles`: core only in main; c/csharp only in heavy; both below 10 MB gzip. [Sizes and hashes](./bundles.json).
- `bun run test:cqx:local`: six actual repository snapshots, identical direct/cached reports, one immutable score entry per repository, 20 theme/width screenshots; then outage, BUILD mismatch, C-only/partial pages, API no-store, file/byte limits, no partial cache entries, recovery and cache-hit checks passed.
- `bun run test:runners:local`: actual CLI jobs, 100 runners across 20 repositories, browser cases, immediate metadata navigation and every corner page/width passed.
- `bun run test:theme`: all five SSR/hydration/palette scenarios passed.
- `bun run test:repo-list` and `bun run test:repo-list:local`: shared data, D1 persistence, stars, private-read boundary and production settings/browser flows passed.

The shared-list regression fails with the note assignment reverted; it also fails with the zero-lines headline guard reverted (`72 !== null`). Both mutations were restored. Existing PR #37 module-routing and failure/limit revert proofs remain documented in the earlier review evidence; this merge does not change that implementation. [Current gate results](./merge-gates.json) are committed. Command logs and the two new revert logs are under `.tmp/merge-validation/`.

[Requested Score page screenshots](./score-pages.md) include cJSON, Lua, tinyxml2 and Polly in light/dark at 1400/400 px. All four desktop images and representative dark phone images were visually reviewed; the browser checks verify five dials, themes and section overflow at every size. [Source commits, findings and first/cached timings](./evidence.json) and [failure-page evidence](./failures.json) are saved alongside them.

First-view timings include indexing retries until a real Score section and cache entry exist. They are local wall time on the shared iMac, not production CPU estimates:

| Repository | First Score view | Cached Score view | First-view attempts |
| --- | ---: | ---: | ---: |
| avatest/cJSON | 6704 ms | 1545 ms | 1 |
| avatest/lua | 12134 ms | 72 ms | 2 |
| avatest/tinyxml2 | 1803 ms | 89 ms | 1 |
| avatest/Polly | 16139 ms | 72 ms | 3 |
| avatest/jsoup | 12795 ms | 82 ms | 2 |
| avatest/moshi | 3262 ms | 73 ms | 1 |

No debugger or profiler was used. No PR merge, deployment, release, remote migration or CI polling occurred.

-codex
