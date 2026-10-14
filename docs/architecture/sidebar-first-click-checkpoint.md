# Pending sidebar first-click checkpoint

The compiled private Pending document exposed Menu before the optional React island had handlers. A controlled real `tab-client.js` delivery proved the first physical click at149ms was lost; after releasing the unchanged module, React attached but Collapse never appeared. Router `ready` was already set, so waiting for that marker would mask the interaction defect.

The shared Sidebar now sends a small trusted self-contained bootstrap with SSR chrome. It handles actual early menu toggles, outside/link/Escape close and records the user's DOM/storage intent. React starts with that exact intent and marks its committed handlers with a layout effect; the bootstrap then yields, avoiding double toggles/reset. Rendered prepared shells and the existing Next wrapper use the same Sidebar. No viewer/API/permission requests or dynamic instruction interpolation are added. The script changes client menu state only; immutable neutral artifacts and server identity remain separate.

The first function-serialization candidate captured a bundler helper and threw `__name is not defined`; that failed compiled-browser log remains evidence. The final script is a self-contained literal and the real browser verifies it without exceptions.

Evidence:

- `scripts/sidebar-first-click-local.mjs`: holds the actual compiled island module, performs ONE early Menu click, requires open/Collapse/Dashboard before release, verifies retained open state after actual React attachment, then the original close assertions and prepared recovery. Default500ms/SSR/zero-Next-render assertions remain unchanged in the shared Pending fixture.
- `scripts/sidebar-first-click-revert.mjs`: disables the actual bootstrap, rebuilds and retains the actual presentation graph; the same real early-click assertion fails (`false !== true`), not an import/syntax/missing-module error. Source restoration/rebuild passes the positive.
- Successful full build and strict types. The original desktop→mobile `signed-in-shell --pending-only` affected gate now passes once:39ms desktop/392ms mobile, initial SSR identity/sidebar, working menus, Next/render0 and prepared recovery. These single local samples do not clear original572/774ms, broader cold tails or the remaining matrix.
- Both new gates are registered in the API workflow with the correct gild-site directory; existing defaults and gates remain.

Raw evidence is `.tmp/fragments-review/sidebar-first-click-*` plus `deferred-menu-first-click.*`. The original clean306 Menu timeout and mobile-only instrumented pass remain preserved. The controlled failure establishes an early-click loss defect; it does not prove every prior timeout/pre-handler delay shares that cause. No hosted/source-review/production/deployment acceptance is claimed by local fixture results.

-codex
