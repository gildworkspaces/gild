import { cache } from 'react'
import { cookies } from 'next/headers'
import { pageViewer } from './page'
import type { NextResponse } from 'next/server'
import {
  verifySessionCookie,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  sessionCookieDomain,
} from './session-cookie'

export interface Session {
  name?: string
  publicKey: string
  at: string
}

// The browser session: a cookie issued only after a terminal-signed
// challenge, holding the signing key (and the claimed name when known),
// HMAC-signed with the Worker secret SESSION_SECRET so it cannot be edited
// into someone else's. Without the secret no session is accepted or issued.
//
//   gild_session = base64url(json) "." base64url(hmac-sha256(base64url(json)))

const COOKIE = SESSION_COOKIE
const MAX_AGE = SESSION_MAX_AGE

async function secret(): Promise<CryptoKey | null> {
  let value: unknown
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare')
    value = ((await getCloudflareContext()).env as Record<string, unknown>)
      .SESSION_SECRET
  } catch {
    return null
  }
  if (typeof value !== 'string' || value.length < 32) return null
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(value),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

async function cookieDomain(): Promise<string | undefined> {
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare')
    return sessionCookieDomain(((await getCloudflareContext()).env as { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN)
  } catch {
    return undefined
  }
}

const b64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString('base64url')

/** Sets the signed session cookie on a response. */
export async function issueSession(
  res: NextResponse,
  data: { publicKey: string; name?: string },
) {
  const key = await secret()
  if (!key) throw new Error('SESSION_SECRET is not set on this worker')
  const payload = Buffer.from(
    JSON.stringify({ ...data, at: new Date().toISOString() }),
  ).toString('base64url')
  const mac = b64(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)),
  )
  res.cookies.set(COOKIE, `${payload}.${mac}`, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE,
    domain: await cookieDomain(),
  })
}

export async function clearSession(res: NextResponse) {
  const domain = await cookieDomain()
  res.cookies.set(COOKIE, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
    domain,
  })
  // Sessions issued before the shared domain are host-only: clear those too.
  if (domain) res.headers.append('set-cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`)
}

/** The caller's session, or null when there is none or its signature fails.
 *  The name is resolved from the claims store when the cookie has none, so a
 *  session issued before its claim still identifies the caller. Cached per
 *  request: layouts and pages share one answer (and one claims read). */
export const session = cache(async (): Promise<Session | null> => {
  const raw = (await cookies()).get(COOKIE)?.value
  const { getCloudflareContext } = await import('@opennextjs/cloudflare')
  let value: string | undefined
  try {
    value = (
      (await getCloudflareContext()).env as unknown as {
        SESSION_SECRET?: string
      }
    ).SESSION_SECRET
  } catch {
    return null
  }
  const s = await verifySessionCookie(raw, value)
  if (s && !s.name) {
    const viewer = await pageViewer()
    if (viewer) s.name = viewer.name
  }
  return s
})
