'use client'
import { useEffect, useState } from 'react'
import { call } from './forms'
import type { Invitation } from '@/lib/collaborators'
import s from './settings.module.css'
export function RepoPrivacy({
  owner,
  repo,
  visibility,
  disabled = false,
}: {
  owner: string
  repo: string
  visibility: 'public' | 'private'
  disabled?: boolean
}) {
  const base = `/api/repos/${owner}/${repo}`,
    [current, setCurrent] = useState(visibility),
    [collaborators, setCollaborators] = useState<
      { login: string; permission: string }[]
    >([]),
    [invitations, setInvitations] = useState<Invitation[]>([]),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false)
  async function reload() {
    const data = await call(base + '/collaborators')
    setCollaborators(data.collaborators)
    setInvitations(data.invitations)
  }
  useEffect(() => {
    void reload().catch((e) => setError(e.message))
  }, [base])
  async function perform(work: () => Promise<void>) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await work()
      await reload()
      setNotice('Saved')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <h1>Visibility & collaborators</h1>
      <p>
        Private repositories are free. Only the owner, organization members,
        accepted collaborators and explicitly granted agents can read them.
      </p>
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
      <section className={s.form}>
        <h2>Visibility</h2>
        <p>This repository is {current}.</p>
        <button
          disabled={disabled || busy}
          onClick={() => {
            if (current === 'private') {
              setConfirm(true)
              return
            }
            void perform(async () => {
              await call(base + '/visibility', 'PATCH', {
                visibility: 'private',
              })
              setCurrent('private')
            })
          }}
        >
          Make {current === 'public' ? 'private' : 'public'}
        </button>
        {confirm && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const value = new FormData(e.currentTarget).get('confirm')
              void perform(async () => {
                await call(base + '/visibility', 'PATCH', {
                  visibility: 'public',
                  confirm: value,
                })
                setCurrent('public')
                setConfirm(false)
              })
            }}
          >
            <p>
              Publishing makes all code, issues, pull requests and Actions logs
              visible to everyone.
            </p>
            <label>
              Type {owner}/{repo} to publish
              <input name="confirm" required autoComplete="off" />
            </label>
            <button disabled={busy}>Confirm publication</button>
            <button type="button" onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </form>
        )}
      </section>
      <h2>Collaborators</h2>
      <form
        className={s.form}
        onSubmit={(e) => {
          e.preventDefault()
          const form = new FormData(e.currentTarget),
            username = String(form.get('username')).replace(/^@/, '')
          void perform(async () => {
            await call(
              base + '/collaborators/' + encodeURIComponent(username),
              'PUT',
              { permission: form.get('permission') },
            )
          })
        }}
      >
        <label>
          Gild name
          <input
            name="username"
            required
            pattern="[a-zA-Z0-9][a-zA-Z0-9-]{0,38}"
            disabled={disabled || busy}
          />
        </label>
        <label>
          Role
          <select name="permission" disabled={disabled || busy}>
            <option value="read">Read</option>
            <option value="write">Write</option>
          </select>
        </label>
        <button disabled={disabled || busy}>Invite collaborator</button>
      </form>
      <ul>
        {collaborators.map((c) => (
          <li key={c.login}>
            @{c.login} · {c.permission}{' '}
            <button
              disabled={disabled || busy}
              onClick={() =>
                void perform(async () => {
                  await call(
                    base + '/collaborators/' + encodeURIComponent(c.login),
                    'DELETE',
                  )
                })
              }
            >
              Remove
            </button>
          </li>
        ))}
        {invitations.map((i) => (
          <li key={i.id}>
            @{i.invitee} · {i.permission} · pending{' '}
            <button
              disabled={disabled || busy}
              onClick={() =>
                void perform(async () => {
                  await call(
                    base + '/collaborators/' + encodeURIComponent(i.invitee),
                    'DELETE',
                  )
                })
              }
            >
              Cancel invitation
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}
export function RepoInvitations() {
  const [rows, setRows] = useState<{ id: string; permission: string }[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  async function reload() {
    setRows(await call('/api/account/invitations'))
  }
  useEffect(() => {
    void reload().catch((e) => setError(e.message))
  }, [])
  async function decide(id: string, accept: boolean) {
    setBusy(true)
    setError('')
    try {
      await call(
        '/api/account/invitations/' + id,
        accept ? 'PATCH' : 'DELETE',
        {},
      )
      await reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <h1>Repository invitations</h1>
      <p>
        An invitation grants access only when accepted. Repository details
        remain private until then.
      </p>
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      <ul>
        {rows.map((i) => (
          <li key={i.id}>
            Invitation {i.id} · {i.permission}{' '}
            <button disabled={busy} onClick={() => void decide(i.id, true)}>
              Accept
            </button>{' '}
            <button disabled={busy} onClick={() => void decide(i.id, false)}>
              Decline
            </button>
          </li>
        ))}
      </ul>
      {!rows.length && <p>No pending invitations.</p>}
    </>
  )
}
