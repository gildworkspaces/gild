#!/bin/sh
# Revert proofs for the workerd contract tests: each case removes one guard from a scratch copy of
# src/, runs the suite, and requires it to FAIL. Restores src/ afterwards. Run from the package
# directory inside a cloudflare-os checkout.
set -u
cp -R src .revert-src-backup
status=0
prove() {
  name=$1; file=$2; from=$3; to=$4
  rm -rf src && cp -R .revert-src-backup src
  python3 - "$file" "$from" "$to" <<'PY'
import sys
p, a, b = sys.argv[1:]
s = open(p).read()
assert a in s, f"pattern not found in {p}: {a}"
open(p, "w").write(s.replace(a, b, 1))
PY
  if pnpm exec vitest run -c vitest.worker.config.ts > .revert-$name.log 2>&1; then
    echo "REVERT $name: suite still PASSES -- the tests do not guard this"; status=1
  else
    echo "REVERT $name: suite fails as it must: $(grep -E 'Tests +[0-9]' .revert-$name.log | tail -1 | sed 's/\x1b\[[0-9;]*m//g')"
    grep -E '×' .revert-$name.log | sed 's/\x1b\[[0-9;]*m//g' | sed 's/^/    /'
  fi
}
# 1. Writes go to gild at submit time instead of waiting for approval.
prove apply-at-submit src/gild-gatekeeper.ts \
  'const id = await this.#actions.submit(queue, kind, payload, { fence: { generation } });' \
  'const id = await this.#actions.submit(queue, kind, payload, { fence: { generation } }); await this.#actions.apply(id, { generation }).catch(() => {});'
# 2. Rejecting an action applies it instead.
prove reject-applies src/gild-gatekeeper.ts \
  'await this.#actions.reject(action);' \
  'await this.#actions.apply(action, { generation: (await this.#api()).generation });'
# 3. No narrowing: any repository URL on the gild origin attaches.
prove no-narrowing src/gild.ts \
  'if (repo !== s.repo.toLowerCase()) {' \
  'if (false) {'
# 4. The facet trusts its props instead of the connection's repository.
prove facet-trusts-props src/gild-gatekeeper.ts \
  'if (creds.repo.toLowerCase() !== this.#repo().toLowerCase()) {' \
  'if (false) {'
# 5. The join flow skips proving the key.
prove unsigned-join src/join.ts \
  'origin, `/api/agents/requests/${encodeURIComponent(join.requestId)}/token`, { signature });' \
  'origin, `/api/agents/requests/${encodeURIComponent(join.requestId)}/token`, { signature: "" });'
rm -rf src && mv .revert-src-backup src && rm -f .revert-*.log
exit $status
