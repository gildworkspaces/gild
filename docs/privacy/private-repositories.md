# Private repositories

Private repositories are free. `visibility` lives in `.gild/acl.json`; `repo_access` is the current D1 projection of that policy and the expected `_meta` revision. Every repository read uses `mayRead`, including cached responses. People read through primary ownership, current organization membership, or accepted `read`/`write` ACL entries. Agents need an explicit nonempty ACL grant or read/write entry and a live authenticated identity. Empty agent grant arrays confer no private read access.

Repo settings add **Visibility & collaborators** through the existing settings extension point. Account settings add **Repository invitations**. Creation has a private checkbox. Invitations contain only an opaque ID and proposed role until accepted; accepting revalidates the inviter's current owner/admin authority and commits the ACL. Inviting, changing roles, removing collaborators, and changing visibility require owner/admin authority. Publication requires typing the exact `owner/repo`. The confirmation pattern follows Zega dashboard's project-delete settings flow; the surrounding layout, controls, themes, and navigation use Gild's existing settings components.

The CLI supports `gild repo create --private`, `gild repo visibility public|private`, and `gild repo collaborators add|rm|ls`. Visibility and collaborator commands accept `--repo owner/name` or resolve the current checkout's origin. Publication takes an exact-name interactive confirmation or `--confirm owner/name`. Private cloning uses the existing origin-bound credential helper.

## Write fence and recovery

Before a metadata commit is pushed, D1 stores the proposed revision as pending. RepoIndex records dirty/alarm state before the upstream push. Accepted receive-pack `_meta` pushes use the same fence and refresh path; the direct-push test actually pushes through the Git proxy.

Pending access is conservative private access: primary owners and current organization members retain structural access, while previous collaborator and agent grants are closed. This lets an owner retry a rejected or uncertain push without reviving a removed grant. Runner checkouts and fragments wait for committed policy publication. A projection may publish only the exact fenced revision. A late projection of an older public revision cannot overwrite a completed private revision. Listing RPC/D1 failures retain durable dirty/alarm work and retry; there is no stale public listing window. Listing rows older than the access revision are private until refreshed.

Migration **0014_private_repos.sql** adds `repo_access`, `fragment_repos`, and `repo_invitations`, seeding access from existing listing rows. Ava applies it before deploying. Unindexed legacy repositories remain hidden until their ACL is known. This is deliberate fail-closed bootstrap behavior; normal newly created repositories publish access before releasing their name reservation.

## Caching decision

Immutable expensive results remain stored by owner/repo, commit/content hash, cqx version, and reads version. Landing candidates use `landing:rows-v2:<minute>` and hydrate live policy before serving cards or cached commits. The scheduled cleanup recognizes both landing key schemas. Listing policy is joined into the existing batched D1 query, preserving the measured warm-page budget without per-repository RPCs. A cold miss re-reads that joined projection after its RPC: a returned indexed snapshot cannot bypass a pending fence or failed policy publication.

The current D1 policy/fence is read on every boundary. The short isolate memo caches only parsed policies under their immutable revision and ACL value; mutable visibility is never served from a TTL memo. Search filters before count, facets, suggestions, and pagination. Event streams recheck repositories and organization audiences after a long poll. Webhook delivery revalidates the creator's current authority and repo access, and rejects foreign repo/org scopes. Global agent-request routes and approval pages check the associated repository too. Signed join receipts revalidate the live registered key and current grant before disclosing the repo or minting read scope.

For static-at-commit fragments, public hash provenance is checked **before** an edge-cache or R2 hit. A current private or pending repo revokes its public provenance immediately. New private pointers use the private storage scope; `/pf` reads require current access and never enter the public edge cache. Missing provenance is rebuilt only after validating the requested object belongs to a currently public repository. Private browser source storage includes the principal and private scope; public source storage includes the repository. Revocation/sign-out clears cached source entries and broadcasts to other tabs; focus refresh removes a denied repository view.

Private HTTP responses use `Cache-Control: private, no-store`. Externally served repository URLs revalidate with `max-age=0, must-revalidate`, including URLs containing commit hashes. A browser's year-long immutable response would otherwise remain readable after public-to-private. Identity-free renderer assets retain immutable browser caching; content remains immutable in R2 and the internal edge cache. Previously downloaded bytes cannot be recalled, but a request to an old public hash cannot bypass current policy.

First-view/cached local measurements are recorded in `evidence.json`; immutable code-page request timing is noisy at this scale. Listing gates separately measure first-owner, warm-owner, landing, new-isolate, and post-push timing and enforce zero warm repository DO calls.

## Verification

`test:privacy` runs real workerd, D1, RepoIndex, RunQueue, API dispatcher, Git proxy, search, event delivery, and webhook receiver. Page payloads in that transport fixture are index-backed adapters. `test:privacy:web` independently runs the compiled OpenNext Worker, actual HTML/RSC routes, and browser settings forms. It creates a private repo through the checkbox, accepts/declines invitations through account settings, warms a public hash before privatization, and crawls every app route as an outsider, including discovered opaque agent-request IDs. Marker checks cover body, headers, plain text, and base64 representations.

The table summarizes the eight-viewer matrix. `allow` means an actual successful read; `deny` is 404, except anonymous Git's credential challenge (401) and the authenticated-only event endpoint (401). Git clone itself runs through the compiled CLI credential helper for every viewer. Public explore intentionally never lists private repositories even for authorized viewers.

| Read path | Anonymous | Outsider | Read collaborator | Write collaborator | Org member | Owner | Granted agent | Ungranted agent |
|---|---|---|---|---|---|---|---|---|
| Code/issues/PRs/Glance/health/agents/actions/search pages | deny | deny | allow | allow | allow | allow | allow | deny |
| API contents/immutable commits/agent grants | deny | deny | allow | allow | allow | allow | allow | deny |
| Git clone/info-refs/upload-pack | deny | deny | allow | allow | allow | allow | allow | deny |
| Search suggestions/results/counts | empty | empty | allow | allow | allow | allow | allow | empty |
| Actions run logs | deny | deny | allow | allow | allow | allow | allow | deny |
| Webhook delivery authority | deny | deny | deny | deny | deny | own hook | deny | deny |
| Event stream/private payload | deny | deny | allow | allow | allow | allow | allow | deny |
| Owner listing | empty | empty | allow | allow | allow | allow | allow | empty |
| Public landing/explore | empty | empty | empty | empty | empty | empty | empty | empty |
| Global agent request detail | deny | deny | allow | allow | allow | allow | allow | deny |

Webhook mutation/delivery authority is owner/admin-only; ordinary repo readers do not become hook creators. The suite receives the real private payload at the repo's own hook and rejects foreign repo/org scopes. Runner checks also prove a leased owner runner can clone and execute a private job, while shared `mayRead` prevents an agent-owned runner from inheriting its sponsor's private access.

Three independent revert proofs remove the shared read check from the page boundary, listing filter, and event selection. Each effect test fails with an assertion error; the restored suite passes. The script first verifies the baseline and rejects syntax errors as proof. Additional cases cover mixed-case viewers, empty grants, token read scope and repo allow-lists, immediate collaborator removal, explicit publication, a failed listing write after the ACL push lands, direct `_meta` push, late ACL publication, and owner retry of an uncertain fence.

-codex
