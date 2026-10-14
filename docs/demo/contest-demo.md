# gild contest demo (14 Oct 2026)

An 8–10 minute live demo for an audience that includes Cloudflare people.
Every beat lists what is said, what is typed or clicked, what the viewer
sees, and the fallback. Status per beat:

- **LIVE**: works today on gild.gg and the published `gildforge@0.6.0` CLI, and was
  rehearsed headless on 9 Oct (evidence at the end).
- **LANDING**: depends on a named open PR. Demo it only if that PR has merged and been
  deployed by 12 Oct (the feature freeze).
- **STRETCH**: spare lanes only. Cut it without comment if it isn't ready.

Screens referenced below are in [`shots/`](shots/) (1280×800, light and dark).

## Pre-flight (T-30 min)

| check | command | why |
|---|---|---|
| CLI installed from npm, not a repo checkout | `npm i -g gildforge@0.6.0 && gild --version` → `0.6.0` | Right after a release, npm can serve the umbrella package before the platform packages. On 9 Oct `gild` printed `no build for darwin-x64` for about five minutes after the release (cli#42). Install the day before. |
| signed in as sami | `gild auth status` | |
| demo agents approved | `gild agent list` shows `demo-alice`, `demo-bob` as approved | Approval is Sami-only (see "Needs Sami") |
| **warm every repo you will open** | `for p in "" /score /agents /actions; do curl -s -o /dev/null -w "%{http_code} $p\n" https://gild.gg/sami/agents-lab$p; done` until all are `200` | A cold repo index returns a plain-text `503 Repository is being prepared` (on 9 Oct, `sami/testing` returned it for several minutes; gild-site#63) |
| demon VM network is up | `ssh demon gild status` → `vm network: egress allowed, LAN/host/metadata denied (16 slots on gildbr0)` | The network setup is not persisted across reboots |
| browser theme | Light theme, 125% zoom, one window, signed in | The projector washes out dark mode |

## Beat 1: a Workers-native forge (0:00–1:30)

**LIVE** (gild-site#61, the static pages through edge grants, merged 9 Oct 19:47 UTC; `server-timing` now reads `stitched edge hit`)

- **Say:** "gild is a git forge that runs entirely on Cloudflare Workers:
  Durable Objects hold each repo's index, R2 holds rendered pages by content
  hash, D1 holds accounts. Public pages are rendered once per commit, at push
  time, and served from the edge."
- **Do:**
  1. Open `https://gild.gg` → the landing page with the live push lane graph.
  2. Click into a mirrored repo (`avatest/moshi`): the README and file tree load
     instantly.
  3. Open DevTools → Network and reload: the `server-timing` header and TTFB.
  4. Click **Score**: "Every repo gets a Code Score (Quality, Containment,
     Legibility, Security, Modularity) per language, at that commit."
- **The viewer sees:** `shots/home-light.png`, `shots/repo-moshi-light.png`,
  `shots/score-light.png`.
- **Numbers measured on 9 Oct** (headless Chrome from bugsy, warm):
  - repo home: TTFB 100–180 ms, FCP 250–285 ms;
  - Score: TTFB 100–160 ms, FCP 135–210 ms;
  - landing page: TTFB 150–240 ms.
- **Fallback:** if a page is slow or returns 503, switch to a pre-warmed tab of
  the same page. Never reload on stage. **Never deploy within an hour of the
  talk:** after the #61 deploy, `avatest/moshi/agents` returned 503 for about a minute
  while the index was cold (gild-site#63). The numbers above were measured
  before #61 deployed; re-measure on 12 Oct.

## Beat 2: agents are first-class (1:30–4:30)

### 2a. Join and approval (LIVE, needs Sami's approval click)

- **Say:** "An agent never gets a password or a pasted token. It asks to work
  for you, like a machine joining a tailnet, and you approve it."
- **Do** (terminal, agent's private HOME):
  ```sh
  gild agent join alice --sponsor sami --repo sami/agents-lab --grants pr \
    --note "triage bot for the demo"
  # → Asked @sami to approve @sami/alice.
  #   Approve here: https://gild.gg/agents/approve/<id>
  ```
  Open the link in the browser, review the requested grants, and click Approve.
  The terminal unblocks and prints the agent as approved.
- **The viewer sees:** the approval link. Signed out, it opens the key-based
  sign-in (`shots/approve-light.png`); that page has no password field.
- **Fallback:** pre-approve `demo-alice` and `demo-bob` before the talk and show
  `gild agent list` instead of waiting on a live approval.

### 2b. The repo channel (LIVE, gild-site#55)

- **Say:** "Every repo has an IRC-style channel. People and agents are
  participants; `@` marks admins and `+` marks writers. Agents speak only when
  tagged."
- **Do:** open `https://gild.gg/sami/agents-lab/agents`. In a second terminal:
  `gild chat raw sami/agents-lab` (live JSON frames).
- **The viewer sees:** the channel with the participants column
  (`shots/agents-tab-light.png`) and raw frames in the terminal.
- **Fallback:** `gild chat history sami/agents-lab`.

### 2c. @mentions and handoffs (LIVE, cli 0.6.0)

- **Do:**
  ```sh
  gild agent add alice --runtime claude --dir ~/demo/alice --channel sami/agents-lab
  gild agent add bob   --runtime claude --dir ~/demo/bob   --channel sami/agents-lab
  gild spawn agent alice     # terminal 1
  gild spawn agent bob       # terminal 2
  gild chat send sami/agents-lab "@alice ask @bob for the number 42 and report back here"
  ```
- **The viewer sees:** alice wakes, posts "@bob what is the number?", bob
  wakes and answers, and alice reports back. Each step appears in the web
  channel, the `chat raw` stream and both terminals.
- **Say:** "That's a handoff. alice decided bob should answer and started the
  conversation herself. A loop guard pauses delivery after 20 agent-only
  messages in a row until a human speaks."
- **Fallback:** if a model is slow, narrate from `gild events alice`
  (received → queued → delivered).

### 2d. Label triggers (LIVE, cli 0.6.0)

- **Do:** `gild agent edit alice --on issues.labeled:triage`, then label an issue
  `triage` in the web UI.
- **The viewer sees:** alice wakes without being tagged, reads the issue and
  hands it to `@bob` in the channel.
- **Fallback:** show `gild events alice` with the trigger event.

### 2e. Nudges (LIVE, cli 0.6.0)

- **Say:** "Agents stall. gild knows when one is idle, so owners set watchdog
  rules."
- **Do:** `gild spawn --nudge "idle:2m:1:status update please?" agent bob`, then
  leave bob idle.
- **The viewer sees:** after 2 minutes the nudge is typed into bob's terminal
  and shows in `gild status bob`.
- **Fallback:** use `idle:20s:1:…` so the nudge fires on stage.

## Beat 3: an orchestrator agent (4:30–5:45)

**Partly LIVE.** The server grant, `spawn-child` and suspend/resume are
LANDING in gild-site#62 plus cli branch `claude/orchestrator-cli` (no PR yet
on 9 Oct). Per the cut line, demo plain agents if #62 isn't green by 12 Oct.

- **Say:** "An agent granted *orchestrator* can bring up other agents, take
  them offline and read the raw channel."
- **Do (LIVE today, local):**
  ```sh
  gild spawn --detach --name worker-1 agent bob   # no TTY, prints the session id
  gild sessions                                     # lists worker-1
  gild send worker-1 "summarise open issues"
  gild attach worker-1                              # watch it, Ctrl-] to leave
  gild stop worker-1                                # hang up, print its exit
  ```
- **Do (LANDING #62):** `gild agent spawn-child …`, `gild agent suspend …`
  (the child disappears from the participants list), `gild chat raw` showing
  the mention delivery states.
- **Fallback:** the local detach/attach/stop sequence alone carries the beat.

## Beat 4: Actions and agents in microVMs (5:45–8:00)

**LIVE on demon (Linux, Firecracker), cli 0.6.0. Run from a terminal ssh'd to demon.**

- **Say:** "Actions without isolation are useless. gild runners pick the
  strongest isolation the host has: a Firecracker microVM, then a container,
  then a dedicated OS user. If none is available they refuse; they never
  quietly run unisolated."
- **Do:**
  ```sh
  gild status
  # vm network: egress allowed, LAN/host/metadata denied (16 slots on gildbr0)
  # isolation backends available: vm, container
  # isolation: vm (firecracker), requested by auto
  cd ~/demo/project && gild spawn --vm bash
  ```
  Then, inside the VM:
  ```sh
  ls                                   # only the project directory is mounted
  cat ~/.ssh/id_demo                   # No such file or directory
  python3 -c "import urllib.request as u; u.urlopen('http://192.168.1.107:18197/', timeout=3)"
  # → URLError timed out (LAN blocked)
  python3 -c "import urllib.request as u; u.urlopen('http://169.254.169.254/', timeout=3)"
  # → timed out (metadata blocked)
  ```
- **Levels and floors:**
  ```sh
  gild status --config-dir floorcfg            # isolation floor: vm
  gild runner start --isolation container --config-dir floorcfg
  # isolation "container" (from flag) is below this host's floor "vm"
  ```
  **Say:** "The most specific request wins, but it can never go below the
  owner's floor. A run that can't meet the floor is refused and never quietly
  downgraded."
- **The viewer sees:** the guest boots in about 2.6 s, the host secret is missing,
  LAN and metadata time out, and the floor refusal names the reason.
- **Known gaps (do not show):**
  - Change sync-back fails with the current spike rootfs: `gild sync` returns
    `unknown variant 'list'` because the guest agent baked into the rootfs
    predates 0.6.0. Rebuild the rootfs before the talk (cli#39).
  - `--detach` with `--vm` is not supported yet (cli#40).
  - The guest image has no `curl`; use python3 as above.
  - `ls` in the guest shows `lost+found`.
- **Fallback:** the screenshot of `docs/actions/screenshots` plus the cli#32
  isolation matrix (host / container / vm × LAN, metadata, VM-to-VM).

## Beat 5: self-hosted on celld (8:00–8:45)

**STRETCH** (brief `gild-celld-selfhost.md`; spike on demon)

- **Say:** "Self-hosted gild is not a separate edition. It is the same Workers
  build, running on celld, a self-hosted Workers and Durable Objects runtime.
  Same wrangler config, your hardware."
- **Do:** open the celld-hosted instance on demon next to gild.gg and show the
  same repo page.
- **Fallback:** cut the beat. Never show `docs/self-hosting.md`; it still
  describes the older `next start` plan.

## Beat 6: Cloudflare OS agents through a gild Gatekeeper (8:45–9:30)

**STRETCH** (brief `gild-cfos-gatekeeper.md`)

- **Say:** "Cloudflare OS Gatekeepers give agents narrow, logged,
  async-approved access to an outside service. Ours wraps gild's `/api/v1`, so
  a Cloudflare OS agent can open a PR on gild and its actions show up in the
  channel for approval."
- **Do:** a Cloudflare OS agent opens an issue through the Gatekeeper, and it
  appears in the gild channel as a system note.
- **Fallback:** cut it, or describe it in one sentence as "next".

## Close (9:30–10:00)

"A forge built on Workers, where agents have identities, talk in the open,
and run in microVMs. `npm i -g gildforge`."

## Rehearsal log: 9 Oct 2026 (Claude lane, headless)

| beat | result |
|---|---|
| CLI install from npm | `gildforge@0.6.0` OK after about 5 min of npm propagation (darwin-x64 at first: `no build for darwin-x64`) |
| 1 landing, repo, score | 200 in both themes. TTFB/FCP above. The Actions page is slow: FCP 3.5–4.2 s (gild-site#65). React hydration error #418 in the console on `/` and `/sami` (gild-site#66) |
| 1 cold repo | `sami/testing` returned plain-text `503 Repository is being prepared` from 19:24 for several minutes, then recovered |
| 2a join | `gild agent join demo-alice/demo-bob --sponsor sami --repo sami/testing` filed two approval links; the approve page signed out shows key sign-in |
| 2b channel | Anonymous API and WebSocket reads OK; the CLI still demands an identity for them (cli#41). The web tab shows `connecting` for a few seconds after load, then `live` (the screenshots caught it early) |
| 2c–2e, 3 local | trigger, nudge, chat-mention and detach (`no-tty`, `send`, `attach`, `stop`) harnesses all pass against the published 0.6.0 binary with the fixture agents (fake forge) on demon |
| 4 microVM | `vm-spawn-harness` passes (ready in 1.26 s). Live proof: host secret absent, LAN and metadata time out, internet reachable. Floor refusal OK. `gild sync` fails (stale guest agent in the rootfs) |
| 404s | A missing repo, and since #61 a missing owner, returns a bare `text/plain` `Not found` (gild-site#64). Avoid typing URLs on stage. Signed-out `/settings/*` and `/orgs/*/settings` drew two headers and two footers (`shots/before-fix-404-settings-dark.png`). Fixed in this PR |

## Needs Sami

- Approve the rehearsal agents: <https://gild.gg/agents/approve/507d0b07a04543e5805c>
  (demo-alice) and <https://gild.gg/agents/approve/353275933ab94b44a79e> (demo-bob).
- Create `sami/agents-lab` (`gild repo create agents-lab`); the demo repo does not exist yet.
- Persist the demon VM network: `scripts/vm-network-setup.sh --persist`.
