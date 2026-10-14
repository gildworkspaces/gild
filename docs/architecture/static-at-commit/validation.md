# Phase-one validation — 8 October 2026

This is local evidence from production Worker code running in workerd, with real SQLite RepoIndex, D1, Queue delivery, React/Shiki and gzip R2. Fixtures use an empty edge cache; the render job has already stored the commit's artifacts. Browser checks use installed Chrome. These measurements do not predict deployed Cloudflare latency.

## Latency and call budgets

| Flow | Before | After, local fixture | Work on read |
| --- | --- | --- | --- |
| Open file | Supplied gild.gg measurements: first 1.2–3.3 s, repeat 0.8–1.5 s | Cold fragment: 1 ms server | 1 R2, 0 DO, 0 D1, 0 render |
| Folder fragment | No supplied phase timing | Cold: 1 ms; warm edge: 1 ms | Cold 1 R2; warm 0 R2; both 0 DO/D1/render |
| Home/commit/Score/Glance fragments | No supplied phase timing | Cold: 1 ms each | 1 R2, 0 DO/D1/render each |
| Shareable repo/file URL | Old full repo render on each file click | 8 ms server, stitched first load | 3 parallel R2 reads; 0 render |
| 15-repo owner page | Supplied owner pages ~1–1.5 s total | Cold 99 ms; warm median 8 ms, maximum 41 ms | Batched listing projection; warm 0 DO, 4 D1 |
| 20 file opens after bundle | Full RSC navigations | 1.1–2.5 ms per swap | 0 network requests |
| Score click after intent | No supplied measurement | 1.7 ms swap | 0 new data requests |

Before measurements came from the brief and have no `Server-Timing` phase breakdown. No production deployment or post-change production measurement was performed. The cold-history/missing-artifact renderer intentionally computes once on a miss; the immutable hit budget tests the stored path.

The stitched request reports `index=4 ms`, `refs=0`, `snapshot=4 ms`, `file=0`, `score=0`, `render=0`, `total=8 ms`. Its fixture counts the site's shared read check as 1 DO and 2 D1 calls. The renderer's tiny pointer service makes one additional RepoIndex RPC, for 2 total DO calls across both Workers. Public immutable fragment routes bypass both entirely.

Machine-readable evidence: [timings](timings.json), [browser](browser.json), [owner](owner-timings.json), [deployment bundles](bundles.json). Budgets assert repo first load <300 ms, file <150 ms, folder <100 ms, cold 15-repo owner <300 ms, and <50 ms browser swaps.

## Gates

All commands from `.github/workflows/api.yml` and `theme.yml` were run locally:

- CLI and site `bun install --frozen-lockfile`; CLI `bun run build`; installed Chrome version check.
- `bun run test`: 207 tests passed; `bunx tsc --noEmit` passed.
- `bun run test:repo-list:perf`: batched listing/ACL/delete/recreate/scan/call budgets passed, including the cold owner budget.
- `bun run test:api`, `test:events`, `test:sessions`: each exercised all 122 Phase A API operations and passed contract coverage, real Queue/webhooks, CLI and receipt browser checks.
- `bun run build:cloudflare`: independent renderer and OpenNext build passed.
- `bun run test:fragments`: cold call counts, gzip/ETag/warm edge, actual Queue rendering, unchanged object reuse, fill-on-miss, accepted-tip/ACL fencing, forged-cookie rejection, private response headers, literal source preservation, native binary download bytes, local search/tree/20 opens, changed-blob-only delta, hover/saveData, Back, no-JS and signed-in corner checks passed.
- Renderer-only v2 swap passed with the site still compiled as v1; old v1 JS/font URLs remain readable. Restoring per-request repository lookup failed the cold public budget: [actual assertion](revert.txt), DO=1/D1=2 instead of zero.
- `bun run test:cqx:bundles`: main 6131.76 KiB gzip, heavy 1221.17 KiB, render 776.38 KiB, all below 10 MB. Renderer has no Next/OpenNext or scorer WASM.
- `bun run test:cqx:local`: real core/C/C# analyses and the service-outage, integrity, limit, partial-status, cache and recovery gates passed.
- `bun run test:runners:local`: runner workflows and the full site corner check passed.
- `bun run test:theme`: all five persisted/system/no-hydration-flash scenarios passed.

Logs remain in checkout `.tmp/static-*-final.log`, `.tmp/static-fragments-freeze.log`, `.tmp/static-repo-list-budget.log` and `.tmp/static-typecheck-freeze.log`. Tests' regenerated Actions evidence is restored; it is not part of this change.

## Visual review

The presentation reuses the existing gild file tree, typography, icons, layout, Health/Glance and sidebar components. Four reviewed captures cover 400/1400 px and both themes: [wide light](code-1400-light.png), [wide dark](code-1400-dark.png), [narrow light](code-400-light.png), [narrow dark](code-400-dark.png). Browser assertions also check signed-in corner clearance at 400/768/1400 px and no horizontal overflow.

Ava must provision Queue `gild-render`, verify the external RepoIndex/service bindings, and switch Workers Builds to `npm run deploy` at merge time. The bucket already exists. No PR merge, deploy, release or CI polling was performed here.

-codex
