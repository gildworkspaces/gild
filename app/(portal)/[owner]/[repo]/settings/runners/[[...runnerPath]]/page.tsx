import { runnersPage } from '@/lib/actions/runners-page'
export default async function Page({params}:{params:Promise<{owner:string;repo:string;runnerPath?:string[]}>}) {const p=await params;return runnersPage(p.owner,'runners',p.runnerPath,p.repo)}
