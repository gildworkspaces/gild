import { legacy } from '@/lib/api/legacy'
export function GET(r: Request) {
  return legacy(r, 'profile', {})
}
export function PATCH(r: Request) {
  return legacy(r, 'updateProfile', {})
}
