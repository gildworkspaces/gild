# Static browsing validation — 9 Oct 2026

## Method and limits

The tables use headless Chrome via `playwright-core`, the production OpenNext Worker,
real local workerd DO/D1/R2 bindings and the renderer. Baseline is #57 (`a002046`);
fixtures and companion CLI are pinned. Cold means a fresh browser context and first
request for that URL, **not a globally purged edge**, and prepared content, not initial
publication. Warm is the subsequent navigation after source readiness; it can cross
the one-second authorization deadline. Binding counters are at the request boundary,
including renderer pointer-mediated DO access; nested actor internals are not enumerated.
Viewer API/islands and background queue calls are separate from document counts.

Deterministic injected-clock tests below are the authoritative valid-lease budgets.
Wall-clock values are evidence only. No deployment was performed: these local results
**do not establish <300 ms warm / <1 s cold at every production PoP**. Primary lease
renewals can exceed the warm target; initial publication and historical misses can
exceed the cold target. The 31 public examples in the main matrix had warm FCP 40–92 ms; the larger Lua file probe below is slower.

All public mutable HTML has browser `max-age=0, must-revalidate`; edge HTML is keyed
by immutable artifact input. Source assets have SHA-256 URLs and one-year immutable
headers. Existing Gild avatar/name corner components are reused, with live viewer
controls. Private dashboard/settings require current identity and authorization.

## Complete measured page table

TTFB milliseconds before → after; calls are after cold → warm **DO/D1/R2**.
Anonymous rows are stored HTML or immutable stitched fragments; viewer rows marked
live contain private identity, keys, membership, runner or write permissions.
A dash means this baseline representation was unavailable/unmeasured.

| Page / viewer | Cold TTFB before → after | Warm TTFB before → after | Calls cold → warm | Static or dynamic and why |
| --- | ---: | ---: | --- | --- |
| `/` | 716.9 → 186.9 | 39.8 → 5.9 | 0/1/1 → 0/0/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/explore` | — → 11.8 | — → 5.8 | 0/1/1 → 0/0/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/avatest` | 3906.7 → 12.5 | 1075 → 5.7 | 0/1/1 → 0/0/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/settingstest` | 212.8 → 12.4 | 146.8 → 5.5 | 0/1/1 → 0/0/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/settingstest?tab=people` | 88.2 → 10.5 | 73.6 → 6.5 | 0/1/1 → 0/0/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/settingstest?tab=repositories` | 79.6 → 10.6 | 115.4 → 6.4 | 0/1/1 → 0/0/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/settingstest/demo` | 14.1 → 13.7 | 8.5 → 6.3 | 0/1/3 → 0/0/0 | Stitched stored fragments, public pointer/access lease. |
| `/settingstest/demo/issues` | 258.9 → 11.7 | 140.7 → 6.5 | 0/1/1 → 0/0/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/settingstest/demo/issues/1` | 134.9 → 10.6 | 89.3 → 6.9 | 0/1/1 → 0/0/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/settingstest/demo/pulls` | 108.1 → 11.1 | 90.2 → 5.4 | 0/1/1 → 0/0/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/settingstest/demo/pulls/2` | 155.7 → 11.5 | 88.7 → 4.9 | 0/1/1 → 0/0/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/settingstest/demo/pulls/2?tab=files` | 104.3 → 11.4 | 93.9 → 6.6 | 0/1/1 → 0/0/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/settingstest/demo/pulls/2?tab=glance` | 132.5 → 10.6 | 97.6 → 7.6 | 0/1/1 → 0/0/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/settingstest/demo/agents` | 95.2 → 10.4 | 183.4 → 6.2 | 0/1/1 → 0/0/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/settingstest/demo/actions` | 120.3 → 10.2 | 144.7 → 5.3 | 0/1/1 → 0/0/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/settingstest/demo/actions/1` | 136.2 → 10.7 | 141.4 → 7.3 | 0/1/1 → 0/0/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/settingstest/demo/score` | 9 → 14.8 | 13.7 → 6.9 | 0/1/4 → 0/0/0 | Stitched stored fragments, public pointer/access lease. |
| `/settingstest/demo/health` | 23.4 → 7.7 | 7.9 → 5.2 | 0/0/0 → 0/0/0 | Edge redirect to stored Score. |
| `/settingstest/demo/commit/<sha>` | 152.5 → 30.8 | 519.9 → 15.9 | 1/0/4 → 0/1/0 | Stored commit fragments; access lease renews against primary. |
| `/search?q=fixture` | 201.4 → 10.7 | 144 → 5.9 | 0/1/1 → 0/0/0 | Stored shell; query results use immutable public-head/ACL graph. |
| `/settingstest/demo/search?q=fixture` | 141.4 → 10.8 | 147.2 → 5.1 | 0/1/1 → 0/0/0 | Stored shell; query results use immutable public-head/ACL graph. |
| `/new` | — → 11.4 | — → 41 | 0/1/1 → 0/0/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/new/org` | — → 10.7 | — → 5.8 | 0/1/1 → 0/0/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/import` | — → 7.9 | — → 9.1 | 0/0/1 → 0/1/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/settingstest/demo/import` | — → 10.5 | — → 6.3 | 0/1/1 → 0/0/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/settingstest/demo/issues/new` | — → 18.4 | — → 6.7 | 0/1/1 → 0/0/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/settingstest/demo/pulls/new` | — → 19.3 | — → 5.5 | 0/1/1 → 0/0/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/docs/api` | — → 174.8 | — → 3.8 | 0/0/0 → 0/0/0 | Built HTML retained at edge under Next build; client interaction stays live. |
| `/docs/api/sessions` | — → 68.2 | — → 4.4 | 0/0/0 → 0/0/0 | Built HTML retained at edge under Next build; client interaction stays live. |
| `/auth/device` | — → 76.9 | — → 16.2 | 0/0/0 → 0/0/0 | Built HTML retained at edge under Next build; client interaction stays live. |
| `/auth/claim` | — → 338 | — → 45.8 | 0/0/0 → 0/0/0 | Built HTML retained at edge under Next build; client interaction stays live. |
| `/dashboard (signed in)` | 616.4 → 262.1 | 77.3 → 171.4 | 0/14/0 → 0/14/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/settings/profile (signed in)` | 84.8 → 112.6 | 85 → 106.9 | 0/16/0 → 0/16/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/settings/tokens (signed in)` | 98.8 → 100.6 | 157.8 → 108.9 | 0/17/0 → 0/17/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/agents (signed in)` | 58.5 → 140.9 | 42.2 → 131.7 | 0/10/0 → 0/10/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/settings/keys (signed in)` | 60.9 → 108.7 | 266.5 → 42.3 | 0/16/0 → 0/16/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/settings/runners (signed in)` | 66.6 → 47.2 | 198.4 → 42.5 | 0/17/0 → 0/17/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/new (signed in)` | 48.3 → 10.8 | 90.1 → 6 | 0/1/0 → 0/0/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/new/org (signed in)` | 182.3 → 10.3 | 91 → 6.1 | 0/1/0 → 0/0/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/import (signed in)` | 42.4 → 7.5 | 130.4 → 9.4 | 0/0/0 → 0/1/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/settingstest/demo/issues/new (signed in)` | 129.8 → 11.5 | 145.9 → 5.7 | 0/1/0 → 0/0/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/settingstest/demo/pulls/new (signed in)` | 172.8 → 9.6 | 299.3 → 5.4 | 0/1/0 → 0/0/0 | Stored anonymous HTML from write/cron; live viewer controls after paint. |
| `/settingstest/demo/settings/general (signed in)` | 268.3 → 129.2 | 316.2 → 108.3 | 7/51/0 → 7/51/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/settingstest/demo/settings/webhooks (signed in)` | 245.2 → 198.8 | 257.4 → 96.1 | 6/51/0 → 6/51/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/orgs/settingstest/settings/general (signed in)` | 107.9 → 71 | 113.5 → 115.5 | 0/32/0 → 0/32/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/settings (signed in)` | — → 39.9 | — → 46.9 | 0/10/0 → 0/10/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/keys (signed in)` | — → 40.5 | — → 39.3 | 0/4/0 → 0/4/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/runners (signed in)` | — → 41.1 | — → 40.8 | 0/4/0 → 0/4/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/settings/organizations (signed in)` | — → 51.1 | — → 47.9 | 0/22/0 → 0/22/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/settings/agents (signed in)` | — → 68.7 | — → 41.3 | 0/17/0 → 0/17/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/settings/invitations (signed in)` | — → 41.3 | — → 41.1 | 0/16/0 → 0/16/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/settings/runner-groups (signed in)` | — → 53.3 | — → 69.6 | 0/21/0 → 0/21/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/settingstest/demo/settings (signed in)` | — → 154.8 | — → 139.3 | 6/41/0 → 6/41/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/settingstest/demo/settings/access (signed in)` | — → 113.8 | — → 111.8 | 6/54/0 → 6/54/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/settingstest/demo/settings/actions (signed in)` | — → 208.1 | — → 149.2 | 8/56/0 → 8/56/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/settingstest/demo/settings/runners (signed in)` | — → 108.9 | — → 95.3 | 6/51/0 → 6/51/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/orgs/settingstest/settings (signed in)` | — → 59.3 | — → 59.6 | 0/19/0 → 0/19/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/orgs/settingstest/settings/members (signed in)` | — → 72.3 | — → 206 | 0/37/0 → 0/37/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/orgs/settingstest/settings/webhooks (signed in)` | — → 63.4 | — → 56.7 | 0/29/0 → 0/29/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/orgs/settingstest/settings/runners (signed in)` | — → 62.7 | — → 56.2 | 0/30/0 → 0/30/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/orgs/settingstest/settings/runner-groups (signed in)` | — → 80.4 | — → 67.9 | 0/40/0 → 0/40/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |
| `/agents/approve/ae56915e9a7d41cca810 (signed in)` | — → 40.2 | — → 36.7 | 0/13/0 → 0/13/0 | Live: private account/settings/permissions; immutable repository data is reused below it. |

## Page-family coverage

Every `app/**/page.tsx` family has a measured example below. Parameters identify
fixture records; catch-all runner/group **list roots** are measured, not every
possible detail path. Calls are document **DO/D1/R2**, cold → warm. Mutable
public pages use stored anonymous HTML; private pages check live identity,
membership and permissions. Redirect timings include their destination.

| Page family | Example | Cold / warm TTFB (ms) | Calls cold → warm | Mode |
| --- | --- | ---: | --- | --- |
| `/auth/claim` | `/auth/claim` | 338 / 45.8 | 0/0/0 → 0/0/0 | Built anonymous HTML + live client APIs |
| `/auth/device` | `/auth/device` | 76.9 / 16.2 | 0/0/0 → 0/0/0 | Built anonymous HTML + live client APIs |
| `/docs/api` | `/docs/api` | 174.8 / 3.8 | 0/0/0 → 0/0/0 | Built anonymous HTML + live client APIs |
| `/docs/api/sessions` | `/docs/api/sessions` | 68.2 / 4.4 | 0/0/0 → 0/0/0 | Built anonymous HTML + live client APIs |
| `/` | `/` | 186.9 / 5.9 | 0/1/1 → 0/0/0 | Stored public HTML/fragments + live viewer island |
| `/[owner]/[repo]/import` | `/settingstest/demo/import` | 10.5 / 6.3 | 0/1/1 → 0/0/0 | Stored public HTML/fragments + live viewer island |
| `/[owner]/[repo]/actions/[run]` | `/settingstest/demo/actions/1` | 10.7 / 7.3 | 0/1/1 → 0/0/0 | Stored public HTML/fragments + live viewer island |
| `/[owner]/[repo]/actions` | `/settingstest/demo/actions` | 10.2 / 5.3 | 0/1/1 → 0/0/0 | Stored public HTML/fragments + live viewer island |
| `/[owner]/[repo]/agents` | `/settingstest/demo/agents` | 10.4 / 6.2 | 0/1/1 → 0/0/0 | Stored public HTML/fragments + live viewer island |
| `/[owner]/[repo]/commit/[sha]` | `/settingstest/demo/commit/22f5739f66a858409987b50bb32e15d93a79c7bb` | 30.8 / 15.9 | 1/0/4 → 0/1/0 | Stored public HTML/fragments + live viewer island |
| `/[owner]/[repo]/health` | `/settingstest/demo/health` | 7.7 / 5.2 | 0/0/0 → 0/0/0 | Edge alias to stored Score |
| `/[owner]/[repo]/issues/[number]` | `/settingstest/demo/issues/1` | 10.6 / 6.9 | 0/1/1 → 0/0/0 | Stored public HTML/fragments + live viewer island |
| `/[owner]/[repo]/issues/new` | `/settingstest/demo/issues/new` | 18.4 / 6.7 | 0/1/1 → 0/0/0 | Stored public HTML/fragments + live viewer island |
| `/[owner]/[repo]/issues` | `/settingstest/demo/issues` | 11.7 / 6.5 | 0/1/1 → 0/0/0 | Stored public HTML/fragments + live viewer island |
| `/[owner]/[repo]` | `/settingstest/demo` | 13.7 / 6.3 | 0/1/3 → 0/0/0 | Stored public HTML/fragments + live viewer island |
| `/[owner]/[repo]/pulls/[number]` | `/settingstest/demo/pulls/2` | 10.6 / 7.6 | 0/1/1 → 0/0/0 | Stored public HTML/fragments + live viewer island |
| `/[owner]/[repo]/pulls/new` | `/settingstest/demo/pulls/new` | 19.3 / 5.5 | 0/1/1 → 0/0/0 | Stored public HTML/fragments + live viewer island |
| `/[owner]/[repo]/pulls` | `/settingstest/demo/pulls` | 11.1 / 5.4 | 0/1/1 → 0/0/0 | Stored public HTML/fragments + live viewer island |
| `/[owner]/[repo]/score` | `/settingstest/demo/score` | 14.8 / 6.9 | 0/1/4 → 0/0/0 | Stored public HTML/fragments + live viewer island |
| `/[owner]/[repo]/search` | `/settingstest/demo/search` | 10.8 / 5.1 | 0/1/1 → 0/0/0 | Stored public HTML/fragments + live viewer island |
| `/[owner]/[repo]/settings/[section]` | `/settingstest/demo/settings/general` | 129.2 / 108.3 | 7/51/0 → 7/51/0 | Live authorized private data |
| `/[owner]/[repo]/settings` | `/settingstest/demo/settings` | 154.8 / 139.3 | 6/41/0 → 6/41/0 | Redirect to live authorized page |
| `/[owner]/[repo]/settings/runners/[[...runnerPath]]` | `/settingstest/demo/settings/runners` | 108.9 / 95.3 | 6/51/0 → 6/51/0 | Live authorized private data |
| `/[owner]/[repo]/settings/webhooks` | `/settingstest/demo/settings/webhooks` | 198.8 / 96.1 | 6/51/0 → 6/51/0 | Live authorized private data |
| `/[owner]` | `/avatest` | 12.5 / 5.7 | 0/1/1 → 0/0/0 | Stored public HTML/fragments + live viewer island |
| `/agents/approve/[id]` | `/agents/approve/ae56915e9a7d41cca810` | 40.2 / 36.7 | 0/13/0 → 0/13/0 | Live authorized private data |
| `/agents` | `/agents` | 140.9 / 131.7 | 0/10/0 → 0/10/0 | Live authorized private data |
| `/dashboard` | `/dashboard` | 262.1 / 171.4 | 0/14/0 → 0/14/0 | Live authorized private data |
| `/explore` | `/explore` | 11.8 / 5.8 | 0/1/1 → 0/0/0 | Stored public HTML/fragments + live viewer island |
| `/import` | `/import` | 7.9 / 9.1 | 0/0/1 → 0/1/0 | Stored public HTML/fragments + live viewer island |
| `/keys` | `/keys` | 40.5 / 39.3 | 0/4/0 → 0/4/0 | Redirect to live authorized page |
| `/new/org` | `/new/org` | 10.7 / 5.8 | 0/1/1 → 0/0/0 | Stored public HTML/fragments + live viewer island |
| `/new` | `/new` | 11.4 / 41 | 0/1/1 → 0/0/0 | Stored public HTML/fragments + live viewer island |
| `/orgs/[org]/settings/[section]` | `/orgs/settingstest/settings/general` | 71 / 115.5 | 0/32/0 → 0/32/0 | Live authorized private data |
| `/orgs/[org]/settings` | `/orgs/settingstest/settings` | 59.3 / 59.6 | 0/19/0 → 0/19/0 | Redirect to live authorized page |
| `/orgs/[org]/settings/runner-groups/[[...runnerPath]]` | `/orgs/settingstest/settings/runner-groups` | 80.4 / 67.9 | 0/40/0 → 0/40/0 | Live authorized private data |
| `/orgs/[org]/settings/runners/[[...runnerPath]]` | `/orgs/settingstest/settings/runners` | 62.7 / 56.2 | 0/30/0 → 0/30/0 | Live authorized private data |
| `/runners` | `/runners` | 41.1 / 40.8 | 0/4/0 → 0/4/0 | Redirect to live authorized page |
| `/search` | `/search` | 10.7 / 5.9 | 0/1/1 → 0/0/0 | Stored public HTML/fragments + live viewer island |
| `/settings/[section]` | `/settings/profile` | 112.6 / 106.9 | 0/16/0 → 0/16/0 | Live authorized private data |
| `/settings` | `/settings` | 39.9 / 46.9 | 0/10/0 → 0/10/0 | Redirect to live authorized page |
| `/settings/runner-groups/[[...runnerPath]]` | `/settings/runner-groups` | 53.3 / 69.6 | 0/21/0 → 0/21/0 | Live authorized private data |
| `/settings/runners/[[...runnerPath]]` | `/settings/runners` | 47.2 / 42.5 | 0/17/0 → 0/17/0 | Live authorized private data |

## Paint, load and bundle evidence

Same local fixture, baseline #57 → this branch. Each entry is cold / warm ms.

| Page | TTFB before → after | FCP before → after | Load before → after | Bundle ready before → after |
| --- | --- | --- | --- | --- |
| `/` | 716.9 / 39.8 → 186.9 / 5.9 | 1080 / 104 → 352 / 76 | 1162.7 / 107.2 → 469.4 / 29.8 | — / — → — / — |
| `/avatest` | 3906.7 / 1075 → 12.5 / 5.7 | 5076 / 1492 → 104 / 52 | 6296.7 / 1522.3 → 122.3 / 27.9 | — / — → — / — |
| `/settingstest` | 212.8 / 146.8 → 12.4 / 5.5 | 316 / 216 → 104 / 44 | 356.3 / 471.5 → 123.9 / 27.2 | — / — → — / — |
| `/settingstest/demo` | 14.1 / 8.5 → 13.7 / 6.3 | 132 / 48 → 108 / 40 | 129 / 32 → 79.9 / 27.9 | 788 / 50 → 148.3 / 56.8 |
| `/settingstest/demo/score` | 9 / 13.7 → 14.8 / 6.9 | 108 / 44 → 104 / 56 | 96.9 / 25 → 51.9 / 21.5 | — / — → 157.4 / 57.8 |
| `/docs/api` | — / — → 174.8 / 3.8 | — / — → 392 / 92 | — / — → 305.8 / 40.1 | — / — → — / — |


Raw browser evidence includes TTFB, FCP, load, bundle-ready, source errors, encoded
payload sizes and document binding counts. See [before](before-pages.json),
[after](after-pages.json), [real Lua before](before-lua.json),
[real Lua after](after-lua.json) and [live baseline](live-before.json).
The Lua fixture uses every tracked file and original executable mode, with its tree
hash checked against public `avatest/lua` commit
`f9d529178f03d5b93279da088bb905718c1aa0f7` (111 files).
Live baseline and local after are different environments; do not subtract them as
an apples-to-apples production improvement. The live homepage measured cold
TTFB/FCP/load 2125/2792/2546 ms; local after is in the full table/raw records.


### Complete Lua tree

Baseline #57 uses its index/queue producer. This branch first calls the same
publication barrier used by Git receive-pack; direct fixture seeding bypasses it.
Both trees retain all 111 tracked files, executable modes and the original tree
hash. Fixture commit metadata differs. Each entry is cold / warm milliseconds.

| Page | TTFB before → after | FCP before → after | Load before → after | Bundle ready before → after |
| --- | --- | --- | --- | --- |
| `/avatest/lua` | 181.8 / 6.7 → 281.9 / 23.3 | 300 / 60 → 452 / 72 | 274.8 / 33.9 → 388.4 / 52.5 | 4864 / 51.5 → 2070.2 / 85.1 |
| `/avatest/lua?ref=main&path=lvm.c` | 18 / 5.5 → 21.2 / 5.9 | 252 / 212 → 284 / 272 | 226.8 / 131.3 → 181 / 195.9 | — / — → 730.4 / 324.7 |

The bundle is still **1,025,066 encoded bytes**. Prepared cold root bundle-ready
was 2.07 s; it remains a background download after load, with source-backed warm
navigation reused locally. Baseline file probes hit the gzip/cache JSON decoding
bug and never became bundle-ready; this branch has no source-worker errors.

The [initial direct-seed run](after-lua-unprepared.json), which bypassed the writer
barrier, recorded a first-visit render miss, 5.06 s bundle-ready and **308 ms warm
file FCP**. It is retained rather than hidden. The writer-prepared rerun recorded
no document render calls and 272 ms warm file FCP. Root warm navigation renewed
its expired access lease (one D1 call); file warm navigation stayed inside its
lease (zero bindings). Wall-clock variation is not a CI gate.

The 111-file cold publication barrier itself took **[7,679 ms](lua-publication.json)** in local Wrangler.
That is producer preparation, not Git transport or document TTFB. The freshness
contract is at most one second of old-pointer admission **after successful
publication/acknowledgement**. Initial publication and full push duration do not
have a universal two-second bound. The observed small actual Git push below was
1.49 s to return plus 0.66 s to visible (2.15 s in total).

Reproduce with `node scripts/static-lua.mjs --source <public Lua checkout> --baseline <built #57 archive>` and again without `--baseline`, after building both trees. This is manual timing evidence, with no CI timing assertion.

## Deterministic budgets and freshness

- `bun run test:static`: 19 stored HTML routes plus two immutable search responses,
  and six Code/Score/commit/pointer/islands/manifest paths: a valid warm public lease
  makes **0 DO / 0 D1 / 0 R2 / 0 render** calls. [Page budgets](page-budgets.json),
  [fragment budgets](fragment-budgets.json). Commit access renewal makes one D1 call,
  no repeated renderer/DO lookup. Built documents avoid the server adapter warm.
- The same real-binding fixtures make access private on another synthetic PoP and
  prove denial at the absolute **1000 ms** deadline; local successful writes invalidate
  immediately. The producer rejects input races and owner deletion. Unit tests cover
  slow fills, primary failure, private scope, generation eviction and in-flight fills.
  Already downloaded responses cannot be recalled; the bound applies to admitting
  new requests, not canceling existing downloads.
- `bun run test:privacy:web` drives a real Git HTTP push and anonymous concurrent
  reads; [timing](push.json) records acknowledgement and return-to-visible separately: 1.49 s
  Git acknowledgement, 0.66 s after return,
  15 concurrent public reads and 0 public errors.
  `lib/push-presentation.test.ts` holds the accepted-index/publisher promises and
  proves ACK waits for them; every 50-item renderer batch must finish, including
  later-batch failures. The one-second remote pointer lease bounds stale admission
  after successful publication. A failed publication reports accepted refs/pending
  publication; it does not pretend the push was fully published.
- Public islands are leased and asynchronous; source Workers start only after load,
  two frames and idle scheduling. The browser test deliberately holds load open and
  asserts no Worker exists; 20 source-backed file opens then require zero network.
  The full bundle is still generated in the background and downloaded after load;
  no claim of directory splitting is made.

## Revert proofs and gates

`bun run test:static:revert` removes each fix independently and requires its
behavioral assertion to fail, then restores source in `finally`: asset URL hashes,
immutable headers, font preload, shell hash, read lease, commit pointer reuse,
search artifact cache/scope, form shells, stored pages, public islands, lease expiry,
load-event bundle deferral, immutable activity input, Git ACK and batch barriers,
transport-write filter, built HTML cache, cache-generation eviction fencing,
decoded cache response bodies, neutral signed-in public shells and empty reload history.
It rejects syntax failures as proof. The fragments suite also checks render wait,
push publication, plain fallback, projection readiness and renderer backfill reverts.

Both `.github/workflows/*.yml` were read and their commands run locally. Results
are in [gates.json](gates.json). `bun run build:cloudflare` generates real manifests
and both deployment outputs; `bun run test && bunx tsc --noEmit` verifies the final
source. No wall-clock performance threshold was added to CI.

See [architecture and rollout](../public-static-reads.md) for queue, migration and
renderer/site deployment requirements. No Cloudflare settings, migrations or
deployments were changed in production.

-codex
