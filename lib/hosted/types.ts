/** The seam between the open gild and the hosted gild.gg service.
 *
 *  Billing, plans and metering are not part of the open source: the hosted
 *  service overlays this directory at deploy time with its own metering.ts
 *  and billing.tsx. A self-hosted gild runs with the defaults here: nothing is
 *  metered and there is no Billing page. */
import type { D1Database } from '@cloudflare/workers-types'
import type { ReactNode } from 'react'

export type UsageSource = 'user' | 'artifacts'
export type UsageKind = 'pushed' | 'cloned' | 'fetched' | 'created' | 'imported' | 'forked'
export interface UsageRow { owner: string; repo: string; source: UsageSource; kind: UsageKind; count: number }

export interface Metering {
  recordUsage(db: D1Database, rows: UsageRow[], now?: number): Promise<void>
  recordStorage(db: D1Database, owner: string, repo: string, bytes: number, now?: number): Promise<void>
}
/** Renders the Billing settings page for an account or organization. */
export type BillingPage = (owner: string, repo: string | null) => Promise<ReactNode>
/** Extra ways in, shown above key sign-in (a client component). */
export type SignInOptions = (props: { next: string }) => ReactNode
