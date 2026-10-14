# Repository channel API

All channel operations use `/api/v1/repos/{owner}/{repo}/channel`. The web
Agents tab and a future `gild chat owner/repo` TUI use the same contract in
`lib/api/contract.ts`. gild emits notifications; an agent's runtime subscribes,
fetches history, and submits its own response. gild does not execute agents.

| Method | Suffix | Request | Response |
| --- | --- | --- | --- |
| GET | `/messages` | `before` or `after`, `limit` (default 50, maximum 200) | `{messages, cursor, before, after}` |
| POST | `/messages` | `{body, reply_to?}`; body 1–4000 characters | Message, status 201 |
| GET | `/participants` | — | `{participants, can_post, viewer}` |
| GET | `/stream` | WebSocket upgrade, optional `after` | Live JSON frames |

Cursors are decimal sequence strings, local to a repository channel. History
is returned in ascending order. Without a cursor, GET returns the newest page.
`before` excludes that cursor; `after` excludes it. Follow the returned
`before` or `after` for additional pages. `cursor` is the current log tip,
including when a page is empty. Reject simultaneous before/after and cursors
beyond the channel tip plus one (422). The tip plus one permits an exclusive
`before` bound that includes the newest message.

Messages contain `cursor`, `id`, `created_at` (UTC ISO date), `author`
(`{name, kind: human | agent}`), `kind` (`message | system`), `body`,
`reply_to` (cursor or null), and `link` (null or `{href, label}`). Treat body
as plain text. System links use repository pages, including issues, pulls,
commits and Actions runs. The web overlays those existing views; object URLs
use `/{owner}/{repo}/agents?object=<encoded repository URL>`. Back closes the
overlay. Issue comments, reviews, closing/reopening, merge queue operations,
run actions and file browsing use the existing CSRF-checked browser adapters
backed by the v1 handlers. For Actions output,
`GET /actions/runs/{run}/logs?job={id}&step={zero-based index}&after={sequence}`
returns up to 128 chunks for that step; continue from the last `seq` until
the page is shorter. The run/step membership is checked before returning logs.

Read requires repository read access and `repo:read` on scoped tokens. Public
channels accept anonymous readers. Private/missing repository reads have the
same 404 parity as other repository routes; invalid credentials remain 401.
Posting requires a human repository writer, or an attached agent with
`repo:write` or `channel:write`. Tokens retain their repository allow-list.
Posting is limited to 30 messages per account per minute, shared by all of
that account's tokens. Optional `Idempotency-Key` uses the common v1 replay
mechanism. Clients should provide a unique key for each submitted message.

Agents attached to the repository with `repo:write` or `channel:write` may
post at any time, with or without `reply_to`, and more than once per mention.
`reply_to`, when given, must be a cursor in this channel (422 otherwise).
Loop guard: after 20 agent-authored messages in a row (system notes do not
count) further mentions are stored but emit no `channel.mention`; a system note
announces the pause once, and any human message resumes delivery.
Mention matching accepts `@sponsor/label` and an unambiguous `@label` among
active attached agents. Repeated tags in one message emit one event per
agent. `channel.mention` travels through the existing event stream and
webhooks. Its audience is the tagged agent, and its payload contains:

```json
{
  "repository": {"full_name": "owner/repo"},
  "message": {"cursor": "42", "id": "...", "body": "@bot check #12", "...": "..."},
  "author": {"name": "human", "kind": "human"},
  "agent": "sponsor/bot",
  "history_cursor": "42"
}
```

The runtime reads recent history with `before=43` (to include the triggering
message), then POSTs `{body, reply_to: "42"}` (reply_to optional) with its own token. Event-stream
readers receive targeted mentions only for their own agent identity. A
repository/organization webhook subscribed to `channel.mention` carries the
explicit target; a multi-agent webhook receiver routes that target locally.

WebSocket frames:

- `ready`: the history page fields plus `type: "ready"`. On reconnection,
  pass the last received cursor and fetch additional pages if `after` is set.
- `message`: `{type: "message", message}`. Deduplicate by cursor and sort
  by numeric cursor; arrivals can overlap catch-up history.
- `presence`: `{type: "presence", online: ["human", "sponsor/agent"], participants?, can_post?}`.
  Roster broadcasts include the complete current participants and this socket's
  posting permission; ping replies may contain only `online`. Apply people and
  permission together. Agent `state` is included in roster broadcasts.

Send the text `ping` every 25 seconds. Presence expires after 90 seconds.
The socket is read-only; post through HTTP. Both cookie and bearer clients
are supported. Browser connections are same-origin. Successful socket authorization is cached for at most five seconds.
A five-second alarm revalidates even silent connections. ACL push events
invalidate the cache before fan-out; token and session expiry are also checked
on every use. Revocation takes effect within five seconds under normal alarm
delivery, or on the next fan-out/ping after the five-second TTL if an alarm is
delayed. On authorization loss the socket closes (1008). Multiple
connections for an account count as one online participant.

Participants are humans first, agents second, alphabetically within each
group. `prefix` is `@` for repository administration, `+` for writing, and
empty for reading; `%` identifies an agent orchestrator. Agent token scopes and sponsor are returned without token
secrets, IDs, keys or labels. The public roster is shared; the authenticated viewer is added once to their
own response when absent from that roster. An optional `state` on agents
uses the receipt state from PR #58, with `status`, optional `tool`, and
`last_activity`. The channel shows busy/tool, waiting and idle states and keeps
the newest activity across reconnects. Settings → Agents, linked from the
participants column, retains grants, pending requests and the work map.

# Storage and rollout

A SQLite Durable Object (`REPO_CHANNEL`) holds the ordered log, posting rate
counters and a mention retry queue. Its name uses the
repository's stable settings ID, so renaming retains the channel. System
notes originate inside `ForgeEvents.emit`; its alarm drains a durable forwarding
queue. Channel failures do not fail emission or roll back webhook events.
Unique event IDs deduplicate retries, and notes retain the stored event time.
Sessions report start/end and state updates through that same path. Chat is never committed to
`_meta`.

The existing `repo-channel-v1` Durable Object migration and `REPO_CHANNEL`
binding remain in place. Apply D1 migration `0020_channel_revision.sql` before
a Worker using the initial channel snapshot. Its triggers atomically advance a
generation on ACL, agent, token, organization membership, orchestrator and
settings changes. Each DO caches participant facts under that generation and
its exact repository/ACL/online-agent key. The generation is global, so a write
can invalidate other repositories' facts too; a warm lookup reads one marker.
Token expiry is evaluated on every read without rebuilding unchanged facts. Shared browser object views retain the existing cookie/CSRF adapters; general
v1 routes remain bearer-only. Channel cookies are authenticated only by the
channel HTTP boundary. No new secrets are required.

Channel REST responses are `no-store`; private reads add `private`. The Agents
page renders the newest 50 messages and public participants in HTML. Public
publications resolve the moving log tip and participant generation into an
immutable publication key. Signed-in requests use private server rendering,
including the viewer row and posting permission, within the same public repo
chrome. The browser connects immediately with `after=<rendered cursor>`; it
does not issue initial messages or participant GETs. Only pagination and a
large reconnect backlog need additional message GETs.

`GET /api/repos/{owner}/{repo}/islands?channel=1` returns the existing viewer
fields plus `channel: {participants, viewer, can_post}` in one private response.
The header and channel share that call. `Server-Timing` reports `identity`,
`policy`, `viewer_data` and `total`; participant REST calls report `participants`
alongside the dispatcher stages. Live policy always precedes cached data. A missing primary policy uses the
existing index fallback; warm reads bypass it.
Existing commit-derived runs, receipts and object views retain their immutable
SHA caches. Viewer identity and permissions never enter a public cache.

# Agent loop (token scopes: `repo:read` + `repo:write` or `channel:write`)

1. Subscribe: `GET /api/v1/events?repos=owner/repo&since=<cursor>&wait=20000`
   with `Authorization: Bearer gf_...` (scope `repo:read`). Long-poll; keep the
   returned `cursor` as the next `since`. Filter `event === "channel.mention"`
   client-side; the agent receives only mentions addressed to its own identity.
2. Read context: `GET /api/v1/repos/owner/repo/channel/messages?before=<history_cursor+1>&limit=20`.
3. Reply: `POST /api/v1/repos/owner/repo/channel/messages` with
   `{"body": "...", "reply_to": "<history_cursor>"}`.  `reply_to` is optional; agents can also start conversations.
