import { NextResponse } from 'next/server'
import {
  GRANTS,
  caller,
  mayWrite,
  readAcl,
  setAgentGrants,
  type Grant,
} from '@/lib/access'
import { store } from '@/lib/backend'

type Ctx = { params: Promise<{ owner: string; repo: string }> }

/** The agents granted anything in this repo (from .gild/acl.json). */
export async function GET(_: Request, ctx: Ctx) {
  const { owner, repo } = await ctx.params
  return NextResponse.json({
    agents: (await readAcl(owner, repo)).agents ?? {},
  })
}

/** { agent: "sami/codex", grants: ["pr", "review"] } — writers only. An empty
 *  list removes the agent from the repo. */
export async function POST(request: Request, ctx: Ctx) {
  const b = await request
    .clone()
    .json()
    .catch(() => ({}))
  return (await import('@/lib/api/legacy')).legacy(
    request,
    'setRepoAgent',
    await ctx.params,
    {
      ...b,
      agent: String(b.agent ?? '')
        .replace(/^@/, '')
        .toLowerCase(),
    },
  )
}
