import { store } from '@/lib/backend'
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ hash: string }> },
) {
  const { hash } = await params
  if (!/^[a-f0-9]{64}$/.test(hash)) return new Response(null, { status: 404 })
  const bytes = await (await store()).settings.picture(hash)
  return bytes
    ? new Response(bytes.buffer as ArrayBuffer, {
        headers: {
          'content-type': 'image/webp',
          'cache-control': 'public, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
        },
      })
    : new Response(null, { status: 404 })
}
