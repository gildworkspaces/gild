# Latest sidebar intent and Menu handoff correction

This addresses two bounded findings on `2069fc6`: a concurrent render could overwrite a newer real bootstrap click, and the React outside-pointer handler could close then reopen Menu. It does not claim broad website speed, cold-tail or deployment acceptance.

The bootstrap now records its latest actual intent outside React-owned DOM. Sidebar consumes that intent in its layout handoff before yielding event handling, updates state before paint, and consumes the record so a later mount cannot reuse a stale click. React outside-pointer handling excludes the external Menu button, matching the bootstrap. Collapse, outside clicks, links and Escape retain their existing behavior.

## Genuine concurrent interaction evidence

`scripts/sidebar-handoff-local.mjs` compiles the actual production tab-client entry and Sidebar. Fixture-only instrumentation selects a real concurrent transition lane and proxies the actual React Scheduler: after Sidebar initializes, it yields and holds the original continuation. There is no Suspense remount, synthetic click, fake handler/readiness flag or router-ready wait substituted for input.

Two genuine bootstrap Menu clicks establish a prior collapsed intent while the module is held. The actual Sidebar initializer then captures collapsed; a further genuine pointer click opens the SSR rail while its render continuation is held. Releasing that continuation retains the latest open state through commit. The real Menu then closes once, and original Collapse/account navigation assertions and Pending producer recovery complete. The original 500ms/SSR/Next-render-zero assertions are unchanged; this mobile fixture is a narrow interaction proof, not broad timing acceptance.

The initial default-lane harness did not yield and timed out before any test click. That setup failure is retained and excluded. The corrected fixture explicitly selects the concurrent lane; it does not imply that every production mount pauses. A first positive without prior explicit intent is retained separately; the final collapsed-history case prevents the passive localStorage effect accidentally masking an omitted handoff.

`scripts/sidebar-handoff-revert.mjs` actually omits each source correction, rebuilds the renderer, retains all nine matching assets and executes those same interactions. Missing latest-intent handoff fails `false !== true`; missing Menu exclusion fails `true !== false`. Both are named actual interaction assertions, not setup/import errors. Finally restores/rebuilds the productive source; the complete positive passes.

Full Cloudflare build and full strict TypeScript pass. The changed-bootstrap original held-module first-click smoke is recorded in the final handoff. Both new tests are explicit API gates.

Evidence: `.tmp/fragments-review/sidebar-handoff-{collapsed-positive,removed-latest-intent,removed-menu-exclusion,restored-corrections}.{log,json}` and `sidebar-handoff-removal.json`; current controlled bundle/hash is recorded separately from production assets.

Earlier 572/774ms Pending samples, the original mobile timeout and full cold/integrated matrix limits remain recorded. These fixes are held source checkpoints; no merge, deployment, security/cache-policy change or demo readiness follows.
