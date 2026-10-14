import { prefetched } from '../repo-context.ts'
import type { Principal } from '../api/scopes.ts'
import { dispatch } from '../api/dispatch.ts'
import { match } from '../api/routing.ts'
import { ApiError } from '../api/errors.ts'
import { channelHandler } from './service.ts'
import { d1RepoReads, d1Store } from '../drivers/d1.ts'
import { denySuspended } from '../token-verifier.ts'
import { requestViewer, type ReadEnv } from '../fragments/production.ts'
import { privateAcl } from '../repo-read.ts'
import { channelAccess } from './participants.ts'
import { hasScope, permitsRepo } from '../api/scopes.ts'
import { csrfSafe } from '../csrf.ts'
import type { ChannelBindings } from './binding.ts'
import type { Dependencies } from '../api/dispatch.ts'
export async function channelHTTP(request: Request, env: Omit<ReadEnv,'API_CONTROL'> & ChannelBindings & { API_CONTROL: {idFromName(s:string):unknown;get(id:unknown):Awaited<ReturnType<Dependencies['control']>>} }) {
  const route = match(request.method,new URL(request.url).pathname.replace(/^\/api\/v1/,''))
  if (!route?.route.id.startsWith('channel')) return null
  const st = d1Store(env.DB)
  const s = {store:st,index:async (owner:string,repo:string)=>env.REPO_INDEX.get(env.REPO_INDEX.idFromName((await st.settings.state(`${owner}/${repo}`)).id))}
  let access:Promise<Awaited<ReturnType<typeof channelAccess>>> | undefined
  const resolveAccess=(_s: Parameters<typeof channelAccess>[0],owner:string,repo:string,p:Principal)=>access ??= d1RepoReads(env.DB,owner,repo,p.name || null).then(reads=>channelAccess({...s,store:{...st,...prefetched(st,reads,owner,repo,p.name || null)}},owner,repo,p))
  return dispatch(request, {
    authenticate:async r=>{
      if (!r.headers.has('authorization') && !csrfSafe(r)) return null
      const p = await requestViewer(r,env)
      if (!p) {
        const token = r.headers.get('authorization')?.match(/^(?:Bearer|token) (gf_\w+)$/i)?.[1]
        if (token) await denySuspended(token, st)
        return null
      }
      return {...p,id:r.headers.has('authorization') ? p.id : `browser:${p.name}`}
    },
    control:async id=>env.API_CONTROL.get(env.API_CONTROL.idFromName(id)),
    account:async name=>(await import('../accounts.ts')).account(env.DB,name),
    readAccess:async(p,owner,repo)=>{
      const {policy} = await resolveAccess(s,owner,repo,p)
      if (policy.pending || privateAcl(policy.acl)) {
        if (!hasScope(p,'repo:read') || !permitsRepo(p,owner,repo)) throw new ApiError(404,'Repository not found')
        return 'private'
      }
      return 'public'
    },
    authorize:async()=>{},
    execute:channelHandler(s,async()=>env,resolveAccess),
  })
}
