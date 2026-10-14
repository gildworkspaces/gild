import { legacy } from '@/lib/api/legacy'
export function PUT(r: Request) {
  return legacy(r, 'updatePicture', {})
}

export function DELETE(r: Request) {
  return legacy(r, 'deletePicture', {})
}
