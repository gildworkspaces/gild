# Prepared issue and pull reads

The existing seven canonical GET operations (`issues`, `pulls`, `issue`, `pull`, `issueComments`, `pullComments`, `pullReviews`) now use the shared primary-D1 conversation reader in production and the Worker fixture. Current account/repository/agent policy precedes readiness and bytes. GETs do not acquire a repository index, observe Git or Artifacts, scan metadata files, publish a receipt or enqueue work.

RepoIndex prepares after render work has published strict current refs. It captures the immutable `_meta` files, resolves actual pull heads/bases, observes repository facts and stages at most 100 total thread/comment/review rows per alarm. A final primary-D1 transaction certifies the complete inventory and each thread's full children. Incomplete source files, missing resolved refs or mismatched counts stay Pending. Mutations, metadata CAS, writer authorization, channels, websockets and live event providers remain with their existing services.

Receipts match current epoch, metadata and the exact captured prepared-ref payload. Existing refresh/push epoch fences remain; additive migration0032 also denies stale receipts after an independently changed same-epoch ref payload. Unknown required repository creation/update dates leave pull DTOs Pending rather than fabricating epoch dates. A certified missing issue/pull returns404; uncertified inventory returns typed `503 PREPARATION_PENDING` with the existing retry contract.

## Local evidence

- 31 affected native tests pass; scoped TypeScript passes. Registered dispatch uses the actual service with legacy index/catalog/store ports forbidden. Current ACL/agent/lifecycle/allowlist checks and bounded list/child queries are retained.
- `node scripts/api-local.mjs --prepared-conversations`: actual background producer stages 131 threads, 106 comments and one review in three actual calls, with 100/100/38 row deltas. Seven compiled Worker GETs preserve second inventory/reply pages, actual inline/review fields and pull head SHA. Unknown404 and typed Pending are distinct; GET Git-request count is zero.
- Removing the background producer fails the unchanged 30-call completion bound; restoring it passes. Removing the exact-ref reader guard fails the same-epoch stale-receipt test; restored guard/unknown-date/actual-dispatch tests pass.
- `node scripts/api-local.mjs --channel`: first restored writer, API channel assertions, two-client browser behavior and private revocation pass after conversation integration.

## Remaining work

This group adds seven locally implemented prepared operations to the prior 14, for 21. It does not complete normalized chat/execution activity, rich DTOs, all remaining repository/search/summary/workflow reads, SSR consumers or whole-site acceptance. The current canonical DTOs omit native claim/log/queue and execution/audience provenance; no fields or authority are invented here. The SSR adapter still requires consumer wiring and actual cookie/browser validation. Real returned CLI results, independent private audiences and the required host/guest video rehearsals remain separate open acceptance work. No merge, deployment, release or live runtime action is part of this source batch.
