'use client'
import { RepoIsland } from './RepoIsland'
import Link from '../Link'
import { usePublicViewer } from '../PublicViewer'
import s from '@/app/(portal)/[owner]/[repo]/repo.module.css'
type CreateProps={path:string;label:string;anonymous:string}
export function CreateItemView({path,label,anonymous}:CreateProps) {
 const viewer=usePublicViewer()
 return <Link href={viewer.name?path:'/auth/device?next='+encodeURIComponent(path)} className={viewer.name?s.primary:s.secondary}>{viewer.name?label:anonymous}</Link>
}
export function PublicCreateItem(props:CreateProps) {
 return <RepoIsland kind="create" props={props}><CreateItemView {...props}/></RepoIsland>
}
