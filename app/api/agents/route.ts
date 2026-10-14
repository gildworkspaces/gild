import { legacy } from '@/lib/api/legacy'
export const GET = (request: Request) => legacy(request, 'agents', {})
