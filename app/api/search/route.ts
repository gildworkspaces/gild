import { searchAPI } from '@/lib/search'
export const GET = (request: Request) => searchAPI(request)
