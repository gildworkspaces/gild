// Reading refs from git itself (kept apart from lib/repo-refs.ts, which is
// pure and unit-tested).
import * as git from 'isomorphic-git'
import http from 'isomorphic-git/http/web'
import { readToken, repoRemote } from './artifacts'
import { refsFromAdvertisement, type Refs } from './repo-refs'
import type { ForgeStore } from './backend'
import type { FenceDB } from './import/fence'

export interface LiveRefsRuntime {
  connection(scope: 'read'): Promise<{ token: string; url: string }>
  store: Pick<ForgeStore, 'settings'>
  DB: FenceDB
}

/** The refs git advertises right now (one `ls-remote`). Throws when the repo
 *  doesn't exist, which is how callers tell a real repo from a typo. */
export async function listRefs(owner: string, repo: string, runtime?: LiveRefsRuntime): Promise<Refs> {
  const connection = runtime ? await runtime.connection('read')
    : { token: (await readToken(owner, repo)).plaintext, url: await repoRemote(owner, repo) }
  const refs = await git.listServerRefs({
    http,
    url: connection.url,
    headers: { authorization: `Bearer ${connection.token}` },
    symrefs: true,
    peelTags: true,
  })
  const { internalPrefix } = await import('./import/visibility')
  const db = runtime ? runtime.DB : ((await (await import('@opennextjs/cloudflare')).getCloudflareContext()).env as unknown as { DB: FenceDB }).DB
  const result = refsFromAdvertisement(refs,await internalPrefix(db,`${owner}/${repo}`))
  const store = runtime?.store ?? await (await import('./backend')).store()
  result.defaultBranch = (await store.settings.state(`${owner}/${repo}`)).defaultBranch ?? result.defaultBranch
  return result
}
