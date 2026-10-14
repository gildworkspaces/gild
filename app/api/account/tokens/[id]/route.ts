import { legacy } from '@/lib/api/legacy'
export async function DELETE(
  r: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return legacy(r, 'deleteToken', await params)
}
