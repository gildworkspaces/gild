# Browser login and claim completion

The browser starts a challenge and receives a random 32-byte state cookie. The
cookie is `__Host-gild_auth_state` or `__Host-gild_claim_state`, with Path=/,
HttpOnly, Secure, SameSite=Strict and a ten-minute lifetime. Each flow has one
active state cookie; starting it again replaces that browser's previous state.
Only the state's SHA256 is stored, in the existing challenge JSON payload.
No migration or new deployment secret is required.

OpenNext reconstructs route URLs. The existing settingsHTTP ingress strips any
caller-supplied x-gild-browser-proof-origin header and stamps the original Worker
origin on these routes. Origin checks use that trusted value. Direct Next dev
requests use their own URL origin; the public deployment must retain this ingress.

The terminal signs the challenge with Ed25519. The status endpoint requires
the initiating browser's state and rejects cross-origin browser requests. A
conditional D1 UPDATE consumes browser completion once across Worker isolates.
Missing, mismatched, consumed, expired and legacy unbound states return 404
without a session cookie. Pending returns immediately and remains usable until
answered. Both status responses use private, no-store.

Auth completion expires five minutes after initiation. Claim completion expires
ten minutes after initiation, with five minutes to answer a pending claim.
Consumption keeps the signed challenge for the separate CLI token proof. The
CLI's challenge, answer and token JSON contracts are unchanged. A lost successful
completion response requires starting a new browser sign-in flow with the same
terminal key; it cannot replay the consumed proof to issue another session.
A completed claim keeps its name, so claiming that name again returns 409. The
claim recovery alert and failed-restart form offer explicit sign-in alongside
restart, without inferring whether the current browser owns the taken name.

The actual route regressions verify Ed25519 signatures and issued session HMACs
using disposable keys, and run against SQLite and the memory driver. The
reversion gate restores the original status routes and removes the consumption
guard separately; those checks must fail for session issuance and replay effects.

Browser status polling is sequential and cancellable. A terminal 404 stops it, explains expiration or replacement by another tab, and offers a restart action. Sign-in restarts with a new challenge; claim restart retains form input. Successful completion also stops polling, preserving the single-use session boundary. The compiled Worker Chrome regression opens two tabs in one context for both flows and verifies old-tab recovery, normal current-tab completion and replay rejection.
