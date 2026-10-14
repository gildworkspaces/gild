'use client'
import Link from '@/components/Link'
import { usePathname, useSearchParams, useRouter } from 'next/navigation'
import type { Profile } from '@/lib/settings-store'
import type { ProfilePicture } from '@/lib/profile'
import { Picture } from '@/components/Picture'
import s from './settings.module.css'
export interface Section {
  key: string
  label: string
  group?: string
  icon?: string
  parent?: string
}
export const accountSections: Section[] = [
  { key: 'profile', label: 'Profile' },
  {
    key: 'organizations',
    label: 'Organizations',
    group: 'Access',
    icon: 'people',
  },
  {key:'invitations',label:'Repository invitations',icon:'people'},
  { key: 'keys', label: 'Keys & devices', icon: 'key' },
  { key: 'tokens', label: 'API tokens', icon: 'token' },
  { key: 'billing', label: 'Billing', icon: 'billing' },
  {
    key: 'agents',
    label: 'Agents',
    group: 'Code and automation',
    icon: 'agent',
  },
  { key: 'runners', label: 'Runners', group:'Actions',icon: 'actions' },
  { key: 'runner-groups', label: 'Runner groups', icon: 'actions' },
]
export const orgSections: Section[] = [
  { key: 'general', label: 'General' },
  { key: 'members', label: 'Members', group: 'Access', icon: 'people' },
  { key: 'billing', label: 'Billing', icon: 'billing' },
  { key: 'runners', label: 'Runners', group: 'Code and automation', parent: 'Actions', icon: 'actions' },
  { key: 'runner-groups', label: 'Runner groups', icon: 'actions' },
  { key: 'webhooks', label: 'Webhooks', icon: 'hook' },
]
export const repoSections: Section[] = [
  { key: 'agents', label: 'Agents', group: 'Access', icon: 'agent' },
  {key:'access',label:'Visibility & collaborators',group:'Access',icon:'people'},
  { key: 'general', label: 'General' },
  {
    key: 'actions',
    label: 'Actions',
    group: 'Code and automation',
    icon: 'actions',
  },
  { key: 'webhooks', label: 'Webhooks', icon: 'hook' },
]
function Icon({ kind = 'general' }: { kind?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      {kind === 'people' ? (
        <>
          <circle cx="9" cy="8" r="3.5" />
          <path d="M2.5 20v-1a6.5 6.5 0 0113 0v1M16 4a4 4 0 010 8M18 14a6 6 0 014 6" />
        </>
      ) : kind === 'actions' ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m10 8 6 4-6 4z" />
        </>
      ) : kind === 'key' ? (
        <>
          <circle cx="7" cy="16" r="5" />
          <path d="m10 12 10-10m-5 5 3 3" />
        </>
      ) : kind === 'token' ? (
        <>
          <rect x="3" y="5" width="18" height="14" rx="3" />
          <path d="m9 9-3 3 3 3m6-6 3 3-3 3" />
        </>
      ) : kind === 'agent' ? (
        <>
          <rect x="4" y="7" width="16" height="13" rx="3" />
          <path d="M12 3v4M8 12h1m6 0h1M8 16h8M1 11v5m22-5v5" />
        </>
      ) : kind === 'billing' ? (
        <>
          <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
          <path d="M2.5 10h19M6 15h4" />
        </>
      ) : kind === 'hook' ? (
        <>
          <circle cx="12" cy="5" r="3" />
          <circle cx="5" cy="18" r="3" />
          <circle cx="19" cy="18" r="3" />
          <path d="m10 8-4 7m8-7 4 7M8 18h8" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2" />
        </>
      )}
    </svg>
  )
}
export function SettingsHeader({
  name,
  kind,
  profile,
  account,
  organizations,
  picture,
  accountPicture,
}: {
  name: string
  kind: 'Account' | 'Organization'
  profile: Profile
  account: string
  picture: ProfilePicture
  accountPicture?: ProfilePicture
  organizations: {
    name: string
    role: string
    profile: Profile
    picture: ProfilePicture
  }[]
}) {
  return (
    <header className={s.header}>
      <Picture name={name} picture={picture} org={kind === 'Organization'} />
      <div>
        {account ? (
          <details className={s.context}>
            <summary>
              {profile.displayName || name} <span className={s.dim}>⌄</span>
            </summary>
            <div className={s.menu}>
              <Link href="/settings/profile">
                <Picture name={account} picture={accountPicture} />
                <span>
                  @{account}
                  <small>Your account</small>
                </span>
              </Link>
              {organizations.map((o) => (
                <Link key={o.name} href={`/orgs/${o.name}/settings/general`}>
                  <Picture name={o.name} picture={o.picture} org />
                  <span>
                    {o.profile.displayName || '@' + o.name}
                    <small>Organization · {o.role}</small>
                  </span>
                </Link>
              ))}
              <Link href="/settings/organizations?new=1">
                ＋ New organization
              </Link>
            </div>
          </details>
        ) : (
          <strong style={{ fontSize: 22 }}>
            {profile.displayName || name}
          </strong>
        )}
        <div className={s.kind}>
          @{name} · {kind}
        </div>
      </div>
    </header>
  )
}
export function SettingsLayout({
  base,
  sections,
  children,
}: {
  base: string
  sections: Section[]
  children: React.ReactNode
}) {
  const here = usePathname(),
    router = useRouter(),
    key = here.slice(base.length + 1).split('/')[0]
  return (
    <div className={s.layout}>
      <nav className={s.nav} aria-label="Settings">
        {sections.map((section) => (
          <div key={section.key}>
            {section.group && <div className={s.group}>{section.group}</div>}
            {section.parent && <div className={s.parent}><Icon kind={section.icon} />{section.parent}</div>}
            <Link
              className={base.startsWith('/orgs/') && ['runners', 'runner-groups'].includes(section.key) ? s.subsection : undefined}
              href={`${base}/${section.key}`}
              aria-current={key === section.key ? 'page' : undefined}
            >
              <Icon kind={section.icon} />
              {section.label}
            </Link>
          </div>
        ))}
      </nav>
      <select
        className={s.select}
        aria-label="Settings section"
        value={key}
        onChange={(e) => router.push(`${base}/${e.target.value}`)}
      >
        {sections.map((section) => (
          <option key={section.key} value={section.key}>
            {section.label}
          </option>
        ))}
      </select>
      <section className={s.body}>{children}</section>
    </div>
  )
}
export function OrgTabs({
  name,
  repositories,
  people,
  settings,
}: {
  name: string
  repositories: number
  people: number
  settings: boolean
}) {
  const here = usePathname(),
    tab = useSearchParams().get('tab'),
    active = here.startsWith('/orgs/')
      ? 'Settings'
      : tab === 'people'
        ? 'People'
        : tab === 'repositories'
          ? 'Repositories'
          : 'Overview'
  return (
    <nav className={s.tabs} aria-label="Organization">
      {[
        { label: 'Overview', href: `/${name}` },
        {
          label: 'Repositories',
          href: `/${name}?tab=repositories`,
          count: repositories,
        },
        { label: 'People', href: `/${name}?tab=people`, count: people },
        ...(settings
          ? [{ label: 'Settings', href: `/orgs/${name}/settings/general` }]
          : []),
      ].map((t) => (
        <Link
          key={t.label}
          href={t.href}
          aria-current={t.label === active ? 'page' : undefined}
        >
          {t.label}
          {t.count !== undefined && <span className={s.count}>{t.count}</span>}
        </Link>
      ))}
    </nav>
  )
}
