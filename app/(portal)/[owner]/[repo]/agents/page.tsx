import { RepoIsland } from '@/components/repo/RepoIsland'
import { headers } from 'next/headers'
import { getCloudflareContext } from '@opennextjs/cloudflare'
import { channelInitial, type ChannelEnv } from '@/lib/channel/initial'
import { pageReads, pageViewer } from '@/lib/page'
import { notFound } from 'next/navigation'
import { ApiError } from '@/lib/api/errors'
import { Suspense } from 'react'
import { RepoChannel } from '@/components/repo/Channel'
import { ChannelModal } from '@/components/repo/ChannelModal'
import { ChannelObject } from '@/components/repo/ChannelObject'
export const dynamic = 'force-dynamic'
export default async function AgentsTab({params,searchParams}:{params:Promise<{owner:string;repo:string}>;searchParams:Promise<{object?:string}>}) {
  const {owner,repo}=await params,{object}=await searchParams
  const {env}=await getCloudflareContext()
  let initial
  // The viewer and policy rows come from this request's page reads (the
  // Worker's one batch): the channel adds only its Durable Object snapshot.
  const [reads,viewer]=await Promise.all([pageReads(owner,repo),pageViewer()])
  const given={reads,viewer:viewer?{id:'',name:viewer.name,publicKey:'',scopes:null,repos:null}:null}
  try {initial=await channelInitial(new Request('https://gild.gg/'+owner+'/'+repo+'/agents',{headers:await headers()}),env as unknown as ChannelEnv,owner,repo,given)}
  catch(e){if(e instanceof ApiError && e.status===404)notFound();throw e}
  return <>
    <RepoIsland kind="agents" props={{owner,repo,initial}}><RepoChannel key={`${owner}/${repo}`} owner={owner} repo={repo} initial={initial}/></RepoIsland>
    {object && <ChannelModal base={`/${owner}/${repo}`} object={object}><Suspense fallback={<p>Loading…</p>}><ChannelObject owner={owner} repo={repo} object={object}/></Suspense></ChannelModal>}
  </>
}
