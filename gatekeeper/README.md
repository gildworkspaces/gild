# gild Gatekeeper for Cloudflare OS

A Cloudflare OS Gatekeeper (one Worker) that gives agents and gadgets narrow, logged,
approval-gated access to **one gild repository**. The contract it implements, with references into
cloudflare-os, is in [`../docs/cloudflare-os-gatekeeper.md`](../docs/cloudflare-os-gatekeeper.md).

This folder is a cloudflare-os package (`@gadgets/gild-gatekeeper`). It builds and tests only
inside a cloudflare-os checkout, which is why gild-site's own `tsconfig.json` excludes it.

## Install into a cloudflare-os checkout

```sh
rsync -a gatekeeper/ <cloudflare-os>/packages/gatekeeper-gild/
cd <cloudflare-os>
pnpm install
pnpm configs:generate                       # writes packages/gatekeeper-gild/wrangler.jsonc
(cd packages/gatekeeper-gild && pnpm exec wrangler types --include-runtime=true worker-configuration.d.ts)
```

`pnpm dev-server` / `pnpm run-local` then discover and bind it like every other Gatekeeper. It
talks to `https://gild.gg` unless the worker's `GILD_URL` names another gild (a self-hosted one, or
the local fake below). To pass `GILD_URL` through `pnpm run-local`, a fork adds one line to
`PASSTHROUGH_GATEKEEPER_VARS` in `scripts/run-dev-server.ts`:

```ts
"gatekeeper-gild": ["GILD_URL"],
```

No secrets and no OAuth application are needed.

## Connecting

"Connect gild" opens a page that runs gild's agent join flow: name yourself (the sponsor), the
repository, an agent name, and what it may do (`pr`: issues, PRs, comments, pushes; `review`;
`queue`). Cloudflare OS files the request with its own ed25519 key and shows the approval link;
approve it on gild.gg and the page finishes connecting. Already joined with
`gild agent join <label> --sponsor <you> --repo <owner/name>`? Paste `gild agent token <label>`
instead. Then attach the repository by pasting its URL, e.g. `https://gild.gg/sami/testing`.

## What the agent gets

`GildRepo` (see `src/types.d.ts`): reads of metadata, branches, commits, files, issues, pull
requests (diff, reviews, comments, cqx code score) and the channel; writes `createIssue`,
`updateIssue`, `comment`, `commitFiles`, `createPullRequest`, `postToChannel`. Every write is
queued for approval in Cloudflare OS and simulated immediately.

## Tests

```sh
cd <cloudflare-os>/packages/gatekeeper-gild
pnpm exec vitest run                               # git objects and packs, checked against real git
pnpm exec vitest run -c vitest.worker.config.ts    # the facet against a fake gild, in workerd
sh scripts/revert-proofs.sh                        # each guard removed -> the suite must fail
```

## Local demo without an approved identity

`scripts/fake-gild-server.mjs` is an in-memory gild for one repository (join requests are
auto-approved, receive-pack moves branches without storing objects). Every request is logged, so a
run shows exactly what the Gatekeeper sent and when:

```sh
node packages/gatekeeper-gild/scripts/fake-gild-server.mjs --port 8799 --repo sami/testing &
GILD_URL=http://localhost:8799 pnpm run-local --port 8792
```
