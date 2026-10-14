# Public static reads

Public browsing reads published HTML or stitches stored fragments. Homepage,
explore, profiles/orgs, issues/PRs, agents, Actions, search and creation/import
shells are produced anonymously on writes/cron. Viewer controls use small live
islands. Private settings and account data retain live authorization. This
extends [static-at-commit](static-at-commit.md).

## Immutable inputs and assets

Fragment CSS, router, workers, fonts and SVGs have SHA-256 URLs of their delivered
bytes and `public, max-age=31536000, immutable`. The layout, shell, CSS font URLs
and renderer share one generated manifest; both fonts are preloaded. Shells hash
their complete HTML. Jobs retain assets in R2 for old shells after redeploy.
Next's build-addressed static graph is retained before HTML publication, including
old chunks requested from a cold PoP. The unversioned favicon uses one hour;
shells use its hashed URL.

Migration 0017 stores route pointers, immutable input-to-HTML artifacts and jobs.
Inputs cover the source/Next build, listing revisions, ACL/lifecycle/catalogue,
profiles, membership, agents and star counts. Actions/org runner summaries add
a minute snapshot bucket. Unchanged inputs reuse HTML without SSR. The producer
rechecks primary inputs after rendering; a racing write cannot publish under the
wrong input. Activity uses published commit tips, bypassing stale minute candidates.
Aggregate reads verify every repo dependency before serving old HTML.

## Authorization leases

The selected design is Cache API public pointer/visibility grants with an absolute
**1,000 ms** lease beginning before the primary D1 query. Slow fills, errors,
denials and private data never become shared grants. A successful write changes
the local cache generation before responding, fencing even fills in flight. An
evicted generation creates a new persisted UUID before primary lookup; it cannot
resurrect an earlier namespace.
Other PoPs may admit a new request under an old grant only until its deadline.
Expired grants require the primary and fail closed on error. Already downloaded
content cannot be recalled.

A read within a valid warm grant makes **0 DO / 0 D1 / 0 R2 / 0 render calls**.
An expired grant needs one primary renewal even if its HTML is still warm.
Commit presentation pointers are separately immutable under the published chrome/
ref input and commit; renewing authorization does not repeat their DO lookup.
The renderer cannot return a private-scoped commit pointer through this path.

| Option | Evaluation |
| --- | --- |
| D1 Sessions/read replicas | Still a network/binding call per read; a replica without a writer bookmark cannot establish the primary revocation bound. |
| KV | Documented cross-location propagation can take 60 seconds or more, incompatible with revocation/push freshness. |
| Cache API + short lease + local invalidation | Chosen: no origin during a valid grant, a fixed remote stale-admission bound and no replication setting. |

Sources: [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/),
[D1 Sessions](https://developers.cloudflare.com/d1/best-practices/read-replication/),
[KV propagation](https://developers.cloudflare.com/kv/api/write-key-value-pairs/).
Cache API invalidation is local; the lease provides the remote-PoP bound.

## Writes, islands and navigation

Normal Git receive-pack waits for the accepted index and stored presentation
before acknowledgement. The renderer publishes at most 50 plan items per call;
the writer follows all continuations to completion. Cached objects are checked
before syntax work, and full source bundles remain background queue jobs.
Rendering is idempotent, on the writer, alongside
durable queue retries. Pending heavy-language Score/history work retries
independently. Import runner pushes keep their background pipeline. After a
successful acknowledgement, remote old pointer grants expire within one second.
An indexing/render failure reports that refs were accepted but publication is
pending; it cannot claim successful publication or roll back accepted refs.

API writes produce the viewed page and new issue/PR/run/org before returning.
An input race during the first render is retried on the writer. Other finite
views and aggregate/feed snapshots update through the queue and minute cron;
their cadence is distinct from the Code push bound. Unprepared representations complete promptly with Pending. Browser documents return HTTP 200 with available chrome, `x-gild-state: pending`, a manual Check again action and private/no-store; artifact and pointer callbacks return HTTP 202 with `{ state: "pending", retryAfter: 3 }`. Missing artifacts enqueue durable producer work. No page request waits for rendering, Git refresh, parsing, scoring or diff computation, and Pending is never stored as a completed view.

Stored artifacts contain no personal identity, private repos or personal star/permission state. The Worker verifies the session and current policy before selecting account chrome and filling identity, stars and permissions from its shared authorized D1 batch. The initial HTML contains the signed-in account sidebar, including on Pending documents; it never sends an anonymous Sign In fallback for a signed-in viewer. Personalized responses are private/no-store while the underlying immutable artifacts remain shared. Scoped islands
restore comments, reviews, Settings, creation links, agent and import controls.
Anonymous islands use a public lease; credentials stay live.
Search has a stored shell and result artifacts keyed by the public ref/ACL graph
and query; partial/indexing results are never retained. Cold result computation
is an immutable cache miss and stays outside first paint.

Built API documentation and auth client shells are cached by Next build without
DO/D1 calls; challenge creation and polling remain live client APIs. Gzip R2
fragments are decoded before entering Cache API, which owns encoding on replay.
Code intent navigation fetches real HTML for public pages; RSC receives an
explicit hard-navigation response. Source workers wait for window load, two
frames and idle scheduling before downloading bundles. Incremental navigation
still downloads only changed blobs. [Validation](public-static-reads/validation.md)
contains browser measurements, the page audit, deterministic budgets and reverts.

## Pending and preparation

Code, Score, commit and channel source previews read stored HTML. Historical pointer reads enqueue hydration but never call renderer-version backfill. Diff and score misses schedule RepoIndex alarms; metadata pages inspect one ready snapshot without advertising Git refs or waiting for refresh. Actions workflow misses schedule RunQueue preparation, with completed workflows reused under the immutable commit key. Missing public page and landing-activity projections enqueue the public-page producer. Available landing or repository content remains visible while an unfinished section reports Pending.

The renderer presentation namespace advances to v4 so earlier Home fragments are rebuilt with account-control templates. This is an HTML presentation revision, independent of the CLI npm version. Old immutable artifacts retain their addresses.

Browser caches reject Pending callbacks/documents rather than retaining them as successful payloads. A Pending tab or source view stays in the current document with a manual retry; there is no automatic full-page refresh loop. Account controls mount independently of repository readiness. Actual errors retain their error state.

The fragment gate holds the real producer, checks prompt 202 callbacks and complete Pending HTML without renderer calls, releases it, and verifies the prepared artifact. Removing the request-side queue-only behavior fails this assertion. The full Worker browser gate blocks metadata preparation and verifies the complete document within 500 ms and usable account menus at desktop/mobile widths. The latency gate retains every sample and separately restarts workerd before each measured first page request; warmed budget results do not establish server-cold or deployed latency.

## Rollout (not executed)

Ava runs the reviewed rollout. Land #61 first with
`0017_public_pages.sql`; #62 adds `0018_orchestrators.sql`; #59 is renumbered
to `0019_import_internal_refs.sql` and lands third.
The Durable Object migration list preserves `repo-channel-v1` and ends with
the new `public-pages-v1` deployment checkpoint (no new DO class).

From the reviewed #61 checkout, outside Workers Builds:

```sh
bunx wrangler queues create gild-public-pages
bunx wrangler d1 migrations apply gildforge --remote --config wrangler.jsonc
bun run build:cloudflare
bunx wrangler deploy --config wrangler.render.jsonc
bunx opennextjs-cloudflare deploy
```

The queue consumer uses batch 1, timeout 1 second, three retries and concurrency
1. No new secret or D1 replication setting is needed. Queue and migration must
exist before the site upgrade; the renderer's `/publish` barrier must precede
Git acknowledgements from the upgraded site. Both manifests come from the real
build and generated output remains ignored. The Next asset manifest has a typed
module declaration so Next can typecheck before the build emits that JSON.

The existing cqx-heavy setup is unchanged. Workers Builds uses
`bun run build:cloudflare` then `bunx opennextjs-cloudflare deploy`; Ava separately
deploys `wrangler.render.jsonc`. Do not run the multi-Worker manual deploy script
under the site auto-name override.

Before directing traffic to the new version, allow cron/queue bootstrap and
verify prepared public routes. Initial bootstrap returns Pending while artifacts are prepared. Cold-PoP measurements below concern **already published** content.
Monitor queue backlog/failures and primary renewal latency. Retain prior assets
for rollback. After review/deployment, repeat SEA and other-PoP browser and revoke/
push probes: local workerd measurements do not establish production latency from
every PoP. No deployment, migration or production settings were changed here.

-codex
