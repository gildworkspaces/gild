import { runnersPage } from '@/lib/actions/runners-page'
export default async function Page({params}:{params:Promise<{org:string;runnerPath?:string[]}>}) {const p=await params;return runnersPage(p.org,'runner-groups',p.runnerPath)}
