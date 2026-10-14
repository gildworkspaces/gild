# Repository index and search

One `RepoIndex` SQLite Durable Object is addressed by `idFromName(owner/repo)`.
Git/Artifacts retains the push/clone protocol and canonical objects. Indexed
page reads and search use SQLite. No Artifacts credential was available in
this run; Ava owns the live preview and deployment.

## Storage and caching (§7c)

All repository SQL is in `lib/repo-index-store.ts`. Commits, tree entries, blob
metadata/text and symbols are immutable, keyed by their git object hashes.
FTS5 uses trigram tokenization when supported, with external content in
`blob_text` so text is stored once and hash lookup uses a primary key. Its
rowids narrow candidates without loading matching blob bodies merely to
retrieve hashes. The unicode61 fallback uses LIKE plus the full evaluator.

`tips` records every observed branch/tag tip, including a tip superseded while
backfilling. `files` flattens those trees and retains formerly advertised tips.
`refs.name` holds the canonical `refs/heads/…` or `refs/tags/…` as its primary
key. Historical Glance sizes traverse shared tree rows once and persist in
`summaries` under the root hash. Language mixes are persisted per root in
`language_mix`; `meta_roots` avoids re-parsing a known metadata snapshot. Forge JSON rows in `meta_files` are keyed by
`_meta` tip/path; the RPC returns issue/pull bodies, comments, reviews, logs,
queue, summaries and ACL files without clones.

Indexing persists object jobs and the active commit. Commits become known
only after all their objects finish; incremental traversal stops at known
commits. Each alarm handles at most 100 object jobs and one commit snapshot,
using a no-checkout shallow smart-HTTP fetch and a shared per-snapshot pack
cache. A large snapshot resumes from the object cursor. Completed ref sets
publish atomically after the queue drains. A revision counter preserves a
push arriving during ref discovery. Successful receive-pack responses schedule
refresh through waitUntil after the upstream response drains; merge and meta
writes also schedule alarms. Cold/behind readers use the prior git fallback.

Search never performs a clone or ref listing. Its AST evaluates bare/path
terms, phrases/escapes, boolean precedence, RE2 regexes, qualifiers and symbols
against the indexed tip. Matches return verified line/range snippets plus an
FTS `snippet()` preview. Count/facets cover all matches; pages return 20 files.
A bounded 32-entry DO cache keys results by advertised immutable tips, query,
scope and pagination. The public repo catalog is cached for a minute. Viewer
headers and moving search responses remain dynamic; the immutable data below
them stays in SQLite. Site-wide search covers the public owner/repo catalog,
with repo/org/user qualifiers applied before querying each index.

Code navigation, file text, languages, history/contributors, health input,
Glance sizes and issue/PR reads prefer the index. Commit/PR diffs remain the
existing immutable, cached git comparison. Repo descriptions and the public
repository catalog still use the Artifacts control-plane API.

## Local evidence

`npm test`: 46 passing tests, including real git fixtures, incremental row/read
counts, resumable object jobs, ref deletion, metadata, historical sizes, FTS
scope, pagination/facets and unicode61 fallback. Parser tests cover the requested
syntax, glob anchoring/cross-directory rules, precedence and exact fallback.
`npx tsc --noEmit` and `npm run build:cloudflare` pass on the locked Next 16.3.8
and OpenNext 1.20.8 dependencies.

`npm run test:revert`: both tests fail with the behavior removed, then pass
with the source restored: allowing `*` to cross `/` fails the glob assertion;
removing `root_tree` scope returns one result on the old tag where zero are
expected. Mutations and logs stay in `.tmp`, and restoration runs in `finally`.

`node scripts/index-local.mjs --large --heap` exercises the production alarm
and RPCs in local workerd, over a real local git smart-HTTP server. Synthetic
fixture: 94 commits, 16 MiB searchable text and 6 MiB random binary. The final
run backfilled in **54.7 s / 94 rounds**, with **189 git requests** (one tip
listing plus each shallow fetch's advertisement/pack exchange). First indexed
search: **49.3 ms**; repeated cached query: **2.2 ms**; **zero git requests**
from either search. Small fixture: **320 ms** backfill, **6.5 ms** first query,
**3.5 ms** repeat. JSON measurements are checked in beside this document.

Heap sampling at 50 ms intervals recorded maximum V8 heap 23,645,896 bytes
and buffer backing 86,634,878 bytes. Summing those separate sampled maxima is
105.2 MiB. Sampling does not account for all native SQLite/runtime allocations
or establish the exact production peak. The local run completed without
allocation failures. Production memory/CPU budgets require Ava's live preview.

Headless Chrome (`channel: 'chrome'`) passed shortcut, combobox focus, focus
trap/restore, scope removal, fuzzy file selection, full-results navigation,
line anchors/target highlighting and 400 px overflow checks. Screenshots use
the actual header/search/results/root-layout components in an isolated Next
fixture shell talking to the SQLite DO; the surrounding repo is fixture UI.
Deka's `website-ref/components/landing/Navbar.tsx` and Zega's
`rc-zegadb-site/src/components/site-header.tsx` informed the panel/keyboard
pattern. Colors and fonts come from gild; match marks are #f38020.


## Reproducing

All generated data lives inside this checkout's `.tmp`. No credentials needed. The built Worker was also started with `wrangler dev
--local --port 8810`; after applying the existing local D1 migrations, the real
`/api/search?q=sparse` returned HTTP 200 and the scoped cold-index API returned
HTTP 200 with `indexing: true` through the production Durable Object binding.

```sh
export TMPDIR="$PWD/.tmp"
mkdir -p "$TMPDIR"
chmod 700 "$TMPDIR"
npm test
npm run test:revert
npm run test:worker
node scripts/index-local.mjs --large --heap
```

For browser verification, run `node scripts/index-local.mjs --serve` in one
terminal, `node scripts/search-ui.mjs` then
`./node_modules/.bin/next dev .tmp/ui --port 8801` in a second, and
`npm run test:browser` in a third. Chrome must be installed. Stop only the
processes from these terminals. The fixture harness is never deployed.

## Remaining live verification

Needs Sami: ARTIFACTS_TOKEN on gild-site Worker preview environment. No secret
was copied or requested locally. Verify Artifacts allows the shallow immutable
OID fetch (local git supports it), then exercise a real push, merge and meta
write through the forge and measure production alarm/CPU/memory behavior.
External pushes bypassing gild's proxy need an Artifacts webhook/refresh hook;
the scoped brief covers pushes through the proxy and forge-side writes.
Symbol extraction is deliberately lightweight for TS/JS/Rust/Go, rather than
GitHub's Tree-sitter implementation. Backfill trades additional shallow-pack
transfers for bounded snapshot memory. A single snapshot substantially beyond
the tested 22 MiB envelope would need a different transfer strategy.

-codex
