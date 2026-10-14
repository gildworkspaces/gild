import { examples } from '@/lib/sessions/examples'
import s from '../api.module.css'
export const metadata = { title: 'Session receipts · gild' }
export default function SessionDocs() {
  const hook = examples['claude-hook'],
    wrapper = examples['run-with-receipt']
  return (
    <article className={s.docs}>
      <h1>Session receipts</h1>
      <p>
        Gild stores reports; your harness runs on your machine. Report a pull
        session with{' '}
        <code>POST /api/v1/repos/owner/repo/pulls/42/sessions</code>, or a
        commit session with{' '}
        <code>POST /api/v1/repos/owner/repo/commits/FULL_SHA/sessions</code>,
        using its approved agent token. GET the same path to read receipts.
      </p>
      <p>
        Supply model, started_at, ended_at (null while open), tokens_in/out,
        optional cost/currency, commands (name, exit_code, duration_ms), files
        (read/written), and notes. Update an open report by POSTing its ID; an
        end time closes it permanently. All fields describe agent-reported work; Gild does not verify execution.
        The server redacts token-shaped strings before storing reports.
      </p>
      <h2>Claude Code: 20-line hook</h2>
      <p>
        Save this collector locally. Give it a JSON config path with repo, pull,
        agent and model. Register it for SessionStart, PreToolUse (Bash),
        PostToolUse (Bash|Read|Write|Edit), PostToolUseFailure (Bash), and
        SessionEnd in{' '}
        <a href="https://code.claude.com/docs/en/hooks">
          Claude Code’s hook configuration
        </a>
        . Ignore .gild-receipts and the local config. It records directly
        observed paths and closes at SessionEnd. Usage/cost and missing exit
        codes remain unmeasured; it does not parse transcripts or infer shell
        reads. The CLI uses an already-approved local agent credential.
      </p>
      <pre>{hook}</pre>
      <h2>Generic shell wrapper</h2>
      <p>
        Arguments: repo, pull number, agent label, model, known read paths, then{' '}
        <code>--</code> and a command. It records exit code, duration, and
        working-tree changes during that command. Concurrent unrelated edits may
        appear. Upload failures leave JSON for retry.
      </p>
      <pre>
        python3 run-with-receipt.py owner/repo 42 codex model-name src/main.ts
        -- bun test
      </pre>
      <pre>{wrapper}</pre>
      <p>
        Reports authenticate the submitting agent without publishing token hashes
        or an unverifiable receipt signature. Stored commands are capped at 1 KiB,
        and each agent has 100 slots per target. Closed snapshots are immutable; their
        collections remain mutable and use no-store caching.{' '}
        <code>gild session list --repo owner/repo --pull 42</code> reads them.
      </p>
    </article>
  )
}
