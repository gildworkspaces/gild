# Revoked agent labels remain reserved

Audit finding 4 reproduced an approved join whose token collection later failed because the existing agent record was revoked. Requests and approvals now reject every existing sponsor/label with 409, including revoked identities. Revocation retains the key, tokens and grant history. Use a fresh label for a new agent; this change does not revive or replace identities, credentials or grants.

Approval repeats the check to reject legacy pending requests and labels occupied after the request was filed. A rejected approval leaves the request pending, its token unissued and the original identity untouched; the sponsor may still deny it. Collection remains fail closed for revoked agents and token verification still rejects revoked identities.

`lib/agent-request-revocation.test.ts` runs production request/approval/collection and token code against memory and the actual D1 driver on migrated SQLite. It signs disposable Ed25519 proofs, verifies fresh-label collection once, preserves old-token denial and checks rejected admission/approval state. Cloudflare event delivery and repository-grant integrations are replaced; fixtures request no repository access. This does not certify live Worker/browser behavior or solve broader concurrent identity lifecycle semantics.

Reproduce `node --test lib/agent-request-revocation.test.ts` (six effects) and `node scripts/agent-request-revocation-revert.mjs` (both removed checks fail by actual assertion; restored source passes). Full final integration gates remain required with audits 1–3, auth-publication and preserved speed work.
