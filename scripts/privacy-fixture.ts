import { privacyHTTP } from '../lib/privacy-http'
import { requestViewer } from '../lib/fragments/production'
import { store, readyIndex } from './api-fixture/runtime'
import { searchAPI } from '../lib/search'
import { repoList } from '../lib/repo-list'
import { gitProxy } from '../lib/gitproxy'
export async function privacyFixture(
  request: Request,
  env: any,
  forward: (r: Request) => Promise<Response>,
) {
  const st = await store(),
    viewer = await requestViewer(request, env),
    path = new URL(request.url).pathname
  return privacyHTTP(
    request,
    { store: st, index: readyIndex, viewer: async () => viewer },
    async (r) => {
      if (path === '/api/repos/acme/demo/search')
        return searchAPI(r, { owner: 'acme', repo: 'demo' })
      if (path === '/api/search') return searchAPI(r)
      if (path === '/acme' || path === '/' || path === '/explore')
        return Response.json(
          await repoList(
            'acme',
            path === '/' || path === '/explore' ? null : (viewer?.name ?? null),
          ),
        )
      if (path.startsWith('/git/') || path.startsWith('/acme/demo.git/')) {
        const at = path.startsWith('/git/') ? 3 : 2
        return gitProxy(r, {
          owner: 'acme',
          repo: 'demo',
          path: path.split('/').filter(Boolean).slice(at),
        })
      }
      if (path.startsWith('/acme/demo') && !path.includes('.git')) {
        const index = await readyIndex('acme', 'demo'),
          file = await index?.file('README.md'),
          contents = file ? await index?.blobText(file.hash) : null
        return Response.json({
          file: contents,
          meta: await index?.metaFile('.gild/index.json'),
        })
      }
      return forward(r)
    },
  )
}
