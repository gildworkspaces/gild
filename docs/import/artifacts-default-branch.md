# Import bootstrap and Git HEAD

Imports create Artifacts repositories with the valid default `main`, but seed
only the forge's `_meta` branch. No synthetic code commit or `main` ref exists.
The importer pushes the source refs, then sends its source default to the finish
endpoint. Gild persists that default for repository reads, indexing, and Git
advertisements.

A physical HEAD that names unborn `main` causes isomorphic-git to reject even an
explicit `_meta` clone or immutable object fetch: its fetch implementation tries
to resolve remote HEAD. The metadata HTTP adapter supplies `_meta` as HEAD in the
small ref advertisement. It never consumes pack responses. The public Git proxy
advertises the source default, adding HEAD when absent and resolving unborn HEAD
in Git v2. HEAD-only v2 discovery also requests the selected branch's oid.

## Local evidence

- `bun run test:import` imports a fixture whose default is `master` and has no
  `main`. The finished repository has no synthetic `main`; its code page serves
  `README.md`; native clones using Git protocols 0 and 2 check out `master` at
  the source tip. HEAD-only discovery also reports `master` in both protocols.
- `bun run test:import:revert -- --artifacts-default` rebuilds with the original
  `_meta` creation argument and fails import creation with HTTP 503 and exactly
  `Invalid default_branch: Invalid branch name`. It restores the source,
  rebuilds, and passes the Worker/browser/native-clone suite.
- The ordinary revert gate also removes missing-HEAD synthesis and the metadata
  HTTP adapter separately. Their effect tests fail, then pass after restoration.
- Explicit `/orgs/avatest/imports` is intentionally accepted for the authenticated
  user owner. Owner kind comes from storage: the fixture verifies namespace
  `u-avatest`, user ACL ownership, and rejection of another user's request.
  The CLI chooses this route whenever `--name` includes an owner.

## Live Artifacts verification: blocked

On 8 October 2026, the credential in `~/.ssh/cf_token` verified as an active user
API token, but Artifacts returned HTTP 401 `Authentication error` for all scratch
repository creation attempts. No scratch repository was created. Default-name
acceptance, physical HEAD behavior, and scratch deletion have **not** been
verified live. The local Git fixture evidence above is not a substitute.

Needs Sami: an Artifacts-capable account token in `~/.ssh/cf_token` for account
`08b93c93f8b7adc43678e9afba31e4ee`. The failed initial credential loader also
exposed the token in an error; rotate it when correcting access.

The [Artifacts REST API documentation](https://developers.cloudflare.com/artifacts/api/rest-api/)
describes the creation default and scratch deletion routes; the
[Git protocol documentation](https://developers.cloudflare.com/artifacts/api/git-protocol/)
describes repo-scoped Git tokens. Credentials belong in process environment or
request headers, never Git URLs, arguments, reports, or logs.

## Ava's verification after deployment

1. Run `gild repo import https://github.com/jonschlinkert/is-number --name avatest/is-number-3`.
2. Confirm successful completion and code at `https://gild.gg/avatest/is-number-3`.
3. Run `git clone https://gild.gg/avatest/is-number-3.git`; inside the clone,
   `git branch --show-current` must print `master` and `README.md` must contain
   the source code's documentation. Check that no synthetic `origin/main` exists.

-codex
