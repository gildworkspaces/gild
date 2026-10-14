'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from '@/components/Link'
import type { RenameJob } from '@/lib/settings-rename'
import type { Profile, Entity } from '@/lib/settings-store'
import type { OrgMembership, OrgRole, ApiToken } from '@/lib/backend'
import { RESTORE_MS } from '@/lib/settings-store'
import { SCOPES } from '@/lib/api/scopes'
import { Picture } from '@/components/Picture'
import type { ProfilePicture } from '@/lib/profile'
import { ThemeSelect } from '@/components/theme'
import s from './settings.module.css'
export async function call(url: string, method = 'GET', body?: unknown) {
  const r = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    }),
    data = await r.json()
  if (!r.ok) throw new Error(data.error ?? data.message ?? 'Request failed')
  return data
}
function useAction() {
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    router = useRouter()
  return {
    error,
    notice,
    busy,
    async perform(fn: () => Promise<void>, message = 'Saved') {
      setBusy(true)
      setError('')
      setNotice('')
      try {
        await fn()
        setNotice(message)
        router.refresh()
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
  }
}
function Status({ action }: { action: ReturnType<typeof useAction> }) {
  return (
    <>
      {action.error && (
        <p role="alert" className={s.error}>
          {action.error}
        </p>
      )}
      {action.notice && (
        <p role="status" className={s.notice}>
          {action.notice}
        </p>
      )}
    </>
  )
}
async function resizePicture(file: File) {
  const bitmap = await createImageBitmap(file)
  try {
    const ratio = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height)),
      canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio))
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio))
    canvas
      .getContext('2d')!
      .drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    for (const quality of [0.85, 0.7, 0.5, 0.3]) {
      const data = canvas.toDataURL('image/webp', quality)
      if (
        data.startsWith('data:image/webp;') &&
        atob(data.split(',')[1]).length <= 65536
      )
        return data
    }
    throw new Error('Picture could not be reduced to 64 KB')
  } finally {
    bitmap.close()
  }
}
export function ProfileForm({
  name,
  initial,
  org,
  email,
  resolvedPicture,
  disabled = false,
}: {
  name: string
  initial: Profile
  org?: boolean
  email?: string
  resolvedPicture: ProfilePicture
  disabled?: boolean
}) {
  const action = useAction(),
    input = useRef<HTMLInputElement>(null),
    base = org ? `/api/orgs/${name}` : '/api/account'
  return (
    <>
      <h1>{org ? 'General' : 'Profile'}</h1>
      <Status action={action} />
      <div className={s.profile}>
        <form
          className={s.form}
          onSubmit={(e) => {
            e.preventDefault()
            const f = new FormData(e.currentTarget)
            void action.perform(async () => {
              await call(base + '/profile', 'PATCH', {
                displayName: f.get('displayName'),
                publicEmail: f.get('publicEmail'),
                description: f.get('description'),
                url: f.get('url'),
                socialLinks: [0, 1, 2, 3]
                  .map((i) => String(f.get('social' + i) || ''))
                  .filter(Boolean),
                location: f.get('location'),
              })
            })
          }}
        >
          <fieldset
            disabled={disabled || action.busy}
            style={{ border: 0, padding: 0, margin: 0, display: 'contents' }}
          >
            {!org && (
              <>
                <label>
                  Username
                  <input value={'@' + name} readOnly />
                </label>
                <label>
                  Account email
                  <input value={email ?? ''} readOnly />
                </label>
              </>
            )}
            <label>
              Display name
              <input
                name="displayName"
                defaultValue={initial.displayName}
                maxLength={100}
              />
            </label>
            <label>
              Public email
              <input
                name="publicEmail"
                type="email"
                defaultValue={initial.publicEmail}
              />
            </label>
            <label>
              Description
              <input
                name="description"
                defaultValue={initial.description}
                maxLength={1000}
              />
            </label>
            <label>
              URL
              <input name="url" type="url" defaultValue={initial.url} />
            </label>
            <div className={s.social}>
              <span className={s.label}>Social accounts</span>
              {[0, 1, 2, 3].map((i) => (
                <input
                  key={i}
                  type="url"
                  name={'social' + i}
                  aria-label={`Social link ${i + 1}`}
                  defaultValue={initial.socialLinks[i] ?? ''}
                  placeholder="Link to social profile"
                />
              ))}
            </div>
            <label style={{ maxWidth: 280 }}>
              Location
              <input
                name="location"
                defaultValue={initial.location}
                maxLength={100}
              />
            </label>
            <div>
              <button className={s.primary}>Update profile</button>
            </div>
          </fieldset>
          {!org && (
            <label>
              Theme
              <ThemeSelect />
            </label>
          )}
        </form>
        <div className={s.photo}>
          <span className={s.label}>Profile picture</span>
          <Picture name={name} picture={resolvedPicture} org={org} showSource />
          <input
            ref={input}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file)
                void action.perform(async () => {
                  await call(base + '/picture', 'PUT', {
                    data: await resizePicture(file),
                  })
                }, 'Picture updated')
              e.target.value = ''
            }}
          />
          <button
            disabled={disabled || action.busy}
            onClick={() => input.current?.click()}
          >
            Upload new picture
          </button>
          {initial.picture && (
            <button
              disabled={disabled || action.busy}
              onClick={() =>
                void action.perform(async () => {
                  await call(base + '/picture', 'DELETE')
                }, 'Picture updated')
              }
            >
              Use Gravatar
            </button>
          )}
        </div>
      </div>
    </>
  )
}
export function Members({
  org,
  initial,
  role,
  viewer,
  pictures,
  disabled = false,
}: {
  org: string
  initial: OrgMembership[]
  role: OrgRole
  viewer: string
  pictures: Record<string, ProfilePicture>
  disabled?: boolean
}) {
  const [members, setMembers] = useState(initial),
    action = useAction(),
    base = `/api/orgs/${org}/memberships/`
  useEffect(() => setMembers(initial), [initial])
  const owners = members.filter((m) => m.role === 'owner').length,
    roles: OrgRole[] =
      role === 'owner' ? ['member', 'admin', 'owner'] : ['member', 'admin']
  const change = async (name: string, newRole: OrgRole | null) => {
    await call(
      base + name,
      newRole ? 'PUT' : 'DELETE',
      newRole ? { role: newRole } : undefined,
    )
    setMembers((rows) =>
      newRole
        ? rows.map((m) => (m.member === name ? { ...m, role: newRole } : m))
        : rows.filter((m) => m.member !== name),
    )
  }
  return (
    <>
      <h1>Members</h1>
      <Status action={action} />
      <form
        className={s.inline}
        style={{ marginBottom: 16 }}
        onSubmit={(e) => {
          e.preventDefault()
          const form = e.currentTarget,
            f = new FormData(form),
            name = String(f.get('name')).replace(/^@/, '').toLowerCase(),
            r = f.get('role') as OrgRole
          void action.perform(async () => {
            await call(base + name, 'PUT', { role: r })
            setMembers((rows) => [
              ...rows.filter((m) => m.member !== name),
              { org, member: name, role: r, addedAt: new Date().toISOString() },
            ])
            form.reset()
          }, 'Member added')
        }}
      >
        <input
          aria-label="Add by gild name"
          name="name"
          placeholder="Add by gild name, e.g. @kimi"
          required
          style={{ flex: 1, minWidth: 140 }}
          disabled={disabled}
        />
        <select name="role" aria-label="New member role" disabled={disabled}>
          {roles.map((r) => (
            <option key={r} value={r}>
              {r[0].toUpperCase() + r.slice(1)}
            </option>
          ))}
        </select>
        <button className={s.primary} disabled={disabled || action.busy}>
          Add member
        </button>
      </form>
      <div className={s.table}>
        <div className={s.tableHead}>{members.length} members</div>
        {members.map((m) => {
          const last = m.role === 'owner' && owners === 1,
            blocked =
              disabled ||
              action.busy ||
              last ||
              (m.role === 'owner' && role !== 'owner')
          return (
            <div className={s.row} key={m.member}>
              <Picture name={m.member} picture={pictures[m.member]} />
              <div className={s.grow}>
                <strong>@{m.member}</strong>
                <div className={s.dim}>
                  Joined {new Date(m.addedAt).toLocaleDateString('en-CA')}
                  {m.member === viewer ? ' · you' : ''}
                </div>
              </div>
              <select
                aria-label={`Role for ${m.member}`}
                value={m.role}
                disabled={blocked}
                onChange={(e) =>
                  void action.perform(
                    () => change(m.member, e.target.value as OrgRole),
                    'Role updated',
                  )
                }
              >
                {[...new Set([...roles, m.role])].map((r) => (
                  <option key={r} value={r}>
                    {r[0].toUpperCase() + r.slice(1)}
                  </option>
                ))}
              </select>
              {last && <span className={s.dim}>Last owner</span>}
              <button
                disabled={blocked}
                onClick={() =>
                  void action.perform(
                    () => change(m.member, null),
                    'Member removed',
                  )
                }
              >
                Remove
              </button>
            </div>
          )
        })}
      </div>
      <div className={s.roles}>
        <h2>Roles</h2>
        <div className={s.table}>
          {[
            ['Owner', 'Everything, including the danger zone and other owners'],
            ['Admin', 'Members, repos, repo runners, webhooks'],
            [
              'Member',
              'Read public repos and participate in issues and pull requests',
            ],
          ].map(([r, text]) => (
            <div className={s.row} key={r}>
              <strong>{r}</strong>
              <span>{text}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
export function DangerZone({
  kind,
  name,
  state,
}: {
  kind: 'organization' | 'repository'
  name: string
  state: Entity
}) {
  const action = useAction(),
    dialog = useRef<HTMLDialogElement>(null),
    [operation, setOperation] = useState<'rename' | 'archive' | 'delete'>(
      'rename',
    ),
    [value, setValue] = useState(''),
    router = useRouter(),
    base = kind === 'organization' ? `/api/orgs/${name}` : `/api/repos/${name}`
  const [job, setJob] = useState<RenameJob | null>(null)
  useEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const result = await call(base + '/rename')
        if (!active) return
        setJob(result.job)
        if (result.job?.phase === 'complete' && state.moving)
          router.replace(
            kind === 'organization'
              ? `/orgs/${result.job.to}/settings/general`
              : `/${result.job.to}/settings/general`,
          )
      } catch {
        /* The next read retries after a transient failure. */
      }
      if (active) timer = setTimeout(poll, 2000)
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [base, kind, router, state.moving])
  const moving =
    state.moving || (job && !['failed', 'complete'].includes(job.phase))
  const title =
    operation === 'rename'
      ? `Rename ${kind}`
      : operation === 'archive'
        ? `${state.archived ? 'Unarchive' : 'Archive'} this ${kind}`
        : `Delete this ${kind}`
  function open(op: typeof operation) {
    setOperation(op)
    setValue('')
    dialog.current?.showModal()
  }
  return (
    <>
      <h2 className={s.dangerTitle}>Danger zone</h2>
      {moving && (
        <p role="status">
          {!job || job.phase === 'waiting'
            ? 'Rename queued. Waiting for active writes to finish.'
            : job.phase === 'copying'
              ? `Copying repositories: ${job.copied} of ${job.repos.length} complete.`
              : 'Finishing rename…'}
        </p>
      )}
      {job?.error && (
        <p role={job.phase === 'failed' ? 'alert' : 'status'}>{job.error}</p>
      )}
      <Status action={action} />
      <div className={s.dangerBox}>
        {[
          [
            'rename',
            `Rename ${kind}`,
            kind === 'organization'
              ? 'Repos move with it. The old name redirects and stays reserved. You can reclaim it later.'
              : 'The old name redirects and stays reserved. You can reclaim it later.',
          ],
          [
            'archive',
            `${state.archived ? 'Unarchive' : 'Archive'} this ${kind}`,
            state.archived
              ? 'Restore writes and Actions.'
              : kind === 'organization'
                ? 'The org and all its repos become read-only. Owners can undo this.'
                : 'The repository becomes read-only. Owners can undo this.',
          ],
          [
            'delete',
            `Delete this ${kind}`,
            'Owners can restore it for 7 days. After that it is gone for good.',
          ],
        ].map(([op, label, consequence]) => (
          <div className={s.dangerRow} key={op}>
            <div className={s.grow}>
              <strong>{label}</strong>
              <div className={s.consequence}>{consequence}</div>
            </div>
            <button
              className={s.dangerButton}
              disabled={action.busy || !!moving}
              onClick={() => open(op as typeof operation)}
            >
              {label}
            </button>
          </div>
        ))}
      </div>
      <dialog ref={dialog} className={s.dialog} onCancel={() => setValue('')}>
        <h2>{title}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void action.perform(
              async () => {
                if (operation === 'rename') {
                  const result = await call(base + '/rename', 'POST', {
                    name: value,
                  })
                  dialog.current?.close()
                  const progress = await call(base + '/rename')
                  setJob(progress.job)
                  router.refresh()
                } else if (operation === 'archive') {
                  await call(base + '/archive', 'PUT', {
                    archived: !state.archived,
                  })
                  dialog.current?.close()
                } else {
                  await call(base, 'DELETE', { confirm: value })
                  dialog.current?.close()
                  router.push('/settings/organizations')
                }
              },
              operation === 'delete'
                ? 'Deleted; restore is available for 7 days'
                : 'Saved',
            )
          }}
        >
          {operation === 'rename' ? (
            <>
              <ul>
                <li>
                  All branches, tags, issues and pull requests keep their
                  history.
                </li>
                <li>
                  {kind === 'organization'
                    ? 'Every repo moves to the new organization name.'
                    : 'The repository moves to its new name.'}
                </li>
                <li>
                  The old web, API and Git URLs redirect. You can reclaim your
                  previous name; others cannot.
                </li>
                <li>Repo runners, secrets and hooks follow the new name.</li>
              </ul>
              <label>
                New name
                <input
                  required
                  autoFocus
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  pattern="[a-z0-9][a-z0-9._-]*"
                />
              </label>
            </>
          ) : operation === 'delete' ? (
            <>
              <p>
                {kind === 'organization'
                  ? 'Repos, members, runners, secrets and hooks'
                  : 'Git history, issues, pull requests, runners, secrets and hooks'}{' '}
                are retained for 7 days for restoration, then permanently
                purged.
              </p>
              <label>
                Type <code>{name}</code> to confirm
                <input
                  autoFocus
                  required
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  autoComplete="off"
                />
              </label>
            </>
          ) : (
            <p>
              {state.archived
                ? 'Writes, Actions and webhooks resume.'
                : 'Git pushes and issue/PR changes stop. Actions and webhook delivery stop.'}
            </p>
          )}
          <Status action={action} />
          <div className={s.dialogActions}>
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              disabled={action.busy}
            >
              Cancel
            </button>
            <button
              className={s.dangerButton}
              disabled={
                action.busy || (operation === 'delete' && value !== name)
              }
            >
              {title}
            </button>
          </div>
        </form>
      </dialog>
    </>
  )
}
export function RepoGeneral({
  owner,
  repo,
  description,
  defaultBranch,
  branches,
  state,
  ownerRole,
  disabled = false,
}: {
  owner: string
  repo: string
  description: string | null
  defaultBranch: string
  branches: string[]
  state: Entity
  ownerRole: boolean
  disabled?: boolean
}) {
  const action = useAction(),
    [branch, setBranch] = useState(defaultBranch)
  return (
    <>
      <h1>General</h1>
      <Status action={action} />
      <form
        className={s.form}
        style={{ maxWidth: 620 }}
        onSubmit={(e) => {
          e.preventDefault()
          const data = new FormData(e.currentTarget)
          void action.perform(async () => {
            await call(`/api/repos/${owner}/${repo}`, 'PATCH', {
              description: data.get('description'),
            })
          })
        }}
      >
        <label>
          Repository name
          <input value={repo} readOnly />
        </label>
        <label>
          Description
          <input
            name="description"
            defaultValue={description ?? ''}
            maxLength={1000}
            disabled={disabled}
          />
        </label>
        <label>
          Default branch
          <span className={s.inline}>
            <select
              aria-label="Default branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              disabled={disabled}
              style={{ maxWidth: 240 }}
            >
              {branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={disabled || action.busy || branch === defaultBranch}
              onClick={() =>
                void action.perform(async () => {
                  await call(`/api/repos/${owner}/${repo}`, 'PATCH', {
                    defaultBranch: branch,
                  })
                }, 'Default branch switched')
              }
            >
              Switch
            </button>
          </span>
        </label>
        <div>
          <button className={s.primary} disabled={disabled || action.busy}>
            Save changes
          </button>
        </div>
      </form>
      {ownerRole && (
        <DangerZone kind="repository" name={`${owner}/${repo}`} state={state} />
      )}
    </>
  )
}
export function Organizations({
  organizations,
  deleted,
}: {
  organizations: {
    name: string
    displayName: string
    role: OrgRole
    picture: ProfilePicture
    lastOwner: boolean
    archived: boolean
  }[]
  deleted: Entity[]
}) {
  const action = useAction(),
    router = useRouter(),
    [showNew, setShowNew] = useState(false)
  useEffect(() => {
    if (new URLSearchParams(location.search).has('new')) setShowNew(true)
  }, [])
  return (
    <>
      <h1>Organizations</h1>
      <Status action={action} />
      <div className={s.table}>
        {organizations.map((o) => (
          <div className={s.row} key={o.name}>
            <Picture name={o.name} picture={o.picture} org />
            <div className={s.grow}>
              <Link
                href={
                  o.role === 'member'
                    ? `/${o.name}`
                    : `/orgs/${o.name}/settings/general`
                }
              >
                <strong>{o.displayName || '@' + o.name}</strong>
              </Link>
              <div className={s.dim}>
                @{o.name} · {o.role}
                {o.archived ? ' · Archived' : ''}
              </div>
            </div>
            <button
              disabled={action.busy || o.lastOwner || o.archived}
              title={o.lastOwner ? 'You are the last owner' : undefined}
              onClick={() =>
                void action.perform(async () => {
                  await call('/api/account/orgs/' + o.name, 'DELETE')
                }, 'Left organization')
              }
            >
              Leave
            </button>
            {o.role !== 'member' && (
              <Link
                className={s.button}
                href={`/orgs/${o.name}/settings/general`}
              >
                Settings
              </Link>
            )}
          </div>
        ))}
        {!organizations.length && <div className={s.row}>No organizations</div>}
      </div>
      <button
        className={s.primary}
        style={{ marginTop: 20 }}
        onClick={() => setShowNew(!showNew)}
        aria-expanded={showNew}
      >
        New organization
      </button>
      {showNew && (
        <form
          className={s.form}
          style={{ maxWidth: 620, marginTop: 24 }}
          onSubmit={(e) => {
            e.preventDefault()
            const f = new FormData(e.currentTarget)
            void action.perform(async () => {
              const org = await call('/api/orgs', 'POST', {
                name: f.get('name'),
                description: f.get('description'),
              })
              router.push(`/orgs/${org.name}/settings/general`)
            }, 'Organization created')
          }}
        >
          <label>
            Organization name
            <input
              name="name"
              required
              pattern="[a-z0-9][a-z0-9-]{0,38}"
              maxLength={39}
            />
          </label>
          <label>
            Description
            <input name="description" maxLength={1000} />
          </label>
          <div>
            <button className={s.primary} disabled={action.busy}>
              Create organization
            </button>
          </div>
        </form>
      )}
      {deleted.length > 0 && (
        <>
          <h2>Recently deleted</h2>
          <div className={s.table}>
            {deleted.map((item) => (
              <div className={s.row} key={item.key}>
                <div className={s.grow}>
                  <strong>{item.key}</strong>
                  <div className={s.dim}>
                    Restore until{' '}
                    {new Date(item.deletedAt! + RESTORE_MS).toLocaleString()}
                  </div>
                </div>
                <button
                  disabled={action.busy}
                  onClick={() =>
                    void action.perform(async () => {
                      await call(
                        (item.key.includes('/')
                          ? '/api/repos/'
                          : '/api/orgs/') +
                          item.key +
                          '/restore',
                        'POST',
                        {},
                      )
                    }, 'Restored')
                  }
                >
                  Restore
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}
export function Tokens({
  initial,
}: {
  initial: (ApiToken & { id: string })[]
}) {
  const action = useAction(),
    [tokens, setTokens] = useState(initial),
    [newToken, setNewToken] = useState('')
  return (
    <>
      <h1>API tokens</h1>
      <Status action={action} />
      {newToken && (
        <label>
          New token — shown once
          <input
            className={s.fingerprint}
            readOnly
            value={newToken}
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
      )}
      <form
        className={s.form}
        style={{ maxWidth: 620, marginBottom: 24 }}
        onSubmit={(e) => {
          e.preventDefault()
          const f = new FormData(e.currentTarget)
          void action.perform(async () => {
            const t = await call('/api/account/tokens', 'POST', {
              label: f.get('label'),
              scopes: f.getAll('scopes'),
            })
            setNewToken(t.token)
            const rows = await call('/api/account/tokens')
            setTokens(
              rows.map(
                (t: {
                  id: string
                  label: string
                  created_at: string
                  expires_at: string
                  scopes: string[]
                  repos: string[] | null
                }) => ({
                  ...t,
                  name: null,
                  publicKey: '',
                  createdAt: Date.parse(t.created_at),
                  expiresAt: Date.parse(t.expires_at),
                }),
              ),
            )
          }, 'Token created')
        }}
      >
        <label>
          Token name
          <input name="label" required maxLength={100} />
        </label>
        <fieldset style={{ border: '1px solid var(--rule)', borderRadius: 6 }}>
          <legend>Permissions</legend>
          {SCOPES.map((scope) => (
            <label
              key={scope}
              className={s.inline}
              style={{ display: 'flex', fontWeight: 400 }}
            >
              <input
                type="checkbox"
                name="scopes"
                value={scope}
                defaultChecked={scope === 'repo:read'}
              />
              {scope}
            </label>
          ))}
        </fieldset>
        <div>
          <button className={s.primary} disabled={action.busy}>
            Create token
          </button>
        </div>
      </form>
      <div className={s.table}>
        {tokens.map((t) => (
          <div className={s.row} key={t.id}>
            <div className={s.grow}>
              <strong>{t.label || 'API token'}</strong>
              <div className={s.dim}>
                {t.scopes === null
                  ? 'All permissions'
                  : t.scopes.join(', ') || 'No permissions'}{' '}
                · Added {new Date(t.createdAt).toLocaleDateString()} · Expires{' '}
                {new Date(t.expiresAt).toLocaleDateString()}
              </div>
            </div>
            <button
              disabled={action.busy}
              onClick={() =>
                void action.perform(async () => {
                  await call('/api/account/tokens/' + t.id, 'DELETE')
                  setTokens((rows) => rows.filter((r) => r.id !== t.id))
                }, 'Token revoked')
              }
            >
              Revoke
            </button>
          </div>
        ))}
        {!tokens.length && <div className={s.row}>No API tokens</div>}
      </div>
    </>
  )
}
