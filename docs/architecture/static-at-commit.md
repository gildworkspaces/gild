# Static at commit time

The read-path and header descriptions below document the original phase. See
[public static reads](public-static-reads.md) for current access leases,
hash-addressed assets, public page producers and validation.

Sami's architecture decision, 8 October 2026: **commits produce HTML; requests never compute it.** Code pushes and `_meta` writes publish immutable presentation artifacts. Browsing fetches those artifacts; changing a commit never builds or deploys the website.

## Responsibilities

`RepoIndex` owns Git objects, committed ACLs, mutable ref pointers and durable render projections. The existing post-push path records the accepted tip immediately, schedules indexing, then publishes a Queue job after the new snapshot is complete. A pending tip returns a preparation response rather than silently displaying the previous tip. `_meta` changes use the same completion path, including updated counts and ACLs. Description/default-branch settings changes also republish home inputs.

`gild-render` is a separate Worker, configured in `wrangler.render.jsonc`. It consumes Queue `gild-render`, accepts producer render calls through its internal service binding, and stores the versioned browser assets in R2 beside their shells. The build packages those compiled JS/font bytes into the Worker; Queue jobs copy them directly, without an HTTP assets binding. Real Wrangler Queue calls to the assets binding returned 500 while the same HTTP calls succeeded, so this dependency is deliberately absent. It has no public render endpoint, Next.js, OpenNext, Git credentials, or scorer WASM. It calls the index for validated input, renders shared components with `react-dom/server`, highlights with Shiki, renders Markdown with markdown-it, gzips the output, and stores it in R2 bucket `gild-fragments`.

`packages/render` owns the presentation and address format. File/folder/home/commit/Score/Glance components accept data and contain no server data fetching. Existing Next pages import the same Health, Glance, Diff, Picture, receipt and action components. The shell and islands are shared browser presentation. CSS modules are compiled into stable names for the standalone Worker and its browser entry points.

`gild-site` resolves names, checks private access, fetches stored artifacts, and streams the shell plus stored HTML. It never invokes React, Shiki, Markdown, Git or cqx on this browse path. Other phase-one pages, especially Actions, retain their existing live APIs and event/polling behavior. Issues/PRs/agents move to `_meta` fragments in phase two.

## Addresses and invalidation

The one implementation is `packages/render/address.ts`. Public storage is `f/v<N>/<kind>/<hash>`, public HTTP is `/f/v<N>/<kind>/<hash>`. All presentation-dependent data is versioned. Content hashes never change in place; invalidation is **none**.

| Kind | Immutable input |
| --- | --- |
| `blob` | Git blob hash, grammar and code/README presentation mode |
| `source` | Git blob hash |
| `tree` | Git tree hash |
| `manifest`, `bundle` | Root Git tree hash |
| `home` | Code tip, `_meta` tip, digest of repo/ref/settings/presentation inputs |
| `commit` | Commit SHA; Score and live state are separate sections |
| `score` | Commit SHA, cqx build, digest of the report/comparison inputs |
| `glance` | Base SHA and head SHA; `root` represents no parent |
| `shell` | Presentation version |
| phase-two `issue`, `pull` | `_meta` tip and item number |

Blob highlighting includes the grammar in its address because identical bytes under two extensions can highlight differently. Home includes the repository and refs/settings because the same commit can exist in multiple repositories or branches. Score includes its actual report inputs: a partial outage report must never occupy the eventual complete report's address. Parent comparisons are separate Score artifacts, so a cqx build/status change does not mutate commit HTML.

The producer compares old/new manifests and emits only changed blob/tree addresses plus changed composite artifacts. Items are deduplicated and paginated at 50 per message. The renderer checks R2 before computing; retries preserve successful puts. It continues independent items after an item fails, then retries the batch instead of acknowledging partial work. Transient incomplete scores cause a queued projection retry; deterministic size-limit reports remain explicit. Complete scores reuse the existing D1 cache; partial reports never enter it. Owner cards receive the write-time partial-status note in their existing batched listing projection.

A renderer UI deployment bumps `RENDER_VERSION`, without a site build. The minute cron advances published pointer versions and enqueues new projections; pointer requests only read published addresses. New pointer URLs select the renderer's assets and fragments; previous immutable URLs and their JS/font assets stay readable. Cold history requests schedule object/snapshot hydration through the index; rendering then runs through the background Queue. Missing bare hash URLs do not probe repositories. An on-miss call requires repo/commit/path context, validated against that snapshot before any object is published.

## Reads, SSR and navigation

A public fragment hit is intercepted before lifecycle middleware and OpenNext: **one R2 read, zero DO calls, zero D1 calls and zero render calls**, even with an empty edge cache. Gzip responses also enter Cloudflare's Cache API under their canonical path. Headers are `Cache-Control: public, max-age=31536000, immutable`, `ETag`, `nosniff`, and `Server-Timing`. Responses preserve R2's gzip bytes using manual body encoding; identity clients get decompression.

`/api/fragments/<owner>/<repo>` is a small, uncached name/address lookup. Public shareable URLs remain `/<owner>/<repo>?ref=…&path=…`, `/score`, and `/commit/<sha>`. First loads fetch shell/home/selected artifacts in parallel and stream their concatenation. Commit loads add a stored Score comparison artifact. Query selections choose already compiled sections; they do not render or compute a layout. No-JavaScript file/folder, Score-category and commit-file links still work. Context substitution touches only presentation-owned attributes; literal placeholder-like strings inside source remain unchanged. Raw links use native downloads, preserving the filename and bytes. Code-route RSC requests cannot fall through to the old dynamic server-component path.

The browser router swaps the file pane on a same-tip file click, preserving the repo header, sidebar and shell. Cross-tab browsing swaps the stored page body, uses History API, and preserves Back/Forward and anchors, including the compiled default Score category. Immutable object bodies survive tip refreshes; only mutable lookups are discarded. Branch selection and window focus refresh mutable pointers. Identity/search controls stay outside the swapped root.

One delegated intent mechanism covers both Next links and ordinary anchors, including Markdown and newly inserted tree rows: 65 ms hover, focus, and touchstart. Mouseleave cancels the delay; requests are deduplicated with four scheduler slots. Next links disable their separate viewport prefetch and request full route data through the shared scheduler. Standalone navigation consumes prefetched fragment/page HTML. Downloads, external/non-GET endpoints, auth/sign-out and explicitly excluded links never prefetch. `saveData`, `2g` and `slow-2g` disable intent and automatic source prefetch.

## Browser source storage

Eligible tips get one gzip bundle containing text and the already rendered blob HTML. The manifest also carries compiled folder HTML, so opening folders and files needs no request after preload. Work happens in a dedicated Web Worker; OPFS holds bodies and IndexedDB holds metadata, with IndexedDB bodies as the fallback. A 200 MB LRU limits persistent storage. In-repo search scans these local sources. A new tip fetches its manifest and only missing blob HTML/source pairs; unchanged blob keys are reused across tips.

The automatic bundle limit is 10 MB gzip, excluding binary, minified/generated files and vendor/build/dependency trees. Bundle JSON is streamed into gzip one file at a time and stops at the compressed cap, so highlighted HTML never accumulates for the whole tip. A 20 MB raw-input ceiling additionally bounds Worker memory before gzip; tips exceeding either cap retain immutable folder/file reads as their floor. Large files over 1 MB and minified files render a plain raw-view stub; binary files get a download/raw stub.

The design follows cqx-kit `src/engine/held.ts` (versioned immutable address, browser-held data), `src/engine/github.ts` (tree names every blob, fetch by blob identity), and `src/workers/read.ts` (work off the main thread). The current published kit interfaces also own GitHub transport, analysis and its published store. Importing those interfaces would pull those concerns into browsing. Gild instead exposes one shared presentation-address implementation for its index, renderer, site and browser; it does not copy the kit's cache module. A cross-repository extraction/package publication is a separate change. Reusing cqx's tree-sitter grammars later is viable at render time; the present Worker uses fine-grained Shiki grammars with its JavaScript regex engine and dual CSS-variable palettes, without loading scorer WASM.

## Private repositories and islands

Private R2 keys have a separate `private/<random scope>/` prefix that is never returned or listed publicly. HTTP uses `/pf/<owner>/<repo>/v<N>/<kind>/<hash>`, with the current shared `mayReadAcl` check before every object read. Signed cookies use the same signature/expiry verifier as the site; bearer tokens retain expiry/revocation, scope and repo restrictions. Private responses are always `private, no-store`, vary on Cookie/Authorization, and never enter the public edge cache. A pending committed ACL fails closed until indexing catches up. The renderer checks the scope before fetching input and again before publishing.

Browser private entries include principal and scope, never share public keys, and are erased from OPFS/IndexedDB and in-memory caches on sign-out. A BroadcastChannel propagates the erase to other tabs and workers.

Cached HTML contains no viewer identity, star state, permissions or unread state. One small no-store island API supplies identity, avatar, star count/state and settings access. Star mutations use the existing API. Commit run marks use the live Actions API and poll active runs; session receipts remain an uncached island until phase two moves them to `_meta` artifacts. Actions runs/logs, runner status, webhooks and event streams stay live.

## Deployment and verification

`npm run deploy` verifies artifacts/builds first, then deploys **gild-cqx-heavy → gild-render → gild-site**, failing at the first failed stage. Ava switches Workers Builds to this command only when this stack is merged. The R2 bucket already exists. Queue `gild-render` is not yet provisioned (read-only inventory on 8 October); Ava must create it and verify the service/DO bindings before deployment. Commit pushes enqueue work; they never invoke this deploy command.

`bun run test:fragments` uses actual workerd, SQLite RepoIndex, D1, Queue, React/Shiki and gzip R2. It asserts cold public call counts, server budgets, byte/content effects, unchanged-key reuse, a missing-fragment fill, accepted-tip fencing, private ACL/auth/cache behavior, browser zero-network opens/deltas, intent/saveData, history, no-JS selections, responsive themes and signed-in corner clearance. It also swaps only the renderer to v2 while the site stays compiled as v1, and runs a revert proof that restores per-request repository lookup and must fail the call-count budget. `test:cqx:bundles` dry-runs all three deploy bundles and forbids Next/OpenNext/scorer WASM in the renderer. Both gates run in CI.

See [validation evidence](static-at-commit/validation.md) for timings, gates, revert failure and screenshots. Local timings and screenshots are evidence of the fixture, not claims about production latency. Live deployment measurements follow review/deployment by Ava; this lane neither deploys nor polls CI.

-codex
