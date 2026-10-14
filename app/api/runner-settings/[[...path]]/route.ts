import { dependencies } from '@/lib/api/production'
import { dispatch } from '@/lib/api/dispatch'
import { session } from '@/lib/session'
async function handle(request: Request) {
  if (request.headers.get('x-gild-browser-intent') !== 'same-origin')
    return Response.json(
      { message: 'Same-origin request required' },
      { status: 403 },
    )
  const me = await session()
  if (!me?.name)
    return Response.json({ message: 'Sign in required' }, { status: 401 })
  const url = new URL(request.url)
  url.pathname = url.pathname.replace('/api/runner-settings', '/api/v1')
  const deps = await dependencies()
  return dispatch(new Request(url, request), {
    ...deps,
    authenticate: async () => ({
      id: 'session:' + me.name,
      name: me.name!,
      publicKey: me.publicKey,
      scopes: null,
      repos: null,
    }),
  })
}
export {
  handle as GET,
  handle as POST,
  handle as PATCH,
  handle as PUT,
  handle as DELETE,
}
