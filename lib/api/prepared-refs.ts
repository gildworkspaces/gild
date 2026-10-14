import type {Context} from './dispatch.ts'
import {paginate} from './dispatch.ts'
import {apiURL,repoPath} from './shapes.ts'
import {requireFound} from './errors.ts'
import type {PreparedRefs} from '../prepared-repository-producer.ts'
export function preparedRefsResponse(c:Context,refs:PreparedRefs){
  const id=c.route.id,path=repoPath(c)
    if (id === 'branches')
      return paginate(
        refs.refs
          .filter((r) => r.kind === 'branch')
          .map((r) => ({
            name: r.name,
            commit: {
              sha: r.hash,
              url: apiURL(c, `${path}/commits/${r.hash}`),
            },
            protected: r.name === refs.defaultBranch,
          })),
        c,
      )
    const refShape = (r: (typeof refs.refs)[number]) => ({
      ref: `refs/${r.kind === 'branch' ? 'heads' : 'tags'}/${r.name}`,
      node_id: r.hash,
      url: apiURL(
        c,
        `${path}/git/ref/${r.kind === 'branch' ? 'heads' : 'tags'}/${r.name}`,
      ),
      object: {
        type: 'commit',
        sha: r.hash,
        url: apiURL(c, `${path}/git/commits/${r.hash}`),
      },
    })
    if (id === 'refs') return paginate(refs.refs.map(refShape), c)
    if (id === 'ref')
      return {
        data: refShape(
          requireFound(
            refs.refs.find(
              (r) =>
                `${r.kind === 'branch' ? 'heads' : 'tags'}/${r.name}` ===
                c.params.ref,
            ),
          ),
        ),
      }
  throw new Error('Unknown prepared refs operation')
}
