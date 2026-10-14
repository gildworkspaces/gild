# Repository refresh race proof

Branch: `codex/repo-list`; PR #36. `origin/main` was already merged/current before this change.

`repoInfo` found the existing repository. The false missing decision was `mayRead`: `readyIndex` returned null while a metadata/index refresh was dirty, pending, active, or had different advertised tips. The shared ACL boundary interpreted that null as denial and the repository layout called `notFound()`. A completed index could also disagree with the 30-second advertisement memo. Immutable kept values were not the cause.

The product now waits up to five seconds for a complete current snapshot, without restarting an active refresh. A completed snapshot mismatch rechecks live refs so an older advertisement memo cannot fence it for 30 seconds. A longer refresh throws an availability error (API 503), never a missing result. Ref-list transport failures also report availability rather than missing. The current ACL is read after convergence; stale public ACLs are not served.

The runner suite has no repository 404/503 retry and no reload after a not-found page. Its shared browser regression stars the repository, edits its description and agent grants using real product routes, asserts that the grants write changes `_meta`, forces a production refresh, asserts readiness is false, and navigates immediately. It requires HTTP 200, absence of the not-found page, and rendered Actions. It also checks the repo Code page. This runs at 1400/400 widths in light/dark in every runner gate.

## Revert proof

Restored only `lib/repo-index.ts` from the pre-fix HEAD, rebuilt with `bun run build:cloudflare`, then ran `node scripts/repo-refresh-local.mjs`. The new test exited 1 at `verifyRepoRefresh` because the first page contained the heading “Nothing lives here” (actual count 1, expected 0). Next streamed HTTP 200 for that not-found page; the content assertion catches this. Restored the fix, rebuilt, and reran the same test successfully:

```text
Immediate _meta navigation (standalone): HTTP 200 in 964ms; repo code page HTTP 200 in 667ms
exit 0
```

## Every CI gate

`bun install --frozen-lockfile`: exit 0, checked 423 installs across 550 packages, no changes.

`bunx tsc --noEmit`: exit 0.

`bun run build:cloudflare`: exit 0, “OpenNext build complete.”

All six test gates ran sequentially, three complete consecutive rounds, with no source edits between rounds:

| Command | Round 1 | Round 2 | Round 3 |
| --- | --- | --- | --- |
| `bun run test` | exit 0 (6s) | exit 0 (6s) | exit 0 (6s) |
| `bun run test:api` | exit 0 (46s) | exit 0 (42s) | exit 0 (47s) |
| `bun run test:events` | exit 0 (43s) | exit 0 (42s) | exit 0 (42s) |
| `bun run test:sessions` | exit 0 (42s) | exit 0 (42s) | exit 0 (43s) |
| `bun run test:theme` | exit 0 (5s) | exit 0 (5s) | exit 0 (5s) |
| `bun run test:runners:local` | exit 0 (204s) | exit 0 (210s) | exit 0 (203s) |

Captured output (full per-command logs are in `/Volumes/Projects/codex/gild-site/.tmp/refresh-proof/round-*.log`):

```text
$ bun run test [round 1]
ℹ tests 184
ℹ pass 184
ℹ fail 0
exit 0

$ bun run test:api [round 1]
Events: all 19 contracts; signed real Queue retries; source emits, durable resume/SSE/long-poll, CLI, SSRF, auto-disable passed
Sessions: all four real contracts, redacted agent reports, open/closed, immutability, scope, browser overlay passed
API contract: 122 Phase A operations exercised through the production Worker fixture; coverage check passed
exit 0

$ bun run test:events [round 1]
ℹ tests 15
ℹ pass 15
ℹ fail 0
Events: all 19 contracts; signed real Queue retries; source emits, durable resume/SSE/long-poll, CLI, SSRF, auto-disable passed
Sessions: all four real contracts, redacted agent reports, open/closed, immutability, scope, browser overlay passed
API contract: 122 Phase A operations exercised through the production Worker fixture; coverage check passed
exit 0

$ bun run test:sessions [round 1]
ℹ tests 8
ℹ pass 8
ℹ fail 0
Events: all 19 contracts; signed real Queue retries; source emits, durable resume/SSE/long-poll, CLI, SSRF, auto-disable passed
Sessions: all four real contracts, redacted agent reports, open/closed, immutability, scope, browser overlay passed
API contract: 122 Phase A operations exercised through the production Worker fixture; coverage check passed
exit 0

$ bun run test:theme [round 1]
SSR hydration: light/dark, system with both OS palettes and live switch, default, first paint + all root mutations/frames, choice/persistence: 5 scenarios passed
exit 0

$ bun run test:runners:local [round 1]
Immediate _meta navigation (light 1400): HTTP 200 in 737ms; repo code page HTTP 200 in 598ms
Immediate _meta navigation (light 400): HTTP 200 in 627ms; repo code page HTTP 200 in 484ms
Immediate _meta navigation (dark 1400): HTTP 200 in 641ms; repo code page HTTP 200 in 619ms
Immediate _meta navigation (dark 400): HTTP 200 in 642ms; repo code page HTTP 200 in 480ms
    'corner clear on every page at every width'
exit 0

$ bun run test [round 2]
ℹ tests 184
ℹ pass 184
ℹ fail 0
exit 0

$ bun run test:api [round 2]
Events: all 19 contracts; signed real Queue retries; source emits, durable resume/SSE/long-poll, CLI, SSRF, auto-disable passed
Sessions: all four real contracts, redacted agent reports, open/closed, immutability, scope, browser overlay passed
API contract: 122 Phase A operations exercised through the production Worker fixture; coverage check passed
exit 0

$ bun run test:events [round 2]
ℹ tests 15
ℹ pass 15
ℹ fail 0
Events: all 19 contracts; signed real Queue retries; source emits, durable resume/SSE/long-poll, CLI, SSRF, auto-disable passed
Sessions: all four real contracts, redacted agent reports, open/closed, immutability, scope, browser overlay passed
API contract: 122 Phase A operations exercised through the production Worker fixture; coverage check passed
exit 0

$ bun run test:sessions [round 2]
ℹ tests 8
ℹ pass 8
ℹ fail 0
Events: all 19 contracts; signed real Queue retries; source emits, durable resume/SSE/long-poll, CLI, SSRF, auto-disable passed
Sessions: all four real contracts, redacted agent reports, open/closed, immutability, scope, browser overlay passed
API contract: 122 Phase A operations exercised through the production Worker fixture; coverage check passed
exit 0

$ bun run test:theme [round 2]
SSR hydration: light/dark, system with both OS palettes and live switch, default, first paint + all root mutations/frames, choice/persistence: 5 scenarios passed
exit 0

$ bun run test:runners:local [round 2]
Immediate _meta navigation (light 1400): HTTP 200 in 707ms; repo code page HTTP 200 in 615ms
Immediate _meta navigation (light 400): HTTP 200 in 651ms; repo code page HTTP 200 in 468ms
Immediate _meta navigation (dark 1400): HTTP 200 in 643ms; repo code page HTTP 200 in 633ms
Immediate _meta navigation (dark 400): HTTP 200 in 642ms; repo code page HTTP 200 in 461ms
    'corner clear on every page at every width'
exit 0

$ bun run test [round 3]
ℹ tests 184
ℹ pass 184
ℹ fail 0
exit 0

$ bun run test:api [round 3]
Events: all 19 contracts; signed real Queue retries; source emits, durable resume/SSE/long-poll, CLI, SSRF, auto-disable passed
Sessions: all four real contracts, redacted agent reports, open/closed, immutability, scope, browser overlay passed
API contract: 122 Phase A operations exercised through the production Worker fixture; coverage check passed
exit 0

$ bun run test:events [round 3]
ℹ tests 15
ℹ pass 15
ℹ fail 0
Events: all 19 contracts; signed real Queue retries; source emits, durable resume/SSE/long-poll, CLI, SSRF, auto-disable passed
Sessions: all four real contracts, redacted agent reports, open/closed, immutability, scope, browser overlay passed
API contract: 122 Phase A operations exercised through the production Worker fixture; coverage check passed
exit 0

$ bun run test:sessions [round 3]
ℹ tests 8
ℹ pass 8
ℹ fail 0
Events: all 19 contracts; signed real Queue retries; source emits, durable resume/SSE/long-poll, CLI, SSRF, auto-disable passed
Sessions: all four real contracts, redacted agent reports, open/closed, immutability, scope, browser overlay passed
API contract: 122 Phase A operations exercised through the production Worker fixture; coverage check passed
exit 0

$ bun run test:theme [round 3]
SSR hydration: light/dark, system with both OS palettes and live switch, default, first paint + all root mutations/frames, choice/persistence: 5 scenarios passed
exit 0

$ bun run test:runners:local [round 3]
Immediate _meta navigation (light 1400): HTTP 200 in 739ms; repo code page HTTP 200 in 571ms
Immediate _meta navigation (light 400): HTTP 200 in 633ms; repo code page HTTP 200 in 537ms
Immediate _meta navigation (dark 1400): HTTP 200 in 635ms; repo code page HTTP 200 in 568ms
Immediate _meta navigation (dark 400): HTTP 200 in 632ms; repo code page HTTP 200 in 472ms
    'corner clear on every page at every width'
exit 0
```

## Caching

No new cache is introduced. Hash-keyed immutable data remains in the existing SQLite/D1 caches; request caching still coalesces page reads. The only fresh git read is on a completed index/advertisement mismatch. Readiness polling reads the existing Durable Object status and never clones or parses on the request. The navigation timings above are local fixture measurements, including browser/HTML work, not production latency.

No deployment, PR merge, release, or CI polling.

-codex
