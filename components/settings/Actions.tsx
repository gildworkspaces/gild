'use client'
import { RunnerPanel } from './Runners'
import { useState } from 'react'
import Link from '@/components/Link'
import { runnerStatus } from '@/lib/actions/runner-status'
import type { Runner } from '@/lib/actions/store'
import { call } from './forms'
import s from './settings.module.css'
export function RunnersList({
  runners,
  repo,
}: {
  runners: Runner[]
  repo?: string
}) {
  return (
    <div className={s.table}>
      {runners.map((r) => (
        <div className={s.row} key={r.id}>
          <div className={s.grow}>
            <strong>{r.name}</strong>
            <div className={s.dim}>
              {r.os} · {r.arch} · {r.labels.join(', ')}
              {repo ? ' · ' + repo : ''}
            </div>
          </div>
          <span className={s.dim}>
            {runnerStatus(r)}
          </span>
        </div>
      ))}
      {!runners.length && <div className={s.row}>No repo runners</div>}
    </div>
  )
}
export function ActionsSettings({
  owner,
  repo,
  initialRequired,
  runners,
  initialSecrets,
  kind,
  disabled = false,
}: {
  owner: string
  repo: string
  initialRequired: string[]
  runners: Runner[]
  initialSecrets: { name: string; updated: number }[]
  kind: 'org'|'user'
  disabled?: boolean
}) {
  const [secrets, setSecrets] = useState(initialSecrets),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    base = `/api/repos/${owner}/${repo}/actions`
  async function perform(fn: () => Promise<void>) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await fn()
      setNotice('Saved')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <h1>Actions</h1>
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className={s.notice}>
          {notice}
        </p>
      )}
      <h2>Secrets</h2>
      <div className={s.table}>
        {secrets.map((secret) => (
          <div className={s.row} key={secret.name}>
            <div className={s.grow}>
              <strong className="mono">{secret.name}</strong>
              <div className={s.dim}>
                Updated {new Date(secret.updated).toLocaleDateString()}
              </div>
            </div>
            <button
              disabled={disabled || busy}
              onClick={() =>
                void perform(async () => {
                  await call(base + '/secrets/' + secret.name, 'DELETE')
                  setSecrets((rows) =>
                    rows.filter((r) => r.name !== secret.name),
                  )
                })
              }
            >
              Delete
            </button>
          </div>
        ))}
        {!secrets.length && <div className={s.row}>No secrets</div>}
      </div>
      <form
        className={s.form}
        style={{ maxWidth: 620, marginTop: 20 }}
        onSubmit={(e) => {
          e.preventDefault()
          const form = e.currentTarget,
            f = new FormData(form),
            name = String(f.get('name'))
          void perform(async () => {
            await call(base + '/secrets/' + name, 'PUT', {
              value: f.get('value'),
            })
            setSecrets((rows) => [
              ...rows.filter((r) => r.name !== name),
              { name, updated: Date.now() },
            ])
            form.reset()
          })
        }}
      >
        <label>
          Name
          <input
            name="name"
            required
            pattern="[A-Z_][A-Z0-9_]{0,63}"
            placeholder="DEPLOY_TOKEN"
            disabled={disabled}
          />
        </label>
        <label>
          Value
          <input
            name="value"
            type="password"
            autoComplete="new-password"
            required
            disabled={disabled}
          />
        </label>
        <div>
          <button className={s.primary} disabled={disabled || busy}>
            Add or update secret
          </button>
        </div>
      </form>
      <h2>Required workflows</h2>
      <form
        className={s.form}
        style={{ maxWidth: 620 }}
        onSubmit={(e) => {
          e.preventDefault()
          const data = new FormData(e.currentTarget)
          void perform(async () => {
            await call(base + '/settings', 'PUT', {
              required: String(data.get('required'))
                .split(/[,\n]/)
                .map((r) => r.trim())
                .filter(Boolean),
            })
          })
        }}
      >
        <label>
          Workflow files
          <textarea
            name="required"
            defaultValue={initialRequired.join('\n')}
            rows={3}
            disabled={disabled}
          />
          <span className={s.hint}>
            One workflow filename per line, for example ci.yml.
          </span>
        </label>
        <div>
          <button className={s.primary} disabled={disabled || busy}>
            Save required workflows
          </button>
        </div>
      </form>
      <div style={{marginTop:32}}><RunnerPanel owner={owner} repo={repo} kind={kind} base={`/${owner}/${repo}/settings`}/></div>
    </>
  )
}
export function AccountRunners({
  repositories,
}: {
  repositories: { name: string; runners: Runner[] }[]
}) {
  return (
    <>
      <h1>Runners</h1>
      {!repositories.length && (
        <div className={s.empty}>No owned repositories</div>
      )}
      {repositories.map((repo) => (
        <section key={repo.name}>
          <h2>
            <Link href={`/${repo.name}/settings/actions`}>{repo.name}</Link>
          </h2>
          <RunnersList runners={repo.runners} />
        </section>
      ))}
    </>
  )
}
