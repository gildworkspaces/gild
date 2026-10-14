# Repository lists and stars

`repoList` is the authorized catalog shared by the org Repositories tab, org
Overview, user profile, dashboard, public landing page and browser catalog API.
`RepoList` renders the same rows everywhere, ordered by default-branch tip commit
time. The owner/admin New action remains; global search supplies discovery without
an additional filter or sorting toolbar. Existing gild tokens, themes, header and
rail stay in use. The sibling check covered zega.dev and cqx.bio (their account links carry return
URLs); cqx remains the
headline metric and links to the existing score page.

## Data and caching

| Data | Source and cache decision |
| --- | --- |
| Primary language | Existing indexed tree language totals |
| License | Root LICENSE/COPYING blob at the tip; common-license text matcher; unknown omitted |
| Updated | Tip committer timestamp, falling back to author timestamp; relative text and UTC hover |
| Activity | Indexed REST history reachable from the default-branch tip; UTC Monday buckets |
| Open issues / PRs | Existing live metadata index |
| cqx | Existing score cache for the tip and current analyzer version; omitted until scored |
| Stars | Live D1 count under the repository's stable entity id |
| Visibility / archived | Shared read boundary, live ACL and settings state |

Language, license, tip timestamp and absolute weekly commit aggregates are stored
under `repo-list:v1:<stable-repo-id>:<tip-hash>` in the existing gzipped D1 cache,
with per-isolate memory and concurrent-miss coalescing. No clone is performed by
this catalog. All paged history is read once per tip after the index completes its
history backfill; an incomplete summary is retried rather than cached. The rolling
52-week window is derived from absolute weeks on each read, so an unchanged repo
can age to a flat line. Each bucket includes its full calendar week, including the
current partial week. Summary caches cross viewers; authorization is checked
before returning rows. Viewer pages and the browser catalog are no-store; mutable
stars, metadata counts and score availability never enter the immutable summary.

The anonymous landing page coalesces catalog ranking and commit candidates in a
60-second isolate memo. Repeat hits hydrate only the selected six repositories,
so ACL/deletion changes and star/issue/PR counts remain live. Cached commits are
filtered against those authorized rows. Expiry refills the six candidates; a
failed scan is retried. The candidate snapshot is mutable and expires; immutable
facts remain in the shared per-tip D1 cache rather than being recomputed.

`summary()` currently re-pages the full reachable history for each new tip. This
is acceptable now; incremental aggregation is a follow-up if large repositories
become slow.

## Stars API

- `PUT /api/v1/user/starred/{owner}/{repo}`: authenticated, idempotent, 204.
- `DELETE /api/v1/user/starred/{owner}/{repo}`: authenticated, idempotent, 204.
- `GET /api/v1/repos/{owner}/{repo}/stargazers`: paginated users, no-store.
- Repository payloads, including embedded PR/search repositories, carry a live
  `stargazers_count`.

The catalog existence check and shared read check apply before stars are read or changed.
A nonexistent repository returns 404 before inserting any star row. Private repos are
404 for outsiders. Cookie writes use the existing CSRF-protected adapter. Counts
on the repo page refresh from the server after a toggle, including concurrent
stars by another viewer. Anonymous visitors see the count and a “Sign in to star” link. The existing
device sign-in now honors a local `next` path, preserving the page and query.
Stable ids preserve stars across renames and mixed-case repository names.

Migration `0012_stars.sql` is prepared and exercised locally. It must be applied
by the release operator before deploying these readers. No remote migration or
deployment is part of this work.

## Reproduction and evidence

```sh
bun run test
bunx tsc --noEmit
bun run test:api
bun run test:events
bun run test:sessions
bun run test:theme
bun run test:runners:local
bun run test:repo-list
bun run build:cloudflare
bun run test:repo-list:local
bun run test:repo-list:revert
```

The full-app fixture runs the built OpenNext app in local workerd with real local
D1, Durable Objects, Git repositories and index history. Only the external
Artifacts transport is redirected to a disposable local Git server. It creates
a ten-repo org with ky, chi, Alamofire, jsoup, requests and serde plus the existing
fixture repos; avatest/ky is also exercised on the user page. These are local Git
fixtures named after the demo examples, not mirrors of those upstream projects.
Counts and graphs come from fixture commits and persisted data, not UI constants.
The inactive tools repo has a 2024 tip and a zero-activity line; ky has sparse dated
commits, a computed cqx report and a persisted star. Alamofire is archived through
the real API before screenshots.

The fixture measures complete HTML for the first ten-repo view with empty summary
cache and a fully populated index, then a cached view. It asserts no-store on
both, all ten summaries on the first view, and records milliseconds in
[evidence.json](evidence.json). The recorded run was **624.8 ms first view / 441.1 ms cached**. This isolates
summary computation from asynchronous Git index backfill; it is a local sample, not a production latency claim.

The anonymous landing page measured **504.0 ms first scan / 156.1 ms memo hit**
for complete HTML; both responses remained no-store. Immutable summaries were
already warm from the org-page check, isolating selection reuse. `landingTimes`
in the same evidence file records these samples. The browser verifies cookie
PUT/DELETE CSRF refusal with unchanged counts, signed-out star count/link and
sign-in return including query, and singular/plural issue/PR copy from persisted
fixture metadata.

| View | 1400 light | 1400 dark | 400 light | 400 dark |
| --- | --- | --- | --- | --- |
| Org Repositories | [PNG](screenshots/org-1400-light.png) | [PNG](screenshots/org-1400-dark.png) | [PNG](screenshots/org-400-light.png) | [PNG](screenshots/org-400-dark.png) |
| Repo star button | [PNG](screenshots/repo-1400-light.png) | [PNG](screenshots/repo-1400-dark.png) | [PNG](screenshots/repo-400-light.png) | [PNG](screenshots/repo-400-dark.png) |

Screenshots cover org Repositories and the repo star button in light/dark at
1400/400 pixels. The browser also checks Overview, user and dashboard rows, absence
of list controls, latest-tip ordering, private access,
D1 persistence, anonymous refusal, idempotency and concurrent count updates. The
canonical corner checker covers 43 routes at 1400/1100/400 pixels. Revert proof
removes repository existence validation, landing memo reuse, license detection,
activity bucketing, D1 star persistence and private read enforcement separately; each mutation must fail its behavior assertion.

Async page content has an explicit root Suspense boundary. Without it, the local
streamed app repeatedly logged React #418 and discarded the root theme attribute
on navigation with cached scripts. The observed failure resembles the upstream
[streaming hydration race report](https://github.com/react/react/issues/37321);
that cause remains an inference. The browser test verifies the actual theme
attribute after navigation. Streaming private not-found pages can return HTTP 200
with noindex; the fixture checks denied content and noindex, while REST responses
remain 404.

-codex
