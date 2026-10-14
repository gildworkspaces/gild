import { bootstrap } from '@/lib/api/bootstrap'
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  return bootstrap(request, 'collect', await ctx.params)
}
