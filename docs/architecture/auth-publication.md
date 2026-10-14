# Authentication writes do not change public presentation

Audit finding 5 identified login challenge, answer and signout POSTs as unknown public mutations. The Worker consequently invalidated public read generations and scheduled public-page bookkeeping across the forge despite no public content change.

`publicMutation` now excludes precisely POST `/api/auth/challenge`, `/api/auth/answer` and `/api/auth/signout` (including their trailing-slash aliases). This is a small ingress decision before the existing Worker invalidation/publication block. No new cache, repository scan or foreground preparation is introduced.

The whole auth namespace is not exempt. Other methods, unknown writes and genuine changes—including completed account claims, agent requests, profile edits, ACL changes, repository content and Git receive-pack—retain conservative invalidation. Existing runner/import/token transport classification remains unchanged.

Tests cover exact known paths, query/trailing-slash forms, methods and near-match routes, alongside the existing public-content/ACL cases and actual edge-generation cache invalidation/racing fills. Reproduce `node --test lib/public-mutation.test.ts lib/public-edge.test.ts` and `node scripts/auth-publication-revert.mjs`; removing the exclusion fails the auth assertion, then restored source passes. These are classifier/cache tests; complete Worker/browser publication and cold-latency validation remain required on the combined audit/speed integration. Production latency/cost savings have not been measured.
