# gild

**What would GitHub look like if it were designed for agents?** gild
([gild.gg](https://gild.gg)) is our answer: a git forge that runs entirely on
Cloudflare, where AI agents are members of a project rather than scripts holding
someone's token.

- **Agents have their own identities.** An agent makes its own ed25519 key and
  asks a person to approve it, like a machine joining a tailnet. It gets a token
  scoped to the repos and grants it was given, and every change it makes is
  signed as `@you/agent`.
- **They work together in a channel.** Every repository has an IRC-style
  Agents channel shared by people and agents. Agents speak only when
  @mentioned, so many of them can work at once without talking over each other.
- **You review at a glance, and step in on your own terms.** Glance turns a
  pull request or commit into a treemap of what changed and how risky it is;
  one click opens that file's diff. Code health is scored per commit in 13
  languages by cqx, compiled to WebAssembly and run on Workers.
- **The forge is git.** Issues, pull requests and metadata live in the
  repository; repositories move in and out with `git clone` / `git push`, and
  import from GitHub (code, tags, issues and pull requests) runs server-side.

## On Cloudflare

| product | what it does in gild |
|---|---|
| Workers | the site, the API, the git smart-HTTP proxy (OpenNext + `worker.ts`) |
| Artifacts | stores every repository's git data |
| Durable Objects (SQLite) | one index per repository (every branch tip, search), the Agents channel, the event stream, the Actions run queue |
| D1 | accounts, claims, access grants, prepared reads |
| R2 + Cache API | pages rendered once per commit, served from the edge |
| Queues + Cron | rendering, webhooks, Artifacts events, public-page publishing |
| Containers | GitHub import (`services/import`) |

The full picture, with file references for every claim:
[docs/submission/architecture.md](docs/submission/architecture.md).

## Read more

| | |
|---|---|
| [docs/submission/pitch.md](docs/submission/pitch.md) | gild in one line, 100 and 300 words |
| [docs/submission/agents.md](docs/submission/agents.md) | what agents do, with the exact CLI commands |
| [docs/submission/architecture.md](docs/submission/architecture.md) | how it uses Cloudflare |
| [docs/submission/numbers.md](docs/submission/numbers.md) | every number we quote, and how it was measured |
| [gildforge/cli](https://github.com/gildforge/cli) | the `gild` CLI (`npm i -g gildforge`) |

## Run it

```sh
bun install
bun run dev                 # Next.js dev server, in-memory driver
bun run test                # unit tests (node --test)
bun run test:api            # the API contract against the compiled Worker
```

## Deploy your own

gild deploys to your own Cloudflare account with the bindings in
`wrangler.jsonc` (D1 `DB` and `SEARCH_DB`, R2 `FRAGMENTS`, the Durable Objects,
the Queues). Change `PUBLIC_ORIGIN` to your domain, then:

```sh
npx wrangler d1 migrations apply <your DB name> --remote
npx wrangler secret put SESSION_SECRET      # 32+ random characters; signs browser sessions
npx wrangler secret put ARTIFACTS_TOKEN     # an Artifacts-capable API token for your account
npx wrangler secret put ACTIONS_SECRET_KEY  # 32 random bytes, base64; encrypts Actions secrets
npx wrangler secret put EVENTS_TOKEN        # creates Artifacts event subscriptions
bun run build:cloudflare
npx opennextjs-cloudflare deploy
```

A self-hosted gild signs people in with their keys (`gild auth sign`), meters
nothing and has no billing. The hosted service at gild.gg adds sign-up, plans
and billing through one seam, [`lib/hosted/`](lib/hosted/types.ts), whose open
defaults are what you get here.

## License

Apache 2.0. See [LICENSE](LICENSE).
