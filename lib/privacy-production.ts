import { privacyHandler } from './collaborators'
import { store } from './backend'
import { repoIndex } from './repo-index'
import { writeMeta, DIR, readJson, writeJson } from './metastore'
export async function privacyOperations(c: import('./api/dispatch').Context) {
  return privacyHandler(
    { store: await store(), index: repoIndex },
    {
      acl: async (owner, repo, by, change) => {
        await writeMeta(
          owner,
          repo,
          'acl: update repository access',
          by,
          async (fs) => {
            const path = `${DIR}/.gild/acl.json`,
              acl =
                (await readJson<
                  import('./repo-list-snapshot').ListingSnapshot['acl']
                >(fs, path)) ?? {}
            change(acl)
            await writeJson(fs, path, acl)
          },
        )
      },
    },
  )(c)
}

/** Repository context carried by an owner-level URL still needs the same read
 * fence and token scope, before exposing an agent request or other private row. */
export async function requestMayRead(
  request: Request,
  owner: string,
  repo: string,
) {
  const [
    { getCloudflareContext },
    { requestViewer },
    { mayRead, repoAccess, privateAcl },
    { hasScope, permitsRepo },
  ] = await Promise.all([
    import('@opennextjs/cloudflare'),
    import('./fragments/production'),
    import('./repo-read'),
    import('./api/scopes'),
  ])
  const { env } = await getCloudflareContext(),
    viewer = await requestViewer(
      request,
      env as unknown as import('./fragments/production').ReadEnv,
    )
  const services = { store: await store(), index: repoIndex },
    policy = await repoAccess(services, owner, repo)
  if (!policy) return false
  if (
    (policy.pending || privateAcl(policy.acl)) &&
    (!viewer ||
      !hasScope(viewer, 'repo:read') ||
      !permitsRepo(viewer, owner, repo))
  )
    return false
  return mayRead(services, owner, repo, viewer?.name ?? null, policy)
}
