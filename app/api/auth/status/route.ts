import { browserStatus } from '@/lib/browser-status'
export function GET(request: Request) { return browserStatus(request, 'auth') }
