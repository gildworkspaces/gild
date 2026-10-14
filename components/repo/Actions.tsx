'use client'
import { refreshPublicPage, navigatePublicPage } from '../refresh-public'
import { usePublicViewer } from '../PublicViewer'
import Link from '@/components/Link'
import { channelObjectURL } from './ChannelModal'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type {
  Run,
  Runner,
  Status,
  StoredJob,
  StoredStep,
} from '@/lib/actions/store'
import type { Workflow } from '@/lib/actions/workflow'
import s from './actions.module.css'
type Summary = Omit<Run, 'workflow'> & { machines?: string[] } & {
  workflow: Pick<Workflow, 'file' | 'name' | 'error'>
}
type Overview = {
  runs: Summary[]
  runners: Runner[]
  pendingEvents?: { key: string; attempts: number }[]
  archiveError?: string | null
  settings: { required: string[] }
}
type Detail = {
  run: Run
  jobs: (Omit<StoredJob, 'lease'> & { steps: StoredStep[] })[]
}
const live = (status: Status) => ['queued', 'running'].includes(status)
export { ActionMark, CommitActions } from '../../packages/render/Actions'
import { ActionMark } from '../../packages/render/Actions'

function duration(start: number | null, finish: number | null, now: number) {
  if (!start) return finish ? '0s' : 'queued'
  const sec = Math.max(0, Math.round(((finish ?? now) - start) / 1000))
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`
}
function useNow() {
  const [n, set] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => set(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return n
}
const base = (owner: string, repo: string) =>
  `/api/repos/${owner}/${repo}/actions`
async function call(url: string, body?: unknown, method = 'POST') {
  const r = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    }),
    b = await r.json()
  if (!r.ok) throw new Error(b.error ?? 'Actions request failed')
  return b
}
export function ActionsBoard({
  owner,
  repo,
  initial,
  workflows,
  branches,
  defaultBranch,
}: {
  owner: string
  repo: string
  initial: Overview
  workflows: {
    file: string
    name: string
    error?: string
    dispatch: boolean
  }[]
  branches: string[]
  defaultBranch: string
}) {
  // Write controls come from the viewer island, so the page HTML is the same
  // for every viewer and the server never resolves the session for it.
  const viewer = usePublicViewer(`${owner}/${repo}`),
    writer = !!viewer.write

  const [view, setView] = useState(initial),
    [selected, setSelected] = useState(''),
    [ref, setRef] = useState(defaultBranch),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    router = useRouter(),
    now = useNow(),
    api = base(owner, repo)
  useEffect(() => {
    let dead = false
    const update = async () => {
      try {
        const r = await call(api, undefined, 'GET')
        if (!dead) {
          setView(r)
          setError('')
        }
      } catch (e) {
        if (!dead) setError((e as Error).message)
      }
    }
    const t = setInterval(update, 3000)
    return () => {
      dead = true
      clearInterval(t)
    }
  }, [api])
  const chosen = workflows.find((w) => w.file === selected),
    runs = view.runs.filter((r) => !selected || r.workflow.file === selected)
  return (
    <div className={s.board}>
      <nav className={s.workflows} aria-label="Workflows">
        <button aria-current={!selected} onClick={() => setSelected('')}>
          All runs
        </button>
        {workflows.map((w) => (
          <button
            key={w.file}
            aria-current={w.file === selected}
            onClick={() => setSelected(w.file)}
          >
            {w.file}
          </button>
        ))}
      </nav>
      <div className={s.main}>
        <div className={s.heading}>
          <h2>{chosen?.name ?? 'Actions'}</h2>
          {writer && chosen?.dispatch && (
            <form
              className={s.form}
              onSubmit={async (e) => {
                e.preventDefault()
                setBusy(true)
                setError('')
                try {
                  const r = await call(`${api}/dispatch`, {
                    file: selected,
                    ref,
                  })
                  navigatePublicPage(router,`/${owner}/${repo}/actions/${r.id}`)
                } catch (e) {
                  setError((e as Error).message)
                } finally {
                  setBusy(false)
                }
              }}
            >
              <label>
                Branch
                <select value={ref} onChange={(e) => setRef(e.target.value)}>
                  {branches.map((b) => (
                    <option key={b}>{b}</option>
                  ))}
                </select>
              </label>
              <button className={s.button} disabled={busy}>
                Run workflow
              </button>
            </form>
          )}
        </div>
        <p className={s.copy}>
          Plain GitHub Actions YAML in .github/workflows. No changes needed to
          move a repo here.
        </p>
        <p className={s.copy}>
          Live logs stream while a run is going; finished runs are saved to
          .gild/actions/ on <em>_meta</em>
        </p>
        {view.pendingEvents?.some((e) => e.attempts > 0) && (
          <p role="status" className={s.copy}>
            Workflow loading is being retried. Check repo read access if this
            persists.
          </p>
        )}
        {view.archiveError && (
          <p role="status" className={s.copy}>
            Finished run records are waiting for the forge to write _meta.
          </p>
        )}
        {chosen?.error && (
          <p className={s.error}>Workflow cannot run: {chosen.error}</p>
        )}
        {error && (
          <p role="alert" className={s.error}>
            {error}
          </p>
        )}
        {runs.length ? (
          runs.map((r) => {
            const jobsRunner = view.runners.find((m) => m.run === r.id)
            return (
              <Link
                className={s.run}
                key={r.id}
                href={`/${owner}/${repo}/actions/${r.id}`}
              >
                <ActionMark status={r.status} />
                <div className={s.runInfo}>
                  <span className={s.title}>{r.event.title}</span>
                  <div className={s.meta}>
                    {r.workflow.file} #{r.id} · {r.event.name} by @
                    {r.event.actor} ·{' '}
                    {r.event.ref.replace(/^refs\/(heads|tags)\//, '')}
                  </div>
                  <div className={s.meta}>
                    {r.machines?.length
                      ? r.machines.join(', ')
                      : jobsRunner
                        ? jobsRunner.name
                        : r.status === 'queued'
                          ? 'Waiting for a matching runner'
                          : r.status === 'running'
                            ? 'Runner assigned'
                            : 'Finished'}{' '}
                    · {r.status}
                  </div>
                </div>
                <span className={s.time}>
                  {duration(r.started, r.finished, now)}
                </span>
              </Link>
            )
          })
        ) : (
          <p className={s.copy}>
            No runs yet. Push a commit or dispatch a workflow to begin.
          </p>
        )}
        <section className={s.panel}>
          <h3>Runners — your machines</h3>
          <p className={s.copy}>
            gild doesn&apos;t rent you compute. Runs go to machines you
            register: a home server, a Mac mini, a VM.
          </p>
          {view.runners.map((r) => (
            <div className={s.machine} key={r.id}>
              <div>
                <strong>{r.name}</strong>
                <div className={s.meta}>
                  {r.os === 'darwin' ? 'macOS' : r.os} · {r.arch}
                </div>
              </div>
              <span className={s.meta}>
                {now - r.lastSeen > 60_000
                  ? 'offline'
                  : r.job
                    ? `busy · run #${r.run}`
                    : 'idle'}
              </span>
            </div>
          ))}
          {!view.runners.length && (
            <p className={s.copy}>No machines registered.</p>
          )}
          <p className={s.copy}>
            Add a machine:{' '}
            <code className={s.code}>
              gild runner add --repo {owner}/{repo}
            </code>
          </p>
        </section>
        {writer && (
          <OwnerSettings
            api={api}
            workflows={workflows}
            required={view.settings.required}
          />
        )}
      </div>
    </div>
  )
}
function OwnerSettings({
  api,
  workflows,
  required,
}: {
  api: string
  workflows: { file: string }[]
  required: string[]
}) {
  const [selected, setSelected] = useState(required),
    [name, setName] = useState(''),
    [value, setValue] = useState(''),
    [names, setNames] = useState<string[]>([]),
    [message, setMessage] = useState('')
  const refresh = async () => {
    const r = await call(`${api}/secrets`, undefined, 'GET')
    setNames(r.secrets.map((s: { name: string }) => s.name))
  }
  return (
    <details
      className={s.settings}
      onToggle={(e) => {
        if (e.currentTarget.open)
          void refresh().catch((e) => setMessage(e.message))
      }}
    >
      <summary>Owner settings: required workflows and secrets</summary>
      <section className={s.panel}>
        <p className={s.copy}>
          Required workflows gate the merge queue at the current PR head. Empty
          means off. Queue a waiting PR again once checks finish.
        </p>
        <form
          className={s.form}
          onSubmit={async (e) => {
            e.preventDefault()
            try {
              await call(`${api}/settings`, { required: selected }, 'PUT')
              setMessage('Required workflows saved.')
            } catch (e) {
              setMessage((e as Error).message)
            }
          }}
        >
          {workflows.map((w) => (
            <label key={w.file}>
              <input
                type="checkbox"
                checked={selected.includes(w.file)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, w.file]
                      : selected.filter((s) => s !== w.file),
                  )
                }
              />
              {w.file}
            </label>
          ))}
          <button className={s.button}>Save requirements</button>
        </form>
        <p className={s.copy}>
          Secrets are encrypted and never shown back. Pull-request runs receive
          no repo secrets.
        </p>
        <form
          className={s.form}
          onSubmit={async (e) => {
            e.preventDefault()
            try {
              await call(
                `${api}/secrets/${encodeURIComponent(name)}`,
                { value },
                'PUT',
              )
              setValue('')
              setName('')
              await refresh()
              setMessage('Secret saved.')
            } catch (e) {
              setMessage((e as Error).message)
            }
          }}
        >
          <input
            aria-label="Secret name"
            placeholder="SECRET_NAME"
            pattern="[A-Z_][A-Z0-9_]*"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <input
            type="password"
            autoComplete="new-password"
            aria-label="Secret value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required
          />
          <button className={s.button}>Save secret</button>
        </form>
        {names.map((n) => (
          <p className={s.form} key={n}>
            <code>{n}</code>
            <button
              className={s.button}
              onClick={async () => {
                try {
                  await call(`${api}/secrets/${n}`, undefined, 'DELETE')
                  await refresh()
                } catch (e) {
                  setMessage((e as Error).message)
                }
              }}
            >
              Remove
            </button>
          </p>
        ))}
        {message && (
          <p role="status" className={s.copy}>
            {message}
          </p>
        )}
      </section>
    </details>
  )
}
export function ActionRun({
  owner,
  repo,
  initial,
  writer,
}: {
  owner: string
  repo: string
  initial: Detail
  writer: boolean
}) {
  const viewer = usePublicViewer(`${owner}/${repo}`)
  writer = !!viewer.write

  const [detail, setDetail] = useState(initial),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    now = useNow(),
    router = useRouter(),
    api = base(owner, repo),
    id = initial.run.id
  useEffect(() => {
    if (!live(detail.run.status)) return
    let dead = false
    const t = setInterval(async () => {
      try {
        const r = await call(`${api}/runs/${id}`, undefined, 'GET')
        if (!dead) setDetail(r)
      } catch (e) {
        if (!dead) setError((e as Error).message)
      }
    }, 1500)
    return () => {
      dead = true
      clearInterval(t)
    }
  }, [api, id, detail.run.status])
  const mutate = async (op: string) => {
    setBusy(true)
    try {
      const r = await call(`${api}/runs/${id}/${op}`, {})
      if (r.id) {const target=`/${owner}/${repo}/actions/${r.id}`;if(location.pathname===`/${owner}/${repo}/agents`)router.replace(channelObjectURL(`/${owner}/${repo}`,target));else navigatePublicPage(router,target)}
      else setDetail(await call(`${api}/runs/${id}`, undefined, 'GET'))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const r = detail.run
  return (
    <div className={s.runPage}>
      <Link className={s.back} href={`/${owner}/${repo}/actions`}>
        ← All runs
      </Link>
      <div className={s.heading}>
        <h2>
          <ActionMark status={r.status} /> {r.event.title}
        </h2>
        {writer && (
          <div className={s.form}>
            {r.event.requiresApproval && r.status==='queued' && <button disabled={busy} className={s.button} onClick={()=>mutate('approve')}>Approve fork run</button>}
            <button
              disabled={busy}
              className={s.button}
              onClick={() => mutate(live(r.status) ? 'cancel' : 'rerun')}
            >
              {live(r.status) ? 'Cancel run' : 'Re-run'}
            </button>
          </div>
        )}
      </div>
      <p className={s.meta}>
        {r.workflow.file} #{id} · {r.event.name} by @{r.event.actor} ·{' '}
        {r.event.ref.replace(/^refs\/(heads|tags)\//, '')} ·{' '}
        {duration(r.started, r.finished, now)} · {r.status}
      </p>
      <p className={s.code}>{r.event.sha}</p>
      {(r.reason || error) && (
        <p role="alert" className={s.error}>
          {r.reason ?? error}
        </p>
      )}
      {detail.jobs.map((j) => (
        <section key={j.id} className={s.job}>
          <header className={s.jobHead}>
            <ActionMark status={j.status} />
            <strong>{j.spec.name}</strong>
            <span className={s.meta}>
              {Object.entries(j.spec.matrix)
                .map(([k, v]) => `${k}: ${v}`)
                .join(' · ')}
            </span>
            <span className={s.meta}>
              {j.runnerName ?? 'Waiting for runner'} ·{' '}
              {duration(j.started, j.finished, now)}
            </span>
          </header>
          {j.reason && <p className={s.error}>{j.reason}</p>}
          <a
            className={s.meta}
            href={`${api}/runs/${id}/jobs/${j.id}/logs`}
          >
            View job logs
          </a>
          {j.steps.map((step) => (
            <StepLog
              key={step.position}
              api={api}
              run={id}
              job={j.id}
              step={step}
              active={live(r.status)}
              now={now}
            />
          ))}
        </section>
      ))}
    </div>
  )
}
function StepLog({
  api,
  run,
  job,
  step,
  active,
  now,
}: {
  api: string
  run: number
  job: number
  step: StoredStep
  active: boolean
  now: number
}) {
  const [log, setLog] = useState(''),
    [error, setError] = useState(''),
    cursor = useRef(-1)
  useEffect(() => {
    let dead = false,
      busy = false
    const update = async () => {
      if (busy) return
      busy = true
      try {
        let chunks: { seq: number; text: string }[]
        do {
          const r = await call(
            `${api}/runs/${run}/logs?job=${job}&step=${step.position}&after=${cursor.current}`,
            undefined,
            'GET',
          )
          chunks = r.chunks
          if (dead) return
          if (chunks.length) {
            cursor.current = chunks[chunks.length - 1].seq
            setLog((s) => s + chunks.map((c) => c.text).join(''))
          }
        } while (chunks.length === 128)
        if (!dead) setError('')
      } catch (e) {
        if (!dead) setError((e as Error).message)
      } finally {
        busy = false
      }
    }
    void update()
    const t = active ? setInterval(update, 1500) : null
    return () => {
      dead = true
      if (t) clearInterval(t)
    }
  }, [api, run, job, step.position, active])
  return (
    <details
      className={s.step}
      open={step.status === 'running' || step.status === 'failure'}
    >
      <summary>
        <ActionMark status={step.status} />
        <span>{step.name}</span>
        <span className={s.meta}>
          {duration(step.started, step.finished, now)}
          {step.exit !== null ? ` · exit ${step.exit}` : ''}
        </span>
      </summary>
      <pre className={s.log}>{error || log || 'No output yet.'}</pre>
    </details>
  )
}
