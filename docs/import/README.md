# Repository import

`gild repo import <url> [--name [owner/]<name>] [--private] [--mirror]` performs the first transfer locally. `/import` creates the same durable job for an eligible user/org runner. The page accepts a URL, destination owner/name, visibility, mirror mode and optional source token. GitHub and GitLab have complete metadata adapters; other forges have Git-only import, without placeholder metadata adapters.

## Transport and durability

The Worker never clones code packs. Native Git fetches every head/tag and full reachable history to a mode-0700 disk mirror, pushes in ref batches through Gild's smart HTTP proxy, then verifies destination object IDs. Receive-pack reads only its bounded command header (1 MiB maximum) before authorization and forwards the remaining pack with backpressure. An import capability can change code branches/tags only; `_meta` remains forge-managed. Imports initialize only `_meta`, avoiding a synthetic `main` tied to the backend's physical HEAD. The proxy advertises the selected source default branch. A source `_meta` branch is preserved under a unique `import/source/_meta` name.

A `RepoImport` Durable Object retains state, page/item checkpoint, progress, capability hash and warnings. Claim is exclusive; the 120-second lease renews every 30 seconds. A lost lease revokes the old capability and requeues the checkpoint. A valid exact-job capability remains available while its own metadata ACL fence is pending; ordinary reader/runner credentials stay fenced. Source item IDs and filenames are deterministic; a committed batch whose checkpoint was lost can replay without duplicate comments/reviews or another unchanged metadata commit. Normal batches are at most 40 records and 192 KiB. Large GitLab bodies and missing-head patches use bounded chunks. Writes use the existing `_meta` writer, index builder, ACL fence and repository lifecycle lease. Bulk writes publish the ACL on every batch but defer SQLite/render projection until completion. Imported pushes do not expand old commits into new push activity, and historical metadata does not emit fresh Gild activity. Import batches stage only modified metadata files. The proxy's write lease renews while long transfers drain. Accepted import pushes are indexed at completion and never trigger source workflows.

Source credentials are encrypted with the existing Actions AES-256-GCM mechanism and authenticated to the repository. They exist only while pending/running for a one-shot import and are destroyed on finish/failure. Mirror mode retains the encrypted credential until cutover; archive/delete also revoke it. Claim responses and scoped credentials are excluded from API idempotency storage. Credentials never enter Git remote config, process arguments, summaries or workflow environments. Source URLs reject embedded credentials, local destinations and unsafe Git protocols. Native Git validates and pins public DNS answers and refuses redirects. SSH uses the machine’s SSH authentication; a separate source token authorizes HTTPS metadata reads and never enters Git’s SSH configuration.

**Needs Sami: ACTIONS_SECRET_KEY on gild-site/Worker** if it is not already configured for Actions. It is required only for source-token imports. No credential is supplied or transferred by this PR.

## Metadata and mirror behavior

GitHub imports all issues/PRs, discussion and inline comments, submitted reviews, label definitions and milestone labels through REST. GitLab imports issues/MRs, notes, inline discussions and approval/change-request system notes. Draft GitHub reviews remain private at the source. Original authors/timestamps/state/provenance are stored explicitly; displayed names say `imported from @user on GitHub/GitLab`, and historical reviews cannot approve or block a Gild merge. GitHub numbers stay unchanged; GitLab issue/MR numbers map to odd/even Gild numbers. Same-repository issue/PR links, including canonical links after a project rename, are rewritten to those destination numbers. REST redirects are bounded and may only remain on the same forge API origin. Original source head/ref/commit provenance is retained. Available PR heads are fetched to a free `import/pr/<number>` namespace (suffixing the prefix if a source branch occupies it); unavailable heads become closed PRs with downloadable source patches. If GitLab omits an oversized patch, the job fails visibly rather than storing a truncated patch.

Hourly DO alarms queue another source sync, with a five-minute retry alarm after a failed mirror. An eligible owner runner executes it; existing group visibility/public-repo rules still apply. The source remains authoritative for imported items/code refs until cutover. Native Gild metadata and missing source records are retained; there is no destructive metadata deletion sweep. Cutover destroys the credential, stops alarms and writes a read-only source reference to `_meta`. A failed private one-shot import needs the source token again when resumed, in the UI or CLI.

Workflow warnings use the parser and the **same input support contract** as runner execution, matching [the Actions support table](../actions/README.md). Git LFS objects, wikis, release assets and source-specific automation secrets are separate services and are outside this Git/issue import.

## Caching and validation

Import status, claims, progress and runner eligibility are mutable/per-viewer data and use `no-store`; source credentials cannot be cached. Repository pages read the import note from the existing immutable `_meta`-commit projection. Git blobs/trees and rendered fragments keep their existing hash-keyed caches. Source REST pages stream page-by-page on the machine, and durable checkpoints avoid successful earlier items after an interruption. Workflow scanning occurs once per sync, rather than per page view. Local first/repeated summary API timings are recorded by the integration harness; they measure local workerd, not production latency.

The UI follows the existing Gild creation form and sibling Zega dashboard forms. Screenshots cover 400/1400 px and light/dark. Browser checks create a private import through the real form, show queued/running/cutover state, recover polling after a temporary failure, download a private missing-head patch with the browser session, check attribution and reject overflow. The progress route reads the published ACL directly and remains available while indexing is pending; management buttons are restricted to repository owners/org admins.

```sh
bun run test:import          # compiled OpenNext + real workerd/D1/DO/Git, disposable source REST fixture
bun run test:import:revert   # remove metadata writes, credential cleanup, streaming, lease-fence access and API redirects; each assertion fails
node scripts/import-revert.mjs --progress-page # also rebuild/revert the page and prove paused-index failure
bun run test:import:public   # read real public sources with existing gh auth; only local destination writes
node scripts/import-resume.mjs .tmp/<preserved-public-fixture> # continue a stopped large proof
```

Public evidence uses `jonschlinkert/is-number` and `ivmai/bdwgc`. The harness compares actual `_meta` issue/PR/comment/review counts against fetched source REST pages, checks every source ref through the native importer, replays a stored item without a new commit, and cuts over. Existing `gh api` authentication makes source reads without extracting/copying its token. Public REST responses are cached as the test snapshot for reruns; the evidence reports live requests/cache hits. A 500-request reserve prevents exhausting the shared GitHub API budget. Native/Bun peak RSS comes from process resource usage plus `/usr/bin/time`; workerd RSS is read from the test process descendants with `ps` (no debugger/profiler). Workerd RSS includes runtime/indexer/render overhead and is not JavaScript heap usage. The separate 128 MiB lazy-stream test proves packs are not prebuffered.

The completed public proof preserved:

| Source | Commits / branches / tags | Issues / PRs | Comments / reviews / labels | Import time | Client peak RSS |
| --- | --- | --- | --- | --- | --- |
| is-number | 62 / 1 / 11 | 21 / 23 | 111 / 17 / 7 | 31.4 s | 95.4 MiB |
| bdwgc | 11,469 / 6 / 144 | 617 / 362 | 4,849 / 214 / 3 | 47.6 min | 152.0 MiB |

The small run read 117 cached public REST responses plus one live request; the mid run read 571 cached responses plus 1,559 live requests through `gh api`. The source snapshot includes two PRs added since the earlier inventory. Git data came from the live public remotes, and all metadata counts were checked against the actual local `_meta` files. Workerd peak aggregate host RSS was 704.2 MiB for the small run and 1,870.3 MiB across the shared small/mid fixture. These process totals include multiple runtime isolates, indexing/rendering and native caches; they do **not** establish a per-isolate 128 MiB heap bound. The 128 MiB streaming test separately drains a complete pack while proving it is not buffered before authorization. Status first/repeated timings were 59.2/66.5 ms (small) and 92.8/50.4 ms (mid); these mutable reads deliberately remain uncached.

Earlier large-fixture attempts exposed redundant historical push expansion and code-tag following during metadata clones. Imports now suppress fresh activity/backfill, defer projections to completion, and disable automatic code-tag following for `_meta` reads/writes. The final proof uses fresh destinations; earlier checkpoint recovery and deterministic item replay are separate regression evidence.

## Review/deployment handoff

Apply D1 migration `0015_repo_imports.sql` and the `repo-import-v1` Durable Object migration with `REPO_IMPORT`. Deploy the site and companion CLI together, then run a user/org owner machine for web and periodic sync. No deployment, merge, release, tag or remote repository import was performed in this lane.

-codex
