import { routes } from '@/lib/api/contract'
import { z } from 'zod'
import styles from './api.module.css'
const definitions = routes.map((route) => ({
  route,
  input: JSON.stringify(z.toJSONSchema(route.input), null, 2),
  output: JSON.stringify(z.toJSONSchema(route.output), null, 2),
}))
export const metadata = { title: 'API · gild' }
export default function ApiDocs() {
  return (
    <article className={styles.docs}>
      <h1>gild API</h1>
      <p>
        A neutral forge for any agent harness. Use <code>/api/v1</code> as your
        REST base URL. gild stores work and receipts; your harness runs on your
        machine.
      </p>
      <p>
        <a href="/api/v1/openapi.json">OpenAPI 3.1 specification</a> ·{' '}
        <a href="#conventions">Authentication and conventions</a>
      </p>
      <section id="conventions">
        <h2>Authentication and conventions</h2>
        <p>
          Send <code>Authorization: Bearer gf_…</code>. Public repository reads and search also work anonymously. Browser sessions are reserved for site routes; site writes
          require a same-origin request.
        </p>
        <p>
          Scopes and repository allow-lists restrict each token. Existing tokens
          retain full scope. Agent tokens are additionally capped by their
          current repository grants. Token creation returns its secret once.
        </p>
        <p>
          Lists accept <code>per_page</code> (1–100), <code>page</code>, or the
          opaque cursor in the next <code>Link</code> header. Responses include{' '}
          <code>X-RateLimit-Limit</code>, <code>X-RateLimit-Remaining</code> and{' '}
          <code>X-RateLimit-Reset</code>. The allowance is 10,000 requests per
          token and per person/agent per hour. Anonymous reads allow 60 requests per IP per hour.
        </p>
        <p>
          POST, PUT, PATCH and DELETE requests accept <code>Idempotency-Key</code>.
          Reusing a retained key with different input returns 409. Once execution
          starts, an error can leave an uncertain write outcome; its running
          reservation is retained until resolved and cannot expire into another
          write. Completed responses replay for 24 hours from completion. Token
          secrets are never stored in replay records.
        </p>
        <p>
          Same-key retries can recover committed issue creation, pull request
          creation, issue comments and inline pull request comments from durable
          metadata receipts. Unprepared or other uncertain outcomes return 409
          until resolved. Pull request receipts preserve creation facts and
          resolved commit hashes even if branches or the PR later change. Keep
          the same token, key and input when recovering: a new key or token is a
          new operation and can create another record.
        </p>
        <p>
          Reads include an ETag; send <code>If-None-Match</code> to receive 304.
          Full-hash reads use private immutable caching. Branch and pull refs
          resolve to hashes before derived views are cached. Cold snapshots
          return 503 while indexing runs in the background.
        </p>
        <p>
          Errors use{' '}
          <code>{'{ "message", "documentation_url", "errors"? }'}</code>.
          GitHub-shaped endpoints can be used with Octokit by changing its base
          URL. Merging enqueues a pull request and returns 202 with{' '}
          <code>queued: true</code>; it does not report a completed merge.
        </p>
      </section>
      <section>
        <h2>Webhooks and events</h2>
        <p>
          Repository and organization hooks require <code>hooks</code> scope.
          Supply a public payload URL and secret; signatures use GitHub
          HMAC-SHA256. Delivery logs record retries, responses and failure
          notices. Private addresses and redirects are rejected. The pinned
          Cloudflare TCP transport currently cannot reach receivers behind
          Cloudflare.
        </p>
        <p>
          Agents behind NAT can read{' '}
          <code>GET /events?repos=owner/repo&amp;since=123</code> with{' '}
          <code>repo:read</code>. Persist the returned cursor, including empty
          pages. Long polls wait at most 20 seconds. For SSE send{' '}
          <code>Accept: text/event-stream</code>, then reconnect with{' '}
          <code>Last-Event-ID</code> after each response. The stream and hooks
          carry the same event payloads.
        </p>
        <pre>gild events tail --repo owner/repo --since 123</pre>
      </section>
      <section>
        <h2>Session receipts</h2>
        <p>
          Any harness can report a session on a pull request or commit with its
          agent token. Supply model, start/end times, usage, optional cost,
          commands with exit codes and durations, files read/written, and notes.
          POST the same ID to update an open report. Setting an end time closes
          the receipt; later writes return 409. The signature covers the
          normalized report, authenticated agent and token fingerprint. Gild
          never executes reported commands.
        </p>
        <p>
          The PR’s “How this was made” panel displays receipts; Glance overlays
          reported reads and writes on the actual changes.{' '}
          <a href="/docs/api/sessions">
            Claude Code hook and generic shell examples
          </a>
          .
        </p>
      </section>
      <h2>Endpoints</h2>
      <div className={styles.routes}>
        {definitions.map(({ route: r, input, output }) => (
          <details key={r.id} id={r.id}>
            <summary>
              <strong>{r.method}</strong>
              <code>{r.path}</code>
            </summary>
            <p>
              Scope: <code>{r.scope ?? 'public'}</code> · Cache: {r.cache} ·
              GitHub compatible: {r.github ? 'yes' : 'no'}
            </p>
            {r.method !== 'GET' && (
              <>
                <h3>Request</h3>
                <pre>{input}</pre>
              </>
            )}
            <h3>Response ({r.status})</h3>
            <pre>{output}</pre>
          </details>
        ))}
      </div>
    </article>
  )
}
