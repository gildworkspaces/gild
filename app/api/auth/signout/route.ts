import { csrfSafe } from '@/lib/csrf'
import { NextResponse } from 'next/server'
import { clearSession } from '@/lib/session'

export async function POST(request:Request) {
  // This route is behind settingsHTTP, which strips caller origin markers and
  // stamps the original Worker origin before OpenNext rebuilds the URL.
  if(!csrfSafe(request,{trustWorkerOrigin:true}))return NextResponse.json({error:'Same-origin request required'},{status:403})
  const res = NextResponse.json({ ok: true })
  await clearSession(res)
  return res
}
