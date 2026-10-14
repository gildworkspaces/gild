# Fast reads phase 2 evidence

This change caches immutable presentation work while preserving the current
repository read check. See [measurements.json](measurements.json) and the
light/dark before/after captures in [screenshots](screenshots).

## Measurements

The frozen Lua fixture is 61,763 bytes. Its complete stored blob HTML falls from 683,681
to 153,347 bytes (2.483x source, 77.6% smaller). All visible source characters
retain their exact computed colour in both themes. At lines 1, 600 and 1500,
99.9526–100% of screenshot pixels match; the small differences are glyph
rasterization at merged token boundaries. Line anchors are expanded by the
same presentation function in the no-JS page and browser router.

Local Miniflare GET `/avatest/lua?ref=main&path=lvm.c`, using the same frozen
source and before pipeline pinned to `2ae97cf15df302e7a86b540380353b97014a5ae5`:

| Measurement | Before | After |
| --- | ---: | ---: |
| Cold TTFB | 627.84 ms | 260.02 ms |
| Warm TTFB | 134.33 ms | 34.40 ms |
| HTML bytes | 751,966 | 385,416 |
| Warm D1 / DO / R2 calls | 5 / 1 / 3 | 1 / 0 / 0 |
| Warm renderer pointer fetch | 1 | 0 |

These are individual local samples while other gates ran, not a production
latency promise. The separate live-before request returned 783,161 bytes with
TTFB 2,381.18 ms then 2,377.94 ms. No deployment or live-after measurement was
performed. Ava's supplied live baseline reported cold-render 503s three times
at 2–3 seconds each and a 1–2 second outage after each push.

The queued-render regression returns highlighted HTTP 200; the final sample and fallback timing are recorded in `measurements.json`.
Permanent highlight failure returns escaped source HTTP 200 after the bounded eight-second wait.
Reverting either wait or fallback fails the corresponding response/content
assertion. Reverting previous-tip handling fails the pending-push pointer test.
A real smart-HTTP clone/commit/push through the compiled production Worker
returned new source 637.31 ms after `git push` returned: all 16 anonymous reads
throughout the push/index interval returned HTTP 200.

## Cache and retention decisions

Branch/tag pointers and their manifest are published atomically in D1. A public
page checks current visibility/lifecycle and resolves its selected file with
one joined D1 read, then serves stitched public HTML cached by immutable pointer,
path and query. Viewer islands load separately. Private responses stay no-store.
The presentation stylesheet is linked at an immutable versioned asset URL.

For #40, keep deduplicated shared fragments and shorten edge retention to 60
seconds; browser responses require revalidation. The minute cron deletes up to
100 orphaned fragment keys per run from R2 and the local edge cache, retaining a key that
another live public repo references. Current branch/tag graphs remain reachable;
other history expires after 30 days and re-renders on demand. It also collects up to 100 abandoned push staging objects older than one hour. The suite covers
visibility flip, delete, a shared public hash, current tags and revisit after
expiry. Fragment links in rendered pages/router carry `repo` and `sha` context.

Old v1 entries created with a year-long TTL at other PoPs require an operator
global purge at rollout; Cache API deletion is local to the executing PoP.
The current visibility gate still denies those bytes immediately. New cached
copies expire within 60 seconds everywhere.

## Chosen cost limits

| Resource | Limit |
| --- | --- |
| Push request, including decompressed gzip body | 2 GiB |
| File / reconstructed delta result / Git object | 100 MiB |
| Repository storage budget | 5 GiB of unique objects, including history |
| Push rate | 300 attempts/principal/hour; agents have independent token identities |
| Pack objects / ref updates per push | 10,000 / 100 |
| Repository branches and tags | 500 |
| Highlight threshold | 128 KiB; larger files use escaped plain text |
| Cold historical render | 120/anonymous IP/repo/hour; 600/signed-in account/repo/hour |
| Unreachable fragments | 30 days |

Oversized packs are rejected before forwarding with a clear 413 message; rate
limits return 429 and Retry-After. The durable budget deduplicates by canonical Git object hash, including reconstructed deltas. Ambiguous upstream results refund reservations; indexed sizes seed subsequent reservations. R2 staging keeps the transfer and object validation streaming, with cleanup after every outcome. Legacy repositories seed from unique indexed blobs; accepted packs record exact commit, tree, blob and tag sizes.
Compiled-Worker tests reject both oversized normal and delta packs and reach
the account push rate limit. A normal real Git push also succeeds.

## Revocation contract

Cached fragment hits invoke the Worker once for the live D1 grant check and do no R2/DO/render work. There is no front-of-Worker Cache Rule: that would bypass immediate revocation. This is the intended final behavior, with no outstanding front-cache optimization.

## Verification and rollout

Run `node scripts/fast-reads-gates.mjs` for every command in the current API and
theme CI workflows. The pinned companion CLI is built from
`37e7d8ef1e6eed2a5aa03fb2cac5927762e71bf7`; `GILD_TEST_CLI_DIR` is a test-only
override so the lane does not modify another checkout. Run
`node scripts/fragments-local.mjs --baseline-reads` for the pinned old pipeline.
The static fragment/browser suite includes screenshot and behavioral revert
proofs. Final command outcomes are recorded in [gates.json](gates.json).

Ava applies migration 0016 before the new site Worker. Its retention sidecar preserves
the existing two-column `fragment_repos` INSERT contract for v1 producers.
Pre-existing repositories without heads are backfilled without a push. Retry alarms advance ready refs independently and cap backoff at one minute. Renderer-only version changes are detected by minute cron, refreshing up to
20 repository projections per run while preserving old published pointers.
Ava runs `scripts/purge-v1.mjs` after deploying the site and renderer to remove old global edge copies and remeasure the same live URL.

The site deploys from Workers Builds with `npx wrangler deploy`. Ava redeploys `gild-render` by hand: `npx wrangler deploy -c wrangler.render.jsonc`.
Do **not** make `scripts/deploy.mjs` the Workers Builds command: Builds renames
every `wrangler deploy` to `gild-site`, including the renderer deployment. The
script now documents this and rejects the Workers CI environment. No PR was merged and no deployment was performed for this work.

-codex
