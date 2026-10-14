# Ambiguous API writes and recovery

Authorization and input validation precede the idempotency reservation. Once
execution starts, an exception cannot prove that the operation had no effect.
The dispatcher retains that running reservation and returns an unresolved 409
on subsequent requests, with Retry-After: 1. Running reservations cannot expire
into permission to repeat a write. Completed responses retain a 24-hour replay
window from completion. The original input fingerprint still rejects key reuse
with different input.

For createIssue, createPull, createIssueComment and createPullComment, the stable
operation identity includes the authenticating token identity and the scoped
idempotency key and normalized input fingerprint. The first metadata write includes its result receipt under
.gild/operations/<identity>.json in the same _meta commit as the business record.
The receipt contains no credentials. Follow-up Actions and event jobs do not
reuse the operation identity.

PR receipts also freeze the actual committed creation record, resolved head/base
SHAs and repository response facts before the metadata commit. Recovery never
resolves current branches or reads edited PR content; deleting or advancing
branches cannot change the recovered creation response.

A retry reads that receipt from the prepared metadata index and constructs the
original record's response without calling the create handler. An index that
has not caught up returns unresolved 409; it never initiates another write.
Once recovered, the response is persisted for ordinary replay and marked
Idempotency-Reconciled: true. The existing JSON response schemas are unchanged.
Metadata writers also recognize an existing receipt when recovering a Git push
whose response was lost, and skip the mutation callback.

Other write types retain uncertain reservations conservatively; they do not yet
have automatic result reconciliation. A failure before a business write may
therefore require explicit investigation when it occurs inside execution.
Unknown running reservations require durable storage until reconciled. Changing
keys or tokens is a new operation and must not be treated as a safe recovery.

Tests cover post-write errors through the real dispatcher/service and SQLite
idempotency store, a store restart, unprepared receipts, input conflicts, replay,
and recovery beyond 24 hours. A separate test performs a real local Git clone,
commit and push through the production metadata writer, injects a post-push
publication failure, and confirms the business record and receipt share one
commit and recovery makes no extra commit. The test replaces deployment binding
lookups and indexing notifications, not Git or the metadata mutation path.

The Actions settings page imports its shared runner status helper directly from `lib/actions/runner-status.ts`, so the server queue/event graph and metadata async context never enter that browser bundle. The production Cloudflare build verifies this boundary.

`test:idempotency:local` runs the compiled OpenNext routes, real workerd Durable Object SQLite and real disposable Git repositories. It loses response persistence after each of the four create handlers commits, then verifies reconciliation, replay, changed-input rejection and an unchanged Git tip on every retry.
