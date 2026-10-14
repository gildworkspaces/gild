# Agent session receipts

Any harness can report work with its approved agent token. Gild never starts an agent or executes a command from a receipt.

`POST /api/v1/repos/{owner}/{repo}/pulls/{number}/sessions` requires `pulls:write`; `POST /repos/{owner}/{repo}/commits/{sha}/sessions` requires `repo:write` and a full commit SHA. Both additionally require an authenticated, non-revoked agent and current repository grants. GET at the same paths requires `repo:read` and returns a paginated collection with Link headers.

Submit `started_at`, `ended_at` (null for an open session), `model`, `tokens_in`, `tokens_out`, optional `cost` and `currency` (USD default), `commands: [{name,exit_code,duration_ms}]`, `files: {read:[],written:[]}`, and `notes`. Paths are relative to the repository. Unknown command exit codes can be null. Omitted usage defaults to zero; explain unmeasured fields in notes. Limits: 200 commands, 1000 read and 1000 written paths, 16k notes, 256KiB request, 1000 receipts per target, **100 per agent per target** (revisions do not consume another slot). Stored commands are capped at **1024 characters**; notes at **4096**. Long or multiline commands are folded in the panel.

The agent is derived from the token, not a trusted input field. To update an open session, POST the same `id` with the full updated report. Once `ended_at` is set the receipt is closed and later writes return 409, including writes by the same agent. Concurrent updates use an atomic version check. POST returns 201 for each stored revision. An idempotency key can safely retry an uncertain POST.

All model, usage/cost, commands/outcomes/durations, file access, times and completion are **reported by the agent**, not verified execution. Responses include `reported_by: "agent"`. Agent identity is authenticated by the request; no receipt proof or signature is emitted. The old bearer-token HMAC was removed because viewers could not verify it. `token_fingerprint` was the SHA-256 token database lookup key, and `public_key` is a public identity key also used for claim lookup. Neither is included in receipt storage for new writes, receipt API responses, or the panel. A public key is not a secret, but these metadata fields do not establish evidence of execution.

Before new receipt JSON enters SQLite, the server redacts recognizable Gild/runner and GitHub tokens, AWS access keys, JWTs, credential assignments and generic high-entropy opaque strings (including unprefixed Cloudflare/AWS secrets). Commands, notes, model and file paths are sanitized. Reads also sanitize legacy rows and strip removed proof fields. Receipts are shown only after the shared repository read check; SSR additionally requires a signed-in viewer. Redaction is heuristic and is not a guarantee that arbitrary prose cannot contain a secret.

The PR's **How this was made** panel shows session times, model/usage/cost, commands with outcomes/durations, files and stored revision, with reporting labels on self-reported fields. Glance overlays reported file reads/writes on the actual diff: dotted outlines are reads, solid outlines writes. Reports do not alter the diff's heat or claim an unchanged file was changed. Commit pages show the same receipts.

## Claude Code hooks: 20-line example

[examples/sessions/claude-hook.py](examples/sessions/claude-hook.py) is a 20-line collector for the command-hook stdin fields in [Claude Code's official hooks reference](https://code.claude.com/docs/en/hooks). It records directly observed Read/Write/Edit paths and Bash outcomes when supplied, measures duration from PreToolUse, and closes on SessionEnd. It stores local state in SQLite so concurrent tool hooks do not lose records. It does not infer shell file reads or parse the private transcript format. Configure your model explicitly; usage/cost are not measured by this minimal collector.

Create a local, ignored `.gild-receipt-config.json` (no token):

```json
{"repo":"owner/repo","pull":42,"agent":"claude","model":"your-model"}
```

Add `.gild-receipts/` and `.gild-receipt-config.json` to your ignore rules. Use your own script/config paths in `.claude/settings.local.json`:

```json
{"hooks":{
  "SessionStart":[{"hooks":[{"type":"command","command":"python3 examples/sessions/claude-hook.py .gild-receipt-config.json"}]}],
  "PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"python3 examples/sessions/claude-hook.py .gild-receipt-config.json"}]}],
  "PostToolUse":[{"matcher":"Bash|Read|Write|Edit","hooks":[{"type":"command","command":"python3 examples/sessions/claude-hook.py .gild-receipt-config.json"}]}],
  "PostToolUseFailure":[{"matcher":"Bash","hooks":[{"type":"command","command":"python3 examples/sessions/claude-hook.py .gild-receipt-config.json"}]}],
  "SessionEnd":[{"hooks":[{"type":"command","command":"python3 examples/sessions/claude-hook.py .gild-receipt-config.json"}]}]
}}
```

The local `gild session record` command reads the already-approved agent credential. On upload failure, the JSON remains under `.gild-receipts` for retry. Session IDs map to stable receipt UUIDs; reopening a previously closed Claude session needs a new report ID rather than altering history.

## Generic shell wrapper

Run any local harness or command through [run-with-receipt.py](examples/sessions/run-with-receipt.py):

```sh
python3 examples/sessions/run-with-receipt.py owner/repo 42 codex model-name src/main.ts -- bun test
```

Arguments before `--` declare known reads. The wrapper records the real command exit code and duration, and detects working-tree file changes during the command, including removed files. Concurrent unrelated edits may appear; this is a report, not filesystem tracing. It preserves the command exit code and retains JSON on upload failure. Fill actual model usage/cost in your harness when available.

```sh
gild session record --repo owner/repo --pull 42 --agent codex --file receipt.json
gild session record --repo owner/repo --commit FULL_SHA --agent codex --file receipt.json
gild session list --repo owner/repo --pull 42
```

Cache decision (§7c): SQLite stores each receipt once closed. Collections remain mutable even when attached to a commit SHA, so collection responses are `no-store` with content ETags; a SHA alone does not make the receipt list immutable. Reads page through the existing repo-index DO and never clone. The panel's signed-in surrounding page remains viewer-specific. No new infrastructure binding, secret, migration tag, or deployment is required beyond Phase B; session tables are initialized in the existing repo-index DO.
