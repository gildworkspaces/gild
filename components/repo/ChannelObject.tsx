import IssuePage from '@/app/(portal)/[owner]/[repo]/issues/[number]/page'
import PullPage from '@/app/(portal)/[owner]/[repo]/pulls/[number]/page'
import { PreparedRepositoryObject } from './PreparedRepositoryObject'
import RunPage from '@/app/(portal)/[owner]/[repo]/actions/[run]/page'
export async function ChannelObject({owner,repo,object}:{owner:string;repo:string;object:string}) {
  const base=`/${owner}/${repo}`,url=new URL(object,'https://gild.gg')
  if(url.origin!=='https://gild.gg' || !(url.pathname===base || url.pathname.startsWith(base+'/')))return <p>Object not found.</p>
  const path=url.pathname.slice(base.length),sp=Promise.resolve(Object.fromEntries(url.searchParams))
  let m:RegExpExecArray|null
  if((m=/^\/issues\/(\d+)$/.exec(path)))return IssuePage({params:Promise.resolve({owner,repo,number:m[1]})})
  if((m=/^\/pulls\/(\d+)$/.exec(path)))return PullPage({params:Promise.resolve({owner,repo,number:m[1]}),searchParams:sp})
  if((m=/^\/commit\/([a-f0-9]{40})$/.exec(path)))return <PreparedRepositoryObject owner={owner} repo={repo} sha={m[1]} />
  if((m=/^\/actions\/(\d+)$/.exec(path)))return RunPage({params:Promise.resolve({owner,repo,run:m[1]})})
  if((m=/^\/blob\/([a-f0-9]{40})\/(.+)$/.exec(path)))return <PreparedRepositoryObject owner={owner} repo={repo} refName={m[1]} path={decodeURIComponent(m[2])} />
  if(path==='')return <PreparedRepositoryObject owner={owner} repo={repo} refName={url.searchParams.get('ref') ?? undefined} path={url.searchParams.get('path') ?? undefined} />
  return <p>Object not found.</p>
}
