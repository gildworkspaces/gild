# Self-hosting gild

gild.gg is the hosted forge, but the system is designed to be run by anyone
who wants their own — the same way the runners are self-hosted by default.

## The rule

Every platform dependency lives behind the backend port in `lib/backend.ts`.
Cloudflare is one driver of it, not the foundation.

## What self-hosting needs

| piece | gild.gg (Cloudflare) | self-hosted |
|---|---|---|
| the app | OpenNext → Workers | `next start` (any Node host) |
| git storage | Artifacts | bare repos on disk + `git http-backend` |
| live buffers (challenges, run logs) | D1 (SQLite on CF) | SQLite file |
| CI events | Queues + Workflows | in-process queue |
| claim ledger | git repo on Artifacts | a git repo on disk |

The metadata model (`_meta` branch), identity (keys, claims, delegations) and
runner protocol are identical on both drivers — a repo moves between hosted
and self-hosted with `git clone` / `git push`, because everything that matters
is in the repo.

## Status

Today the app runs the `memory` driver (in-process, demo-stage). The local
disk driver lands with the git round-trip work; the Artifacts driver lands
when the Cloudflare account is wired in.
