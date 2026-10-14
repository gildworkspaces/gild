# Repository listing performance

Measured on local workerd with 15 Git repositories, actual D1/SQLite DOs,
OpenNext's complete HTML pages and a disposable local Artifacts transport.
Warm figures use ten requests. Times include the loopback HTTP round trip and
complete SSR, so they bound server time; they do not predict production network
latency. Baseline is #36 (`9d08414`). Ava verifies on gild.gg.

| Full HTML request | Before (ms) | After (ms) |
| --- | ---: | ---: |
| Owner first request, already indexed | 654 | 337 |
| Owner warm median / maximum | 285 / 421 | 48 / 61 |
| Landing first bucket scan | 561 | 357 |
| Landing warm median / maximum | 160 / 218 | 31 / 36 |
| Landing in a new isolate, shared minute bucket | 1,013 | 254 |
| First owner view during a post-push refresh | 2,264 | 72 |
| Owner after the new indexed tip is published | — | 49 |

The push check commits a new file in a real fixture repo and deliberately delays
its refresh by two seconds. The after page serves its last published summary,
then the test waits for the new commit timestamp to appear on the warm page.
This also checks the alarm's publication hook, not just the lookup adapter.

A separate counted workerd fixture renders the actual RepoList component. Warm
owner requests drop from **105 DO RPCs + 90 D1 statements to 0 + 4**; six-card
landing hydration drops from **42 + 36 to 0 + 4** for one owner. Counts include
the catalog settings filter, snapshots, stars and score queries; the fixture's
catalog is local. A restarted isolate performs **zero owner scans** on a bucket
hit. The micro fixture fixes its cache clock to avoid minute-boundary flakiness;
the complete-page fixture uses the real clock.

## Cache decision

- Compute code facts beside the SQLite index once per default-branch commit.
  Cache metadata counts/ACL once per `_meta` tip. Mirror the latest published
  snapshot to D1 under the stable entity ID; guard concurrent writes by revision.
- Read owner snapshots in one query, stars in one query and current per-commit
  score keys in one query. The catalog's live settings/alias/deletion filter is
  also one query. Private membership checks run in parallel; public cards need
  no viewer-specific reads.
- Keep landing candidates in shared `kept`/D1 under `landing:<minute>`. Hits
  hydrate only those six candidates and recheck live settings/ACL. Cron removes
  old minute buckets. HTML stays private/no-store for viewer-specific content.
- Never wait for listing readiness. During refresh, serve the last complete code
  facts and published counts. Successful metadata writes forward their committed
  ACL before responding, so access revocation takes effect during the refresh.
  A never-indexed repo is omitted until its ACL is known, with indexing scheduled
  in the background. A pre-existing index bootstraps with one parallel RPC.
- Default-branch changes republish the snapshot; renames retain stable IDs;
  purging an index removes its projection so recreations can start at revision 1.

## Reproduction and validation

`bun run test:repo-list:perf` runs the counted fixture with DO/D1 budgets and
private/outsider/owner/reader, metadata-only ACL, stale-revision and purge checks.
`node scripts/repo-list-local.mjs before` builds the #36 listing modules into
that same fixture. `bun run test:repo-list:perf:revert` temporarily restores the
production repoList to #36: the DO budget fails **105 != 0**, then source is
restored. All six existing listing revert cases also fail as expected.

After `bun run build:cloudflare`, `bun run test:repo-list:pages` measures the full
pages and asserts all three targets. For the before measurement, build with the
#36 repo-list/public-activity/artifacts modules, then run
`node scripts/repo-list-pages.mjs before`. Raw observations are in
[performance-timings.json](performance-timings.json).

Every CI command passed: frozen installs and CLI build, `bun run test` (186),
`bunx tsc --noEmit`, `test:api`, `test:events`, `test:sessions`,
`build:cloudflare`, `test:runners:local`, `test:theme`, plus the new performance
CI gate. `test:repo-list:local` passes the full browser/contract/private/star and
layout suite. One concurrent events attempt hit a local bind collision; its
isolated rerun passed. No CI polling, merge or deployment.

Apply `0013_repo_listing.sql` before deploying the new Worker. Applying this
additive table ahead of the Worker is compatible with the old listing path.

-codex
