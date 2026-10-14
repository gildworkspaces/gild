'use client'
import { useRouter } from 'next/navigation'
import { Sidebar as SidebarView } from '../packages/render/Sidebar'
import { clearPrivateSources } from '../packages/render/router'
import type { ProfilePicture } from '../lib/profile'
export function Sidebar({identity}:{identity?:{name:string;avatar?:ProfilePicture}|null}) {
  const router=useRouter()
  return <SidebarView identity={identity} onSignOut={async()=>{await clearPrivateSources().catch(()=>{});await fetch('/api/auth/signout',{method:'POST'});router.push('/');router.refresh()}}/>
}
