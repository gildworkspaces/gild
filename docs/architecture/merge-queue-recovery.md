# Durable merge queue recovery

Queueing persists a RunQueue SQLite preparation before Git can accept the
queue metadata. The request ID and pinned head are recorded beside queue
membership in the same `_meta` commit. A lost response or post-push publication
failure cannot discard the preparation. Missing receipts remain uncertain rather
than expiring into a lost wake-up; known pre-commit validation rejection retires
its preparation. A repository can hold at most 128 unresolved preparations.
Operator reconciliation is required for truly abandoned uncertain preparations;
no automatic retry creates another queue authorization.

RunQueue alarms use explicit D1, Artifacts, RepoIndex and channel bindings through
MetadataRuntime and backgroundMergeRuntime. They never synthesize a Next request
context. Shared metadata writes retain the lifecycle lease, pre-push ACL fence,
Git conflict retries, metadata events/index rebuild and post-push access
publication. Actions finish wakes the queue; incomplete CI stays queued and is
retried durably. Earlier Actions alarms cannot be postponed by merge scheduling.
RepoIndex discovers legacy persisted queues only in background indexing, never
on ordinary page reads.

Each new merge attempt verifies an open queued PR, current branch names, the
explicitly selected head/base refs, a non-author approval at that head, no latest
changes-requested review and successful required Actions at that exact SHA.
Changing the head requires approval and a new explicit queue selection; a
previously queued head does not silently become another selection. The head is
advertised again immediately before the base push, and Git rejects races on the
base. As with other Git operations, this is a selected immutable-head check, not
an atomic multi-ref transaction or a distributed lock on all repository edits.

The browser queue action acknowledges queueing and defers merge work instead of
waiting on a Git merge. Concurrent drains do not duplicate merged metadata
events or remove a newer explicit queue selection. Immediately before pushing,
reviews, membership and CI are rechecked. Merge commits contain a fresh opaque
attestation nonce so an unpushed planned OID cannot be guessed from public inputs.

Before pushing a merge, the server records the planned commit OID/head/base/prior
base in private RunQueue SQLite. Recovery requires that attested exact commit in
the base ancestry; a Git message or author cannot impersonate it. A crash after
the code push resumes publication and metadata finalization without another
merge, even when the accepted head branch has since disappeared. Finalizing an
already accepted commit does not authorize new code. Existing metadata events,
closing references, Actions push/synchronize delivery and index wakeups remain
part of that finalization.

Completed preparations retire only after their committed request receipt is
observed and the PR has left the queue. Conflict results leave code untouched,
mark the PR and remove queue membership. Missing/closed PRs are dropped without
new code work. Queued preparation/CI errors remain pending and expose only a
bounded generic merge error, never repository tokens.

Validation commands: `bun run test`, `bunx tsc --noEmit`,
`bun run build:cloudflare`, `bun run test:merge-queue:revert` and
`bun run test:merge-queue:local`. Focused tests use real Git/SQLite and the native
RunQueue alarm with host ports replaced. The local Worker gate uses compiled
OpenNext, real workerd/D1/DOs/RepoIndex/Git, loses enqueue acknowledgement,
restarts the Worker, and completes a fixture runner lease through production
step/finish endpoints. Only the native alarm resumes the merge; the test never
calls drain/re-enqueue after CI completion. This validates runner-protocol and
queue behavior, not provider/model or actual workflow execution support.

Final combined audit/speed integration and all CI gates remain required before
website readiness. This change does not merge, deploy or publish anything.
