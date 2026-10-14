import { legacy } from '@/lib/api/legacy'
export function GET(r: Request) {
  return legacy(r, 'tokens', {})
}
export function POST(r: Request) {
  return legacy(r, 'createToken', {})
}
