import { legacy } from '@/lib/api/legacy'
import { NextResponse } from 'next/server'
import { store } from '@/lib/backend'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params
  const st = await store()
  const org = await st.getOrg(name)
  if (!org)
    return NextResponse.json({ error: 'org not found' }, { status: 404 })
  const members = await st.orgMembers(org.name)
  return NextResponse.json({ org, members })
}

export async function DELETE(r:Request,{params}:{params:Promise<{name:string}>}){return legacy(r,'deleteOrg',{org:(await params).name})}
