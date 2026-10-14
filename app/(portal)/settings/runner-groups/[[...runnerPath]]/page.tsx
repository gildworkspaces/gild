import { runnersPage } from '@/lib/actions/runners-page'
export default async function Page({params}:{params:Promise<{runnerPath?:string[]}>}) {const p=await params;return runnersPage(undefined,'runner-groups',p.runnerPath)}
