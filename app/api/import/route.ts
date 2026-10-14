import { whoIsCalling } from '@/lib/caller'
import { legacy } from '@/lib/api/legacy'
export async function POST(request:Request) {
  const caller=await whoIsCalling(request.clone())
  if(!caller) return Response.json({error:'Sign in to import a repository'},{status:401})
  const body=caller.body??await request.clone().json(),owner=body.owner??caller.name
  return legacy(request,owner===caller.name?'importCreate':'importOrgCreate',owner===caller.name?{}:{org:owner},body)
}
