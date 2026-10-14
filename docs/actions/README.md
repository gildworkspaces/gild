# Repository Actions

Actions runs ordinary `.github/workflows/*.yml` and `.yaml` on registered Linux/macOS/Windows machines. The forge queues work; it does not rent compute. The Actions board, run detail, commit status and PR merge box share the same run records. Existing gild tokens, header and light/dark theme behavior are retained; sibling zega/cqx properties were inspected before adding the UI.

## Storage and caching (§7c)

Each repository has a SQLite `RunQueue` Durable Object. Synchronous SQL transactions make assignment atomic. Runs, expanded jobs, steps, leases, runner registrations, log chunks, settings and a durable trigger inbox live there. Successful receive-pack acknowledgements, PR creation/reopening/head updates and merges deliver events to that inbox. Alarms retry event processing after restarts. `_meta` updates do not trigger workflows.

Workflow parsing is cached by **commit hash and parser schema version**, in the DO and D1's existing immutable cache. The repo index supplies snapshots when available; otherwise the existing cached tree/blob readers serve page requests. Alarm processing uses the same Artifacts commit/tree/blob REST interface with hash-keyed SQL caches. PR filters compare the head against its merge base; merge bases and changed paths are cached by immutable commit pair. Moving branches are resolved to hashes first. No cloning or parsing happens on a cache hit.

Run lists and live logs read the DO, with `Cache-Control: no-store`; they change during execution. Repository names are validated and existence is checked before allocating a DO (a 30 s positive memo, not an immutable cache). Viewer-specific buttons and the signed-in header prevent caching an entire board. Immutable workflow data is cached underneath it.

On completion, an alarm commits `.gild/actions/<run>.json` to `_meta`, with push conflict retries. Git is the permanent summary record; the DO serves reads. Summary archive failures remain retryable and visible. The optional `ACTION_LOGS` R2 binding saves step logs and summaries; after DO pruning, finished logs can be read from R2. Without R2, logs remain chunked in the DO. Both paths cap logs at **2 MiB per run**; only the newest **32 archived runs** retain full DO logs. Summaries/status remain available. Batches are idempotent and terminal batch receipts are pruned.

## Protocol, version 1

All endpoints below are under `/api/repos/:owner/:repo/actions`. Registration uses the existing session or `gf_` user/agent token verifier, including expiration and agent revocation. Registration requires the repo owner or an org admin; org registrations belong to that org. The returned `gr_` machine token is scoped to this repo, stored only as a hash in SQL, and permits assignment/reporting plus read-only git checkout. It cannot push or edit repo settings. Removing a runner revokes it.

| Method / path | Authentication | Behavior |
| --- | --- | --- |
| `GET /`, `/runs/:id`, `/runs/:id/logs`, `/runs/:id/jobs/:job/logs`, `/commits/:sha` | Existing public repo visibility | Board, jobs/steps, incremental logs, latest workflow attempts for a commit |
| `POST /runners`, `DELETE /runners/:id` | Owner/org admin; removal also checks runner ownership | Register/revoke a machine |
| `POST /runners/poll` | Repo-scoped runner token | Atomic assignment; up to 20 s long poll; schema 1 response |
| `POST /runners/heartbeat` | Runner token + job/lease | Renew lease; receive cancellation |
| `POST /runners/logs` | Runner token + job/lease | Mask and append sequenced complete-line batches |
| `POST /runners/step`, `/runners/finish` | Runner token + job/lease | Record step/job result; reject stale leases and incomplete success |
| `POST /dispatch`, `/runs/:id/rerun`, `/runs/:id/cancel` | Owner/org admin | Resolve ref, create a new attempt, or cancel work |
| `GET /secrets`, `PUT /secrets/:name`, `DELETE /secrets/:name` | Owner/org admin | Names only on reads; encrypt/replace/delete values |
| `PUT /settings` | Owner/org admin | Set required workflow filenames; empty by default |

Heartbeats are sent every 10 s; a 60 s expired lease fails the job with a reason. Alarms also fail runs with no eligible machine after 24 h. Job execution is bounded at 6 h. Requests are capped at 256 KiB; workflows at 128 KiB each/64 files, expansion at 256 jobs and 100 steps per job. An expanded workflow is capped at 1.5 MiB. Errors are displayed, rather than turning unsupported work into success.

## GitHub Actions compatibility

| Feature | Supported behavior / boundary |
| --- | --- |
| `on: push` | Branch/tag/path filters, ignore filters and ordered negation; GitHub glob operators; deleted refs and `_meta` ignored |
| `pull_request` | Open/reopen/synchronize, type/branch/path filters; executes the head commit, not a synthetic GitHub merge commit |
| `workflow_dispatch` | Owner-controlled branch/tag dispatch; inputs are rejected |
| Jobs | Label matching (`self-hosted`, Linux/macOS aliases, arch, custom labels), `needs`, simple `if`, env, timeout, matrix axes/include/exclude |
| Matrix scheduling | Independent jobs; explicit `fail-fast: true` is rejected, not silently emulated |
| Steps | `run`, name, env, shell, working-directory, simple `if`, timeout, continue-on-error; failed pipelines fail under default bash |
| Expressions | `github.*`, `env.*`, `matrix.*`, `secrets.*`; equality, boolean operators, grouping, `contains`, `startsWith`, `endsWith`, status functions; missing properties resolve empty |
| `actions/checkout@*` | Runner already checks out exact SHA through gild; fetch-depth/persist-credentials accepted; custom ref/path/submodules/LFS inputs fail clearly |
| `actions/setup-node@v4/v5/v6` | Execute pinned upstream action, download matching native Node and persist PATH; requesting dependency caching fails clearly |
| `oven-sh/setup-bun`, `actions/setup-go` | Check installed tool/version selectors; do not install or download tools |
| `dtolnay/rust-toolchain`, `actions-rs/toolchain` | Check installed rustup toolchain; components/targets unsupported |
| `actions/upload-artifact`, `actions/cache` | Unsupported; the step fails with an explicit missing-backend error |
| Other `uses` | Fails with `gild doesn't run <action> yet` |
| Permissions | Metadata accepted; no GitHub API token is synthesized |
| Unsupported | Schedule/reusable workflows, services/containers, outputs, concurrency, complex expressions, GitHub API tokens, downloads for other toolchains and arbitrary action code |

Repository secrets use AES-256-GCM with repo/name as authenticated context. Only encrypted values are stored in D1 and DO masking state; values are never returned by the management API. Logs mask raw values, individual lines, URL/base64 forms and gild token patterns. PR runs and agent-authored pushes receive no secrets. Owner-controlled push/dispatch runs may receive them. Long output lines fail before emitting a partial secret tail. As with any process runner, transformations performed by a script cannot all be inferred by a masker.

The optional merge hook checks the **latest attempt of each required filename at the fetched PR head SHA** before merging. It defaults off. Missing, queued or failed checks leave the PR pending with an explanation; after checks succeed, requeue the merge. There is no automatic merge watcher in this change.

## Local evidence

Run `bun run test` for the normal suite, `bunx tsc --noEmit`, and `bun run build:cloudflare`. The integration script requires this repo and `../gild-cli`, Bun, git and Wrangler:

```sh
bun run test:actions
bun run test:actions:r2
bun run test:actions:revert
node scripts/actions-local.mjs --r2 --serve
# In another terminal, while the fixture is serving:
bun run test:actions:browser
```

The integration test invokes the compiled CLI as `gild runner add/start/list/remove`, authenticates through the shared production HTTP handler and D1 token verifier, and runs the actual SQLite DO under local Wrangler. Its disposable git server substitutes for Cloudflare Artifacts; owner-role resolution and Next routing have local adapters. No production credential or remote deploy is involved. It observes queued → running → success, asserts echo/Node output and masking, reads the committed `_meta` summary, races two HTTP polls for one job, checks unsupported actions/continue-on-error/timeouts/oversized lines/PR secret withholding/runner loss/revocation/required-workflow gating, and restarts the Worker with a pending trigger. The R2 test removes DO log chunks and reads the archive back.

Latest local R2 measurements: workflow miss **56 ms**, hit **0 ms**, **zero git reads on hit**; first/repeated run-list reads **6.92 / 6.24 ms**. DO-only measurements: workflow **54 / 0 ms**, run lists **6.51 / 5.26 ms**. These are local fixture measurements, not production latency claims. JSON evidence is written to `.tmp/actions-evidence/` (not committed). Browser verification uses the real board/run/tab components with a Next router adapter and the live fixture API: both themes, 400 px overflow checks, workflow selection, masking, dispatch, rerun and cancellation. Screenshots are in the PR (gildforge/gild-site#16).

Revert evidence removes YAML 1.2 parsing, ordered filter negation, exclusive job claim and log masking individually; each selected assertion fails. CLI revert evidence additionally removes bash pipefail and shared first-step log sequence counters; both fail, including a real integration failure for lost step logs. Every mutation is restored in `finally`.

## Deployment handoff (Ava/Sami)

- Apply D1 migration `0008_action_secrets.sql` and the SQLite DO migration `actions-v1`; `RUN_QUEUE` is included in `wrangler.jsonc`.
- **Needs Sami: ACTIONS_SECRET_KEY on gild-site/Worker** (32 random bytes encoded as base64). There is no key value in the repository. Existing `ARTIFACTS_TOKEN` is used in place, never copied.
- Proposed optional R2 bucket: **`gild-actions-logs`**, binding **`ACTION_LOGS`**. Ava creates/binds it; absent binding uses the bounded DO fallback.
- Ava deploys and registers a real machine later. Bootstrap Node and other toolchains must already be installed. setup-node installs the selected Node per job. The CLI runs jobs as the invoking non-root account, with per-run checkout/HOME/TMP and cleanup; it is native process execution, without container isolation.

-codex

## Trust model

The same as GitHub Actions on self-hosted runners:
- **Pushes and manual runs** get the repo's secrets, so anyone who can push or dispatch can read them. Grant write access with that in mind.
- **Pull request runs** never get secrets. They do execute the PR branch's code on your runner, though, so register runners for repos whose contributors you trust, and run `gild runner start` as a dedicated OS user. Steps can read that user's files, including the runner's own token under `~/.config/gild/runners/`.
- **Run history and logs** follow the shared repository read policy. Secrets are masked before logs are stored, and so is each line of a multi-line secret.

## Owner runners and trust

Repo runners keep their existing `gr_` registration and config. Org owners/admins and personal-account owners can also register a machine at owner scope with `gild runner add --org <owner>` or `--user <owner>`. The `gro_` credential proves the machine identity only; it cannot clone repositories, list them, change groups or call another owner's pool.

Each owner has a Default group (all private repositories). New groups start with selected access and no repositories. Groups may allow all or selected owner repositories. Public repositories are excluded unless **Allow public repositories** is enabled. Untrusted public PR runs, including fork code, require a maintainer's explicit approval before either a repo or inherited runner can lease them; all PR runs still receive no secrets. Existing trusted maintainer PR runs remain automatic.

An owner lease returns a random `gc_` checkout/reporting token stored only as a hash in that repository's RunQueue. It is valid for that repository and job only while its 60-second renewable lease is running. It cannot clone a second repo or push, and becomes unusable immediately on completion, cancellation or lease expiry. The CLI uses it for checkout, heartbeats and logs and does not pass it into workflow environments. A machine runs arbitrary workflow code as its OS account; use a dedicated account, because subprocesses can read that account's local files.

Setup pages mint `grt_` one-time registration tokens bound to the owner and group (or the particular repo). They expire in one hour and are consumed atomically with registration. `gild runner add --token` requires no owner identity on the runner machine. The stored config stays schema 1 with an optional `scope` (`repo`, `org`, `user`) and `owner`; old configs with only `repo` continue working. Registration secrets are returned once and never stored in API idempotency responses.

The owner RunnerPool is keyed by the settings owner identity, preserving machines and group access across renames; permanent owner purge revokes its credentials. It stores machines, groups and offered repository queue IDs. On a poll it asks the offered RunQueues for ready jobs, orders them by creation time across repositories, then asks the selected RunQueue to lease one job atomically. Repo and owner machines therefore share the same lease authority. The pool reserves a machine before the cross-object call to prevent concurrent polls from giving it jobs in two repositories. Abandoned reservations expire after 60 seconds. Group changes and repository visibility are checked again immediately before the lease. A current lease continues after group access or runner removal.

Eligibility uses `mayRead` in `lib/repo-read.ts` for the owner and anonymous viewer; the private-repositories lane can replace that read policy in one place. Runner state, eligibility and setup tokens are live, `no-store` data, with only per-request memoization. Workflow parsing remains cached by immutable commit SHA. Runner registration/removal/online/offline events use the durable event outbox; organization event streams are visible only to current owners/admins.

API v1 has `/orgs/{org}/actions/runners`, `/users/{name}/actions/runners`, registration-token and poll subpaths, runner PATCH/DELETE and recent jobs, plus runner-groups CRUD and repository GET/PUT/DELETE access. Repo runner listings include inherited machines, their group, eligibility and an ineligible reason. `/repos/{owner}/{repo}/actions/runs/{run}/approve` is writer-only.

`gild runner service install --name <name>` installs a launchd agent on macOS, a systemd user unit on Linux, or an SCM service host on Windows. `service status` and `service uninstall` use the corresponding OS manager. Windows installation requires an elevated terminal and prompts for the service account through PowerShell; account credentials are never written to a Gild config or service command. Linux starts at login; user lingering can enable startup before login. Windows workflows should specify `shell: powershell` or `shell: pwsh` (with PowerShell 7 installed); the default shell remains bash for compatibility. Service definitions carry only the runner config path, never tokens. The local integration proof covers native macOS launchd; Linux and Windows service plans have unit coverage but need native platform validation.

Validation: `npm run test:runners`, `npm run test:runners:revert`, and `npm run test:runners:local`. The local harness uses the complete OpenNext build under `wrangler dev`, actual D1 and Durable Objects, and disposable local Git/Artifacts transport. It writes screenshots and sanitized timing/result evidence under `docs/actions/`. `wrangler.jsonc` appends the `runner-pool-v1` SQLite class migration; no remote migration is applied in this lane.

Issue #44: failed-step text was already uploaded and served by the incremental step-log endpoint. The formerly misleading `/runs/:id/jobs/:job/logs` path now returns `{logs: [{job, step, seq, text}]}` and the run page links to it. Unknown run suffixes return 404. Job and canonical run reads drain every retained log page. Logs are already masked and stored by job/step/sequence in the DO (or archived in R2); reads reuse that data. Responses remain `no-store` because active logs grow and access is viewer-dependent. No clone, parse, or analysis is recomputed on a log read.

`actions/setup-node` executes pinned upstream v4/v5/v6 bundles in the companion CLI; downloads and PATH propagation are supported. There is no artifact-upload or dependency-cache backend. `actions/upload-artifact` and `actions/cache` fail, as do enabled `cache` inputs on setup-node/setup-go. Omit the cache input or set it to `false` to run without caching. A workflow's explicit `continue-on-error` policy still applies to the failed step. A CLI release and a runner process restart on bugsy/demon are required after upgrading the binary; the site PR makes the job-log URL reachable.

The canonical shared support contract is `lib/actions/support.ts`. `scripts/generate-api-client.mjs <cli-root>/src/api` copies it deterministically to `<cli-root>/src/actions/support.ts` with the generated-file header; edit the website source, not that output. The `{ error, warnings }` return shape and runner protocol schema 1 remain unchanged. Unsupported artifact/cache actions now set `error`, rather than advertising a successful no-op. Import reports retain their existing `warnings` array and include these explicit unsupported errors with the workflow filename; importing a workflow does not execute it or promise success. The CLI retains its local runtime rejection boundary for jobs accepted by older servers.

-codex
