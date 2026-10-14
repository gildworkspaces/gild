# Session runtime observations

This is optional telemetry for the existing repository-scoped agent roster.
The user's MAIN machine owns CLI coordination and execution. Website reporting
may be unavailable without preventing a local task or result. These observations
are reports, not execution authority, configured policy or an isolation certificate.

Canonical source: `lib/api/sessions-contract.ts`. `SessionInput` and `Receipt`
add optional `runtime`; existing methods/scopes remain unchanged. Generate the
CLI artifact with `node scripts/generate-api-client.mjs <owned staging>/src/api`.
The output `src/api/sessions-contract.ts` is the exact source plus the existing
header. `channel-contract.ts` adds an optional `session` projection to roster
participants; no parallel task protocol or database migration is introduced.

```json
{
  "mode": "VM",
  "worker": {
    "id": "5e88ffcb-2a57-4d03-802f-99d4f8d4d380",
    "name": "Demo worker"
  },
  "host": {"os": "linux", "version": "6.12.112"},
  "guest": {"os": "Ubuntu", "version": "24.04.5 LTS"},
  "observed_at": "2026-10-12T18:00:00Z"
}
```

The worker supplies observations after actual child launch; the main coordinator
forwards them. `worker.id` is a persistent opaque UUID, never an IP or hostname.
`worker.name` is an explicit friendly label, not a discovered address or path.
Host OS is `linux`, `macos`, `windows` or `freebsd`; its observed version is
optional. VM `guest` is required and may be **null**, meaning not observed.
HOST forbids `guest`. Unknown guest data must never come from a configured image
label. All nested objects are strict. Display/version fields reject paths,
addresses and credential-like text. Do not report private content or credentials.

Receipt ownership, repository/target access, revision and closed-session fences
remain in `sessionHandler` and `SessionStore`. Start time and mode/worker/host
identity are immutable once reported. A null VM guest may become observed once;
a known guest cannot change or disappear. Dates are compared as parsed instants,
so equivalent ISO fractional precision remains compatible. Older clients may
omit runtime; updates preserve a previously stored observation.

`RepoIndex.sessionPut` emits the existing session event with a safe projection:
`id`, `started_at`, `ended_at`, `updated_at`, `version`, `closed` and optional
`runtime`. `RepoChannel.system` writes the existing `channel_states` JSON under
its existing transaction. A later start replaces an older session; late ending
of an older session cannot replace the current one. Within a session, versions
must increase and stopped sessions cannot revive. Ambiguous equal-start sessions
keep the established slot. Old state-only rows/events remain readable until a
bound session exists; unbound events cannot erase that bound session.

The actual view is `components/repo/Channel.tsx` → expandable **Runtime profile**
→ `RuntimeObservation`. SSR initial roster and existing authenticated socket
updates carry the same projection. No global agent/repository scan or standalone
public profile route is needed. No extra filesystem/repository compute happens
on page load. The panel shows HOST/VM, machine name/UUID, observed host/guest,
stopped or last-reported running state, observation and server update time.
Client freshness ages after 90 seconds using the earlier of worker observation
and server receipt update; future worker timestamps cannot keep a dead run fresh.
Disconnected updates are labeled separately from reported process state.

This local slice does not prove actual CLI telemetry emission, a real model run,
production identity admission, network filtering, or deployed website acceptance.
Those are separate owner/integration milestones. No publication or deployment is
authorized by the draft contract.
