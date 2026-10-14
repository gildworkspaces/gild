# Prepared repository content reads

The existing canonical `contentsRoot`, `contents`, `tree` and `blob` operations now use the shared D1 read service in both production and the local Worker fixture. They authorize against current primary repository policy before reading an immutable receipt. No ordinary GET acquires an index, observes Artifacts, walks Git, hydrates an object, publishes data or enqueues preparation. Missing preparation returns `503 PREPARATION_PENDING` with `Retry-After: 1`; a complete snapshot proves an absent path with404. Current private access uses no-store, including exact-SHA reads.

The existing RepoIndex alarm owns preparation. It rotates through advertised immutable tips, requests missing commit/raw-tree hydration in the background and publishes at most64 blobs and one snapshot per invocation. Full tree inventories and real decoded blob sizes come from the existing indexed source. Immutable receipts publish after bounded batches; interrupted publication cannot certify an incomplete snapshot. Older ready indexes that lack raw bytes are hydrated proactively, without a GET repair path.

A separate background change cursor now covers all refs and pulls in pages of at most100 inputs. A full diff queue retains the unsubmitted frontier. Pull-head catalogue publication uses bounded100-row D1 batches and certifies only the captured epoch after every chunk finishes.

The test transport records actual disposable Git namespace inventories, including repository creation. It no longer aliases the same demo inventory for every namespace. This is test-only transport wiring; production routing and credentials are unchanged.

## Evidence

- `node --test lib/prepared-repository-content.test.ts lib/prepared-read-models.test.ts`:31 pass. Registered dispatch uses the actual service while legacy index/catalog/store ports and GET network/write paths are forbidden.
- `node scripts/api-local.mjs --prepared-content`: actual alarm producer and compiled Worker GETs preserve README and binary bytes, tree/blob schemas, absent404, typed Pending and zero Git reads during GET. Evicting legacy raw bytes gives fast Pending; four actual background producer calls restore the binary file. Removing the alarm producer fails the unchanged30-call completion check; restoring it passes.
- `node scripts/api-local.mjs --prepared-pagination`:209 refs/1,101 pulls completed in17 actual producer calls. The100-job full-queue probe preserves frontier0 and drains one job to99. A distinct head on pull1102 returns its real diff with zero Git requests. Reintroducing the first100 limit fails; restored source passes.
- `node scripts/api-local.mjs --channel`: the first restored writer and full two-client channel/browser/private-revocation flow pass using tracked namespace inventory.
- Scoped TypeScript passes. These are local source/fixture results, not deployment or real CLI execution/video evidence.

## Limits and remaining integration

The existing100,000-entry tree limit remains. An individual prepared tree value larger than700,000 UTF-8 bytes is left Pending, and that unsupported preparation job does not block other alarm work. Blob content larger than700,000 base64 characters remains Pending; directory/tree facts and smaller files can still publish. There is no claim of eventual readiness for those size limits or arbitrary unadvertised objects. A proven negative Git-object receipt is still a separate remaining integration.

The catalogue-page, conversation, indexed-search and repository-history modules have signed local source/tests, but their full service/ingestion/SSR wiring is not included in this completed four-operation group. The previously completed10 prepared read operations plus these four are14 implemented operations locally. Rich repository/explore/activity, summaries, workflow/package DTO gaps, normalized live consumers, remaining SSR and actual CLI result/private-audience flows remain tracked on issue96. No merge, deployment, release or live runtime action is part of this batch.
