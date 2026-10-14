import s from './settings/settings.module.css'
import { store } from '@/lib/backend'
import { pageViewer } from '@/lib/page'
/** Owner-page controls for the signed-in viewer, rendered on the server in
 *  the page's own response. A stored (anonymous) owner page renders none;
 *  the viewer's private repositories are already in the page's repo list. */
export async function PublicOwnerControls({owner}:{owner:string}) {
 const viewer=await pageViewer()
 if(!viewer)return null
 const role=viewer.name.toLowerCase()===owner?null:await (await store()).orgRole(owner,viewer.name)
 const writer=viewer.name.toLowerCase()===owner||role==='owner'||role==='admin'
 return writer?<p><a className={s.button} href={'/new?owner='+owner}>＋ New repo</a>{role&&<a className={s.button} href={'/orgs/'+owner+'/settings/general'}>Settings</a>}</p>:null
}
