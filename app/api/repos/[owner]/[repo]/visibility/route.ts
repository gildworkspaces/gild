import { legacy } from '@/lib/api/legacy'
export async function GET(
  r: Request,
  c: { params: Promise<{ owner: string; repo: string }> },
) {
  return legacy(r, 'repoVisibility', await c.params)
}
export async function PATCH(
  r: Request,
  c: { params: Promise<{ owner: string; repo: string }> },
) {
  return legacy(r, 'setRepoVisibility', await c.params)
}
