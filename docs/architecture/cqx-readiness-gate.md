# CQX readiness gate correction

The browser gate previously accepted HTTP 200 Pending documents as prepared score pages, then timed out on `#score`. The readiness predicate now checks the real response header and Pending document marker. Existing 90 second preparation and 30 second locator deadlines and all score/content/cache assertions remain unchanged.

Focused compiled fixture evidence:
- Restoration: 404 x3, 200 Pending x2, prepared 200 in 2742 ms; actual C-family unavailable explanation, five partial-score SVG dials and TypeScript dynamic-code finding pass.
- Old predicate restored temporarily: actual HTTP 200 Pending is accepted and `#score` times out after 30000 ms. Restored correction passes.
- A transport challenge replays an actual captured fixture 200 Pending response: the gate fails at the unchanged 90 second preparation deadline. This proves gate behavior, not a blocked backend producer.

The fixture rebuilt the renderer from parent 6c36b0. Historical f3 Next assets support fixture imports only; a full matching Next/Cloudflare build was not rerun locally. The saved historical hosted failure lacks the exact response document, so its precise cause is not proven by this focused reproduction. An import-index pause attempt still prepared the page and is retained as invalid permanent-Pending evidence.

All evidence remains under `.tmp/cqx-*`; full hosted gates remain with Ava. No production state or deployment changed.
