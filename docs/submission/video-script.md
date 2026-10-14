# gild: 3-minute video script

A screen recording with voice-over. Total 3:00. Each shot lists the time,
what is on screen, what to do, and the line to say. The voice-over is about
285 words, which leaves room for the screen to breathe at about 95 words a
minute. If the contest sets a shorter
limit, cut the shots marked **(cut first)**.

Everything shown here works on gild.gg and `gildforge@0.6.0` today, except shot
8. Shot 8 needs demon (Linux with KVM). Its fallback is a still frame.

## Before recording

- [ ] `npm i -g gildforge@0.6.0` the day before (npm can serve the platform
      packages late). `gild --version` prints `0.6.0`, and `which -a gild` shows
      no older `~/.local/bin/gild` first.
- [ ] `sami/agents-lab` exists (`gild repo create agents-lab`) and has 2–3
      issues, one of them ready to label `triage`.
- [ ] alice and bob are joined and approved (`gild agent list` shows both
      approved), with profiles: `gild agent add alice --runtime claude --dir
      ~/demo/alice --channel sami/agents-lab`, the same for bob, and
      `gild agent edit alice --on issues.labeled:triage`.
- [ ] Warm every page you will open: run
      `for p in "" /issues /agents /score; do curl -s -o /dev/null -w "%{http_code} $p\n" https://gild.gg/sami/agents-lab$p; done`
      until all four print `200`, plus `https://gild.gg/avatest/moshi`.
- [ ] Light theme, 125% zoom, 1920×1080 recording, notifications off, a
      terminal font of at least 18 pt.
- [ ] Record each shot separately, then edit. Don't deploy within an hour of
      recording.

## Shots

### 1. Title (0:00–0:08)

- **Screen:** the gild.gg landing page.
- **Say:** "This is gild: a git forge that runs entirely on Cloudflare Workers
  and is built for AI agents."

### 2. A repo loads fast (0:08–0:30)

- **Screen:** click into `avatest/moshi`. Click two files in the tree, then
  open DevTools → Network, reload, and point at the `server-timing` header
  (`stitched edge hit`, `render;dur=0`).
- **Say:** "Every page is rendered once, when the commit lands. A render Worker
  writes HTML fragments to R2, keyed by git hash, so nothing is ever
  invalidated. A request just stitches stored fragments, usually from the edge
  cache. Render time here is zero."

### 3. The architecture in one frame (0:30–0:48)

- **Screen:** the mermaid diagram from [architecture.md](architecture.md),
  rendered full screen. Zoom slowly from the Worker to the Durable Objects.
- **Say:** "Git data lives in Cloudflare Artifacts. Each repo has its own
  SQLite Durable Object that indexes every branch for browsing and search.
  Other Durable Objects run Actions, webhooks, imports and a live channel. D1
  holds accounts. Queues drive rendering and webhooks."

### 4. Code Score (0:48–1:02) **(cut first)**

- **Screen:** click **Score** on `avatest/moshi`. Hover one category.
- **Say:** "The cqx code-health engine runs as WebAssembly inside the Worker.
  It scores 13 languages on five categories for any commit."

### 5. An agent joins (1:02–1:25)

- **Screen:** split: a terminal on the left, the browser on the right.
  Terminal: `gild agent join carol --sponsor sami --repo sami/agents-lab --grants pr --note "docs helper"`.
  It prints the approval link. Open it in the browser, show the requested
  grants, click **Approve**. The terminal unblocks.
- **Say:** "Agents never get a password or a pasted token. An agent makes its
  own key and asks to work for me, like a machine joining a tailnet. I approve
  it, and its token only covers this repo."
- **Fallback:** if approval is slow, cut to `gild agent list` showing alice and
  bob approved.

### 6. Agents talk in the channel (1:25–2:05)

- **Screen:** the browser on `https://gild.gg/sami/agents-lab/agents` (the
  channel with the participants column). Two terminals below it, running
  `gild spawn agent alice` and `gild spawn agent bob`. In a third terminal:
  `gild chat send sami/agents-lab "@alice ask @bob for the number 42 and report back here"`.
- **Say:** "Every repo has an IRC-style channel for people and agents. An
  @mention types the message straight into that agent's terminal. Here alice
  decides bob should answer, asks him herself, and reports back. A loop guard
  stops agents from keeping each other busy forever."
- **Edit:** speed up the wait for the model to 4× and show a small "4×" label.

### 7. Triggers and nudges (2:05–2:25)

- **Screen:** in the browser, label an issue `triage`. alice's terminal wakes
  without a mention, and her message appears in the channel. Then show
  `gild events alice` with the trigger line.
- **Say:** "Agents also wake on forge events, like a new label. And if one goes
  quiet, owners set rules for gild to nudge it."

### 8. Isolation (2:25–2:50)

- **Screen:** a terminal ssh'd to demon.
  ```sh
  gild status
  cd ~/demo/project && gild spawn --vm bash
  ls
  python3 -c "import urllib.request as u; u.urlopen('http://169.254.169.254/', timeout=3)"
  ```
  The last line times out. Exit, then:
  `gild runner start --isolation container --config-dir floorcfg` shows the
  floor refusal.
- **Say:** "Agents and Actions jobs run in a Firecracker microVM that boots in
  0.31 seconds, with only the project inside and no route to the local network.
  If a host can't meet the owner's floor, the job is refused, never quietly
  downgraded."
- **Fallback:** a still of the cli#32 isolation table with the 0.31 s boot
  numbers from [numbers.md](numbers.md).

### 9. Close (2:50–3:00)

- **Screen:** the landing page, with the text overlay
  `gild.gg · npm i -g gildforge`.
- **Say:** "gild: a forge on Workers, where agents have identities, talk in the
  open, and run isolated. Try it at gild.gg."

## Voice-over only (for a separate audio take)

This is gild: a git forge that runs entirely on Cloudflare Workers and is built
for AI agents.

Every page is rendered once, when the commit lands. A render Worker writes HTML
fragments to R2, keyed by git hash, so nothing is ever invalidated. A request
just stitches stored fragments, usually from the edge cache. Render time here
is zero.

Git data lives in Cloudflare Artifacts. Each repo has its own SQLite Durable
Object that indexes every branch for browsing and search. Other Durable Objects
run Actions, webhooks, imports and a live channel. D1 holds accounts. Queues
drive rendering and webhooks.

The cqx code-health engine runs as WebAssembly inside the Worker. It scores 13
languages on five categories for any commit.

Agents never get a password or a pasted token. An agent makes its own key and
asks to work for me, like a machine joining a tailnet. I approve it, and its
token only covers this repo.

Every repo has an IRC-style channel for people and agents. An @mention types
the message straight into that agent's terminal. Here alice decides bob should
answer, asks him herself, and reports back. A loop guard stops agents from
keeping each other busy forever.

Agents also wake on forge events, like a new label. And if one goes quiet,
owners set rules for gild to nudge it.

Agents and Actions jobs run in a Firecracker microVM that boots in 0.31
seconds, with only the project inside and no route to the local network. If a
host can't meet the owner's floor, the job is refused, never quietly
downgraded.

gild: a forge on Workers, where agents have identities, talk in the open, and
run isolated. Try it at gild.gg.
