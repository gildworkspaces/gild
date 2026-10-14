Public GitHub metadata reads use the importing machine's own authentication through the companion CLI change: https://github.com/gildforge/cli/pull/25. Automatic `GH_TOKEN` / `GITHUB_TOKEN` / `gh auth token --hostname github.com` discovery is separate from explicit `--source-token`; automatic credentials never enter gild requests, Git transport, job storage or snapshot headers. `--anonymous` disables discovery and destination privacy is unchanged.

The existing job checkpoint contract now acknowledges each completed issue/PR together with its next stage/page/item cursor and cumulative record count. The CLI preserves successful list pages beside its import Git directory with restricted filesystem permissions. Resume reuses those pages and skips completed item detail/comment/review requests. An unfinished item can replay deterministic writes. Losing that local snapshot requires rereading the current list page; the server cursor still skips completed items. Fresh mirror cycles start a new snapshot.

The shared source reader handles exhausted-budget 403/429 responses and `retry-after`. Resets up to fifteen minutes produce a visible countdown and abort-safe waits; longer or unknown resets stop with reset time and `gh auth login` / resume guidance. Heartbeats continue while waiting. The CLI's error detail retains the last three credential-masked Git stderr lines from `claude/import-git-error`.

Before Git upload, the CLI publishes the source default and its collision-free temporary PR namespace. Readers' branch lists and Git v0/v2 advertisements omit that namespace and gild's protected `_meta` ref. Before source code exists, a reader clones an empty repository; afterward HEAD selects the source default even during a failed import. The importer retains full ref discovery for verification. Source branches that collide with reserved names are preserved separately, including `_meta` as `source/_meta` (or a collision-free variant).

Receive-pack terminates an authenticated flush-only request locally with HTTP 200 and an empty Git result, avoiding upstream disconnects and staging. Native Git skips receive-pack for an ordinary up-to-date push; its large-upload authentication probe sends `0000`. The local Worker fixture uses native `git -c http.postBuffer=65520 push` with an incompressible 256 KiB file to exercise that probe, asserts the empty HTTP 200 on the wire, and checks the subsequent packed ref update. The raw flush-only request independently asserts HTTP 200 and zero decoded bytes. The native trace may use Content-Length: 0, or chunked framing with either a logged terminator or no data lines when Git/libcurl decodes that framing first. Unexpected trace payload still fails; the subsequent native packed ref update remains mandatory. Empty packs that create a ref at an existing object, and explicit unchanged-ref commands, use the normal successful upstream report. The CLI also skips a PR-head push when the destination already has that hash.

On finish, imported PR heads become immutable commit IDs. A metadata commit retains those IDs as additional parents before deleting the temporary refs, so their objects remain reachable for garbage collection and PR diffs. Advertised PR heads already exist upstream; sealing does not download their code into Worker memory. Failed cleanup can resume from the remaining refs, and no completed metadata needs refetching.

#61 (`0017_public_pages.sql`) and #62 (`0018_orchestrators.sql`) have landed and are applied in production; #59 incorporates both with merges and uses 0019 rather than colliding with #62 at 0018.

Migration required for the server deployment: `migrations/0019_import_internal_refs.sql`. The D1 import projection records the job's namespace; existing jobs default to `import/pr`, which is hidden only while the job owns refs (queued, running, mirroring or failed). Complete and cutover jobs never hide that prefix. No deployment, migration on a remote database, merge, tag or release is performed by these PRs.

Caching decision: the namespace and job status are small moving inputs read from their current durable projection; caching them without an updated key could reveal stale staging refs. Git reads the active namespace in its existing ACL SELECT, using the partial `repo_imports_internal` index. Per request this adds one indexed probe inside that SELECT and zero extra D1 statements or round trips; completed, cutover and non-import repositories have no entry in the active index. Other callers of `getRepoAccess(id)` do not request this projection. A live read makes completion effective immediately without cache invalidation. Existing code/render caches continue to use immutable commit/content keys. Finish is a durable metadata mutation, not a per-view computation. First/repeated local Git discovery measured 124/93 ms in the restored reversal fixture and 59.81/59.71 ms in the final merged-tree workflow run; both fixtures observe zero standalone namespace SELECTs. Status and repository-list timings are recorded in the local evidence.

Local proof commands:

```sh
# Companion CLI
cd /Volumes/Projects/codex/gild-cli-import
bun scripts/import-metadata-revert.mjs
# Server, with the companion checkout selected
cd /Volumes/Projects/codex/gild-site-import
GILD_TEST_CLI_DIR=/Volumes/Projects/codex/gild-cli-import node scripts/import-metadata-revert.mjs --review
# Also available: --worker runs the earlier cleanup/retention reversals too.
```

Each CLI reversal removes auth discovery, cursor acknowledgment, list snapshots, no-op skipping or masked stderr detail and fails its corresponding effect test. Server unit reversals remove rate handling, advertisement filtering, unrestricted v2 discovery, branch filtering, active-only visibility, the combined ACL projection or the migration renumbering. The live-schema upgrade and completed-job source branches fail when those fixes are reverted. The Worker query-cost reversal restores a standalone namespace SELECT and fails the ordinary discovery query-count assertion. Real Worker reversals remove flush-only handling (the native large-upload probe gets HTTP 500 and `git push` fails), cleanup (a remaining `import/pr/3` ref) or PR-head retention (failing native `merge-base --is-ancestor`). The restored Worker flow passes source counts, reader branch listings, empty pre-Git clones, mid-import and finished v0/v2 `master` clones, no temporary refs, and reachable sealed PR history.

The final merged-tree fixture imported 11 metadata records in 13.16 seconds; complete API/browser/native-Git verification took 69.96 seconds. The repository-list gate retained its existing budgets and asserts no warm repository-DO calls, four D1 calls, and no new-isolate scan.

Ava's reviewed rollout commands, from the #59 checkout after #61's queue/0017 rollout:

```sh
bunx wrangler d1 migrations apply gildforge --remote --config wrangler.jsonc
bun run build:cloudflare
bunx wrangler deploy --config wrangler.render.jsonc
bunx opennextjs-cloudflare deploy
```

This applies `0019_import_internal_refs.sql` after 0018, retains both real manifests,
and redeploys the renderer before the site. No deploy command was executed here.

Ava's post-deploy live check, using the updated CLI:

```sh
gh auth status --hostname github.com
gild repo import https://github.com/jonschlinkert/is-number --name avatest/is-number-4
gild repo import-status avatest/is-number-4
git clone https://gild.gg/avatest/is-number-4.git is-number-4
git -C is-number-4 symbolic-ref --short HEAD
# expected: master
git ls-remote --heads https://gild.gg/avatest/is-number-4.git 'refs/heads/import/*'
# expected: no output
```

If interrupted: `gild repo resume avatest/is-number-4`.

-codex
