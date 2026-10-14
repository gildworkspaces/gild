import { runnersPage } from '@/lib/actions/runners-page'
export default async function Page({params,searchParams}:{searchParams:Promise<{group?:string}>;params:Promise<{runnerPath?:string[]}>}) {const p=await params;return runnersPage(undefined,'runners',p.runnerPath,undefined,(await searchParams).group)}
