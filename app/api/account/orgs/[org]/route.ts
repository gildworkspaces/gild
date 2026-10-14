import { legacy } from '@/lib/api/legacy'
export async function DELETE(
  r: Request,
  { params }: { params: Promise<{ org: string }> },
) {
  return legacy(r, 'leaveOrg', await params)
}
