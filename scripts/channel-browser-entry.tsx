import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { RepoChannel } from '../components/repo/Channel'
import { ChannelModal } from '../components/repo/ChannelModal'
import { CommentForm, IssueActions } from '../components/repo/IssueForms'
function App() {
  const [url,setURL]=useState(location.href),[revision,setRevision]=useState(0),[issue,setIssue]=useState<any>(null),[comments,setComments]=useState<any[]>([])
  const object=new URL(url).searchParams.get('object')
  useEffect(()=>{const update=()=>{setURL(location.href);setRevision(n=>n+1)};addEventListener('popstate',update);addEventListener('fixture-navigation',update);return()=>{removeEventListener('popstate',update);removeEventListener('fixture-navigation',update)}},[])
  useEffect(()=>{if(object?.includes('/issues/1'))void Promise.all([fetch('/api/v1/repos/acme/demo/issues/1').then(r=>r.json()),fetch('/api/v1/repos/acme/demo/issues/1/comments').then(r=>r.json())]).then(([i,c])=>{setIssue(i);setComments(c)})},[url,object,revision])
  return <><RepoChannel owner="acme" repo="demo" initial={(window as any).__channelInitial}/>{object&&<ChannelModal base="/acme/demo" object={object}>{issue&&<><h2>{issue.title}</h2><p>{issue.body}</p>{comments.map(c=><p key={c.id}>{c.body}</p>)}<IssueActions owner="acme" repo="demo" number={1} actions={[{action:issue.state==='open'?'close':'reopen',label:issue.state==='open'?'Close issue':'Reopen issue'}]}/><CommentForm owner="acme" repo="demo" number={1}/></>}</ChannelModal>}</>
}
createRoot(document.getElementById('app')!).render(<App/> )
