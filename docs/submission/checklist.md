# gild contest submission: checklist for Sami

The contest rules are not known yet. Everything here is written so you can fill
in the blanks once they are. `[SLOT: …]` marks a value only the rules or you
can supply.

## The package

| file | use it for |
|---|---|
| [pitch.md](pitch.md) | one line, 100 words, 300 words |
| [architecture.md](architecture.md) | "how did you use Cloudflare?" plus the diagram |
| [agents.md](agents.md) | "what does it do?" for agents, with exact commands |
| [video-script.md](video-script.md) | the 3-minute recording |
| [numbers.md](numbers.md) | every number used anywhere, with its method |
| [measurements/](measurements/) | the timing script and raw results |

## Contest rules (fill in when known)

| rule | value |
|---|---|
| Submission URL | `[SLOT: form URL]` |
| Deadline, with time zone | 14 Oct 2026, `[SLOT: time and time zone]`. Plan to submit by **13 Oct**. |
| Video length limit | `[SLOT]`. The script is 3:00; shot 4 is the first to cut. |
| Video host (YouTube, Loom, upload) | `[SLOT]` |
| Write-up length limit | `[SLOT]`. Use the 100- or 300-word pitch; architecture.md for a long form. |
| Must the source be public? | `[SLOT: yes / no / judges only]`. See "Repo visibility" below. |
| Must it use specific Cloudflare products? | `[SLOT]`. The list in architecture.md covers Workers, Durable Objects, D1, R2, Queues, Artifacts, Workers Builds, Cron, service bindings, Cache API and WebAssembly. |
| Team members and roles | `[SLOT]` |
| Category or track | `[SLOT]` |
| Contact email | `[SLOT]` |
| Anything about AI-generated code | `[SLOT]`. Answer honestly: gild was built by Sami with AI agents (Claude, Codex, Kimi) working through PRs that he reviewed. |

## Form fields, ready to paste

- **Project name:** gild
- **Live URL:** https://gild.gg
- **Tagline:** a git forge on Cloudflare Workers, built for AI agents
- **One-line description:** from [pitch.md](pitch.md), "One line"
- **Short description:** from [pitch.md](pitch.md), "100 words"
- **Long description:** from [pitch.md](pitch.md), "300 words"; add
  architecture.md if there is room
- **Try it:** `npm i -g gildforge` and https://gild.gg/avatest/moshi
- **Source:** https://github.com/gildforge/cli (public, MIT). The site:
  `[SLOT: link, if made public or shared with judges]`
- **Video:** `[SLOT: link]`
- **Cloudflare products used:** Workers, Durable Objects (8 classes, SQLite,
  alarms, hibernatable WebSockets), D1, R2, Queues, Cloudflare Artifacts,
  Workers Builds, Cron Triggers, service bindings and RPC, Cache API, static
  assets, WebAssembly in Workers

## Repo visibility (decide; nothing has been changed)

| repo | now | recommendation |
|---|---|---|
| gildforge/cli | **public**, MIT | Leave it public. It is the "try it" link. |
| gildforge/gild-site | **private**, Apache 2.0 `LICENSE` in the repo | Keep it private **unless the rules require source**. If they do, prefer the rules' private-sharing option (adding judges as collaborators) over making it public. Only make it public after the checks below. |
| gildforge/server | private | Leave it private; it is not part of the submission. |

Before making gild-site public, if you decide to:
- [ ] Run a secret scan over the **whole history**, not just the tip (for
      example `gitleaks detect` in a fresh clone). A quick pattern check of the
      current tip only matched test fixtures in the redaction tests
      (`lib/sessions.test.ts`, `lib/sessions/redact.ts`,
      `scripts/api-local.mjs`, `scripts/sessions-browser.mjs`). Confirm they
      are fake.
- [ ] Note that `lib/artifacts.ts` and `lib/repo-index-do.ts` contain the
      Cloudflare account ID. An account ID is not a secret, but it becomes
      public.
- [ ] Remove or replace `docs/self-hosting.md` (it describes an old plan; see
      architecture.md).

## Before you record and submit

1. [ ] **Main is green.** On 9 Oct 20:10 UTC, gild-site main (8791cb7) failed
       `test:channel:web`, a browser timeout that also flaked on #59. Check the
       latest run once: `gh run list -R gildforge/gild-site --branch main --limit 1`.
2. [ ] **Re-measure on 12 Oct** after the freeze:
       `node docs/submission/measurements/measure.mjs …` (see numbers.md), and
       update numbers.md and any number you paste into the form.
3. [ ] **Demo data:** create `sami/agents-lab` (`gild repo create agents-lab`),
       add 2–3 issues, and approve the demo agents (the links are in the
       demo-script PR, gild-site#68, under "Needs Sami").
4. [ ] **demon VM network survives a reboot:** `scripts/vm-network-setup.sh --persist`
       on demon (cli repo), or re-run the setup before recording shot 8.
5. [ ] **Orchestrator CLI:** `gild agent spawn-child`, `suspend` and `resume` are
       on cli main but **not in 0.6.0**. Either cut a 0.6.1 or 0.7.0 release
       before recording, or leave them out of the video (the script already
       does).
6. [ ] **Stale CLI:** `~/.local/bin/gild` on the iMac is 0.2.0 and shadows npm's.
       Move it aside before recording (`which -a gild`).
7. [ ] Record the video from [video-script.md](video-script.md), upload it, and
       paste the link above.
8. [ ] Read the pitch once out loud. Check every number against numbers.md.
9. [ ] Submit. Save the confirmation (a screenshot or the email).

## What not to claim

- Self-hosting on celld works only partly (git storage is the gap); say "in
  progress", never "self-hostable today".
- The Cloudflare OS Gatekeeper (gild-site#67) is built and tested but not
  merged, and the end-to-end agent run hasn't happened yet. Call it "built,
  being integrated".
- Org- and repo-level isolation floors in the web UI don't exist yet; floors are
  set per host in `isolation.json`.
- The macOS microVM (`vz`) backend is not built. On macOS the strongest level
  today is a container in Colima.
- Don't quote best-case page times. Use the medians in numbers.md.
