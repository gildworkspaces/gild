# Repository tab navigation

The fragment router owns the six repository root tabs: Code, Issues, Pulls,
Actions, Agents, and Score. Choosing the existing static router keeps the
published Code entry independent of Next's browser runtime and lets every tab
use the public HTML cache introduced in PR #61. Detail pages, forms, settings,
and agent object dialogs continue to use their existing authorized application.

On an uncached click, the router changes the URL and selected tab and inserts a
layout skeleton synchronously, before starting or awaiting the payload request.
Skeletons use the actual repository, Actions, channel, and Score CSS modules,
including their responsive breakpoints. The shared rail, header, and tabs stay
mounted. A minimum body extent keeps the footer out of the initial viewport;
scroll anchoring does not move the retained chrome during replacement.

Public tab documents are compiled at publication time, stored by immutable
content/source hashes, and served through the existing public-page edge cache
and grant lease. Completed React stream placements are resolved on publication;
Next scripts are removed, while explicit JSON island props remain. Public hits
do not render Next or parse streamed HTML. Signed-in public tab views render
their authorized viewer state in the document through the page's shared D1
batch. A private Next response is
converted only after its existing access checks; it is never added to the public
cache.

The browser caches at most 30 payloads and 8 million HTML characters. Initial
entry preloads tab CSS without downloading neighboring HTML. Hover and focus
warm the intended destination. After a completed tab navigation, bounded
warmup covers only the two adjacent tabs, with two concurrent payload requests
and at most twelve queued;
Save-Data and slow connections suppress speculative fetching. Failed speculative
URLs are attempted once per cache generation (at most 30 remembered attempts),
so local source browsing cannot trigger a publication retry storm. File/folder
intent and Code-to-Code browsing stay in the existing local source bundle.
The current Code body also answers its explicit current-ref URL, avoiding a
second fetch of the painted page. The completed build supplies the four Next
tabs' immutable CSS addresses in Code's shell.
Those two stylesheets start loading after first paint, before HTML discovery,
and payload-discovered styles also load in parallel. The standalone island
client is module-preloaded by both document types. No Next chunks or Flight
runtime need to load when leaving Code.

Back/forward reuses cached bodies synchronously and restores scroll per history
entry, including repeated visits to the same URL. Tip changes and private-state
clearing invalidate the tab cache and fence old in-flight fills and outgoing
snapshots. Sidebar sign-out uses the existing private-source clearing path. A Pending artifact leaves a Pending status and Check again action in the same document, with available chrome retained. It is not cached as a completed tab. Failed requests retain a separate error and Retry action. Actions, Agents, issue creation, private account controls,
and search reuse the existing React components through standalone adapters;
content islands unmount before body replacement. Current Agents documents
already contain their channel snapshot; tab prefetch uses those props without
requesting messages and participants again. Older cached documents fall back to
a document-local cache of two snapshots for 30 seconds. These authorized reads
stay out of public artifacts. The saved
cursor seeds the live connection so returning to Agents resumes new messages.
Private-state clearing aborts those reads and unmounts live content islands.
Mount-owned channel reads also abort on leaving Agents. The first empty
anonymous presence reuses the already authorized prefetched snapshot; signed-in
viewers and subsequent presence/state/access events still revalidate.

Signed-in Code and Score select a precompiled copy of the shared account shell
using the same viewer batch that authorized the request. Signed-in Agents uses
the portal layout too. Homepage, documentation and portal pages share an account
shell whose identity resolves before rendering, with no anonymous Sign In fallback.
Fragment responses fill the account name, avatar and star controls from the same
viewer batch before any browser code runs. Direct entry and tab transitions therefore retain a
working sidebar on all six tabs, including the mobile menu. The immutable
fragment artifacts remain shared; responses containing viewer state use
private/no-store. Standalone tab documents retain their inline viewer JSON,
and payload swaps carry it with the body so mounting the router does not add a
viewer fetch after the page load.

A standalone document carries an explicit `data-repo-router` flag. The shared
repository markup hook on a Next settings/detail page does not grant router
ownership; Next keeps its own roots there. Grant controls are disabled until
their handlers exist, preventing an early native form submission on a cold
settings entry. A different repository starts a new document/application.

## Reproduce

Build with `bun run build:cloudflare`, then run:

- `bun run test:nav:transitions`: all 30 directed pairs at 1400 and 400 pixels,
  plus all 12 already-selected tab clicks; actual payload requests held for
  800 ms, same-click selection/skeleton/URL,
  no document navigation, CLS below 0.01, offline history/scroll, prefetched
  content below 300 ms after explicit intent, interactive islands, and direct private entry.
- `bun run test:nav`: Claude's unchanged gate from PR #71, now blocking CI.
- `bun run test:nav:revert`: rebuilds the browser with the immutable pre-change
  router and requires the real same-click navigation assertion to fail; restores
  the current router and generated assets in `finally`. It also removes the
  source-intent guard and failed-prefetch bound separately, requiring each
  real source-browser effect assertion to fail. The anonymous-join mutation
  must add a real participants request after the prefetched snapshot.
  It also disables signed-in shell selection and requires the real Code
  sidebar assertion to fail, restoring the source in `finally`. Removing the
  standalone viewer provider must also fail the real New issue control assertion.
  Removing the server account shell must fail the initial HTML identity assertion
  before any client JavaScript runs.
- `bun run probe:nav:local`: repeats the copied live tab probe against the real
  compiled local worker with cold and prefetched browser caches.
- `bun run probe:nav -- avatest/mediatr https://gild.gg`: reruns the original
  production sequence. Add `--cold` to suppress prefetch, or `--warm` to wait
  for the standalone router's tab prefetches.

The deterministic suite writes per-hop timings, layout-shift measurements, and
1400/400-pixel screenshots to `.tmp/nav-review/`. Local timings establish the
router budget; they do not establish network latency from every Cloudflare PoP.
Production verification requires publishing fresh documents with this build's
source/asset hash before measuring the deployed worker. Existing stored PR #61
documents must not be mistaken for the new standalone publications.

## Local integration evidence, 11 October

The integration of #76 and #85 onto merged #91 exposed a viewer bootstrap loop,
lost viewer context when mounting standalone controls, missing account chrome
on Code/Score and the Agents layout exception. These are corrected in the
integration. Browser checks cover signed-in direct entries on all six public
and private tabs at 1400/400 px, opening and closing the account menu, creation
links, and owner workflow controls after a tab transition. Initial HTML checks
with JavaScript disabled cover homepage, docs, profile and all six repository
tabs; browser checks separately open and close account menus on desktop/mobile.

The transition matrix passed all 60 directed transitions at 1400/400 px with
maximum synchronous feedback of **2.5 ms**, **zero measured CLS**, and no document
navigations. Six explicitly prefetched bodies committed in **2.4–4.0 ms**.
[Raw transition measurements](evidence/integration-transitions.json),
[desktop account shell](evidence/integration-shell-public-code-1400.png), and
[phone account shell](evidence/integration-shell-private-agents-400.png) accompany
the regression proofs for the [sidebar](evidence/integration-revert-signed-in-shell.txt)
and [viewer controls](evidence/integration-revert-standalone-viewer.txt).

The initial full latency gate passed 14 page/viewer combinations, each cold and warm
using the median of three samples, with 25 ms added to every backend round trip.
Maximum settled time was **298 ms cold and 260 ms warm**, against the unchanged
600/300 ms budgets. Maximum best-sample document server time was **100 ms**,
against 150 ms. No page loaded viewer data through an API request. Automatic
tab fetches were bounded to two and did not refetch the painted page.

[Full measurements](evidence/integration-latency.md),
[raw samples](evidence/integration-latency.json), and
[the failing integration before the fixes](evidence/integration-latency-before.txt)
are local compiled-Worker results. They do not establish deployed performance.
Additional CI gates and production verification are recorded in the PR.

## Earlier local evidence, 9 October

The compiled production Worker fixture passed 60 delayed directed transitions
and 12 selected-tab clicks at 1400/400 px without document navigation. Maximum
same-click feedback was **2.2 ms**, maximum CLS was **0.000499**, and the six
prefetched bodies committed in **2.2–4.5 ms**. Offline Back/forward restored
Code at 640 px and Issues at its saved position. The same suite verifies CSS
warming while tab HTML is held, the two-request prefetch bound, pending-tip
invalidation, live Actions/Agents/Create controls, direct private entry, ref
retention when two branches share a SHA, and private-cache clearing after logout.
The revert run fails `code -> issues: selected synchronously` with the old router.

Claude's navigation gate measured:

| Hop | Reload | Feedback | Settled |
|---|---|---:|---:|
| code → issues | none | 52 | 80 |
| issues → pulls | none | 31 | 63 |
| pulls → actions | none | 25 | 52 |
| actions → agents | none | 17 | 44 |
| agents → code | none | 17 | 33 |
| code → issues | none | 24 | 51 |

Its public document TTFB medians were **6–7 ms** over 15 requests per tab;
published-page server work was **2–3 ms**. Authorized private document medians
were **65–119 ms**. Settled time includes authorized viewer/live-island requests;
the prefetched public tab body is the separate same-click measurement above.
These are local iMac measurements, not deployed PoP results.

The copied headless probe is preserved as [production before](evidence/production-before.txt)
and [local cold/warm after](evidence/local-after.txt). They use different servers
and repositories and are not a deployed before/after latency comparison. The
copied probe samples network activity in 300 ms increments; its settled values
are separate from the browser's synchronous feedback/body timings.

[Raw transition measurements](evidence/evidence.json) and screenshots:
[desktop skeleton](evidence/skeleton-1400.png),
[desktop content](evidence/content-1400.png),
[phone skeleton](evidence/skeleton-400.png),
[phone content](evidence/content-400.png).

-codex
