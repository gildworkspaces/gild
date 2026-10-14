import { runnersPage } from '@/lib/actions/runners-page'
export default async function Page({params,searchParams}:{searchParams:Promise<{group?:string}>;params:Promise<{org:string;runnerPath?:string[]}>}) {const p=await params;return runnersPage(p.org,'runners',p.runnerPath,undefined,(await searchParams).group)}
