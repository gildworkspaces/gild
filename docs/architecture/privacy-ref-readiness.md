# Ref readiness independent of HTML rendering

A real fb26 privacy regression reproduced the hosted step 25 failure: the first README contents GET returned typed Pending 503 instead of 200 after a completed push. Retained source data showed that the new content snapshot and blob already existed and the source index was ready. The primary prepared-ref receipt still contained the previous main tip with pending 1. The observed push fence was acknowledged only inside the HTML projection path, whose missing-render-queue branch returned before acknowledgement.

RepoIndex now acknowledges observed ref targets at completed background indexing before its normal listing/ref publication. Rendering retains the same shared acknowledgement function. A newer/unobserved branch or metadata target remains fenced, and deletion is acknowledged only when that ref is absent in the authoritative index. Primary policy and captured D1 epoch publication guards remain unchanged. No GET creates or repairs a projection, and no queue, private access, timeout or schema is bypassed.

## Validation

- Baseline `node scripts/api-local.mjs --privacy` reproduced the exact 503/200 README assertion. Hosted log was read once from Ava's saved file; its SHA256 is 5cda3ff6bc6205fee3e78d46f0bb5e5f47db1d7513836abadbb560f840c52b32.
- Full existing privacy suite passes on the repair, retaining 105 route/210 representation checks, actual disposable Git credential-helper clones, private reader/writer/member/agent matrix, direct metadata fences, immediate revocation, listing failures, events and search protections.
- Added real post-push assertions: source ready, no render queue, pending 0, published main SHA exactly the pushed immutable tip, exact first README bytes and zero Git requests during that contents GET. Actual DO acknowledgement probe preserves unobserved main/_meta targets and an unobserved existing-branch deletion; an observed absent deletion is cleared.
- Omitting the completed-index acknowledgement fails pending 1 versus 0. Removing the observed-target guard fails the retained-fence assertion. Restoring source passes the full privacy suite. Scoped TypeScript passes.
- Restored local contents GET timing: first 51ms, repeat 57ms. These are Worker fixture measurements, not production website/SSR or real provider/VM acceptance.

## Recording scope and ownership

Prioritize the coherent recording candidate and actual package/skills, HOST/VM runtime observations/results, repository/private audience and navigation acceptance. Unrelated API breadth is deferred to issue followups. The separate Restore Gild website navigation task owns rich search, menus, header and browser-viewer SSR/first-paint work; this repair changes none of those UI files. Existing canonical SessionRuntime can be reported by the CLI without adding a schema/control plane. Current receipt audience follows repository readership and must not be advertised as an independent owner/agent-private result audience.

This source repair does not authorize or establish merge/deployment/release or live provider/VM execution. Ava owns the next corrected-head hosted CI watch and promotion coordination.
