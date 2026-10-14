# Settings surfaces and lifecycle

This lane builds account, organization and repository settings from the approved
Main, OrgGeneral, OrgMembers, RepoSettings, RepoActions, AccountOrgs and Phone mocks.
The header name is the settings context dropdown. Navigation is grouped on desktop
and becomes a select at 400 px; the portal rail becomes a menu button. Light mode
uses the existing CSS tokens. The grouped account navigation and theme choice follow
Zega dashboard/account settings; the organization header, tabs, profile column and
danger rows follow the approved GitHub-shaped mocks.

## Real sections

- Account: profile, organizations/create/leave/restore, claim key, API tokens,
  sponsored agents, and actual repo runners.
- Organization: General, Members and existing organization Webhooks.
- Repository: General, Actions (required workflows, secret names/writes, repo runners)
  and existing Webhooks.

Future collaborators, visibility, agent-access settings, owner runners, runner groups
and import sections are omitted. The shared navigation descriptors and Actions runner
list are their extension points. The base gives members public read/participation,
so the Roles table describes that actual permission rather than the mock's broader
write permission. Account email/key remain read-only. Repository settings offer a
select of live code branches and Switch. Artifacts has no documented default-branch
update endpoint, so Gild stores this preference in D1 and applies it to the web/API,
RepoIndex/search/Actions defaults, and Git v0/v1 advertisements and v2 ls-refs HEAD.
Direct Artifacts remotes retain their creation-time HEAD. Descriptions use the same
D1 overlay returned by web and API reads. New repository names are lowercase and
cannot end in `.git`; case-insensitive unique indexes guard lifecycle names.

## Storage and caching

Migration `0011_settings.sql` adds profiles, bounded picture blobs, lifecycle state,
name aliases/reservations, write leases, durable rename progress and cleanup work, plus transactional last-owner
and shared owner-name guards. It is applied only to disposable local test databases.

Settings are mutable and per-viewer: every section is dynamically rendered with
`Cache-Control: no-store`. No settings page is edge cached. Picture upload is resized
in the browser to at most 256 px WebP/64 KB, validated again on the server, and stored
once in D1 under SHA-256. `/avatars/<hash>` serves those bytes with one-year immutable
public caching. GC only deletes unreferenced blobs whose last upload is over one
hour old, including refreshing the grace period when an existing hash is uploaded.
Default pictures resolve to Gravatar by the claim email (people) or public email (orgs),
then to the shared theme-aware SVG silhouette on a missing image. See
[profile picture resolution](../gravatar/README.md).

## Rename, archive, delete

Artifacts exposes no rename or cross-namespace fork. Rename returns **202 Accepted**
after reserving the destination, fencing writes and scheduling `SettingsRename`.
A Durable Object alarm waits for source/destination leases to drain without a
five-second rejection, then copies one repository per durable step. GET the same
`/rename` endpoint to read phase, completed/total repositories and any retry/failure.
The settings danger zone shows this progress across reloads. Cron re-arms pending
jobs if initial scheduling is interrupted or an alarm is lost. Completion records
its terminal progress and releases reservations/locks in one transaction. The copy includes every
advertised Git ref and history (including `_meta`, tags and issue/PR records), and verifies each destination ref.
Only then does one D1 transaction switch names, memberships, profile, caches and aliases.
Hook scopes follow the address; stable repository IDs retain RepoIndex/RunQueue data,
registered runners, and secret encryption AAD. Old physical copies are scheduled for
one-time cleanup. Web/API/Git HTTP URLs return 308 to the canonical name, preserving
method, suffix and query. Aliases stay reserved against other owners. The current owner can rename back to
its own previous name: publishing drops that alias, re-points the remaining aliases,
and removes cleanup work for the reclaimed destination so it cannot be GC'd.
Org/child lifecycle locks exclude one another. The copy runs outside the HTTP request; it still uses an in-memory full-history
Git mirror, so this change does not claim a measured 300 MB copy or remove Worker
memory limits. Failed copies discard the staged targets and leave the original visible address and membership intact.

Archive blocks git receive-pack and all ordinary mutations, suspends running/queued
Actions and suppresses new/pending webhook delivery. Clone/fetch upload-pack POSTs
remain readable during archive and rename; only receive-pack is a Git mutation.
Public reads display an archive banner. Owner-only unarchive restores writes; canceled work is not automatically rerun.

Delete requires the exact org name or `owner/repo`, hides it from listings and reads,
and suspends work. Membership and all repo data remain for owner-only restoration
until seven days after deletion. The existing once-per-minute scheduled job purges
expired deletions: physical Git repositories (all code/meta history), RepoIndex and
session/search data, RunQueue jobs/runners/settings/outbox, encrypted action secrets,
configured action-log objects, matching D1 score/change caches, hook definitions and
deliveries/event history, profiles, memberships and org rows. Unreferenced picture blobs
are collected after the purge with the one-hour grace period. Repo-scoped API
tokens are revoked (including a multi-repo token containing the deleted scope);
unrestricted personal tokens, claims and agents are retained. A failed cleanup or
repo/owner purge logs its address and retries next cron, while other items and
avatar GC still run. Successful siblings are attempted even when one repo fails.
Empty Artifacts namespaces have no supported delete endpoint. A failed purge retries
on the next cron; restore is refused after the deadline. Ordinary deleted names are
released after purge; names retained as redirect sources/targets remain reserved.

## Verification

```sh
npm test
npx tsc --noEmit
npm run test:settings:revert
npm run build:cloudflare
npm run test:settings:local
npm run test:api
npm run test:actions
```

The settings fixture runs the full OpenNext application on local workerd with real D1
and Durable Objects. Only its Artifacts HTTP transport points to a disposable local Git
server. It uses generated local-only credentials and never reads or writes remote
secrets. It verifies browser permissions, actual form writes, API response contracts,
old-URL native Git clone/fetch/push, archive refusal/cancellation, restoration and the
real scheduled purge. It runs `npm run test:corner` against all existing/new routes.
The mutation proof removes member-admin, last-owner and danger-owner guards, the
configured cron, the upload-pack read classification and the cookie CSRF gate one
at a time. Named effect tests must fail before restoration. The cron test reads the
actual `wrangler.jsonc`, bundles the production Worker with binding adapters, invokes
its scheduled entry and asserts expired Git data and old unreferenced pictures go.
Cookie mutations use matching Origin and same-origin Sec-Fetch-Site (or no Fetch
Metadata for older clients); bearer calls authenticate independently. SQL last-owner
ABORTs are translated to the same 409/message as the service check.

Screenshots in [screenshots](screenshots/) cover all three settings areas, Members,
Actions, the org page and typed deletion, in light/dark at 1400/400 px.

## Organization Overview

Overview follows `Main.dc.html`: repository cards show real descriptions, dominant
language, the mean of cqx's five category scores when supported, and updated time.
Owner/admin New repo links preselect the org. The right column contains the org
profile, People avatars, and an actual repo-runner summary only when runners exist.
The full membership list is only on People. Language/score summaries resolve the
branch to a commit first, then use an immutable D1 cache keyed by commit and cqx
build. Viewer/profile/runner data remains dynamic; pages use no-store.

Local picture HTTP first/repeat samples were 66.2/1.4 ms with immutable caching.
Full Overview navigation samples were 214/602 ms under the integration load; these
dynamic page samples do not establish a page-speed improvement.

Native Git v0 and v2 clones confirm Switch selects the advertised HEAD. The local
fixture holds a real push lease while recording queued-rename screenshots, then
releases it and observes the actual alarm finish. No remote migration, deployment,
merge to a shared base, release or CI polling is part of this lane.

-codex
