# Repository invitation scope and channel review alignment

An API token restricted to repository A could accept or decline an invitation to
repository B. These registered invitation URLs contain only an opaque invitation
ID, so the ordinary owner/repo dispatch allow-list check did not run. The privacy
handler resolved the entity on acceptance but did not apply the token allow-list;
decline removed the row without resolving its repository. Scoped listing also
returned B's opaque invitation ID.

`lib/collaborators.ts` now resolves the invitation's current settings entity and
checks the existing `permitsRepo` policy before acceptance or scoped decline. An
unavailable, deleted or out-of-scope target returns the same404 as a missing
invitation, before ACL or invitation-removal effects. Scoped listing uses the
same resolution and policy. Unrestricted browser principals explicitly carry
`repos:null`; their existing opaque listing and stale/deleted decline cleanup
remain unchanged. Acceptance still revalidates the inviter's current admin role.
No schema, token scope, grant, private-read rule or repository scan is added.

## Bounded evidence

- `node --test lib/invitation-scope.test.ts` against unmodified f3 produced four
  effect failures: PATCH B caused one ACL write and one invitation removal,
  DELETE B caused one removal, scoped listing returned B, and renamed B remained
  actionable. Three compatibility cases passed. The fixture uses the registered
  dispatcher/service/privacy handler, actual D1 store queries on disposable
  SQLite, stored fake-token verification and current entity IDs. Its ACL write
  port persists into that store; production Git publication is outside this test.
- `node --test lib/invitation-scope.test.ts lib/privacy.test.ts` after the fix:
  **19/19 passed**, including zero denied effects, unchanged private ACL/row,
  missing-ID indistinguishability, allowed acceptance/decline, unrestricted
  browser-principal behavior, stale inviter/deleted/missing acceptance denial,
  stale decline cleanup, rename and case-insensitive current target selection.
  Scoped TypeScript, script syntax and diff checks passed.
- The full f3 hosted API job failed at the channel review harness assertion
  `state-time mutation applies`: the state-time code had moved from
  `lib/channel/do.ts` to `lib/channel/session.ts`. Only that mutation tuple is
  corrected to target `Date.parse(state.data.last_activity)`. The existing
  `node scripts/channel-review-revert.mjs state-time` then omits actual timestamp
  parsing and fails `channel state survives reconnect and stale receipt delivery
  cannot replace newer activity` (`idle` instead of `busy`,25/26 pass). The
  finally-restored source passes26/26. Assertions, cases, budgets, workflow and
  product session behavior are unchanged.

The first invitation fixture attempted to remove the last organization owner,
and a later fixture reused an existing token hash. Both real storage constraints
rejected setup; those logs are retained and excluded from effect acceptance.
The corrected baseline and restored results are recorded separately under the
owned worktree's `.tmp/invitation-*` and `.tmp/channel-*` logs.

These are local source/effect results, not a production exploit or deployment
claim. No real token, grant, repository write, model call or production probe was
used. The old f3 hosted watch is closed failed; this correction requires bounded
source review and fresh-head CI. Merge/deploy remain held behind those results
and the independent Cloudflare audit. No previously passing full build or broad
matrix was repeated locally.
