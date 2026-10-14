import assert from 'node:assert/strict'

export async function preparedReadHTTP({GildClient,origin,token,request,gitReads}){
  assert.equal((await request('/prepared-reads-fixture','POST',{health:true,diffs:true})).status,200)
  const client=new GildClient(origin+'/api/v1',token),covered=[]
  const exercise=async(id,params,query)=>{
    const data=await client.request(id,params,undefined,query)
    covered.push(id);return data
  }
  const before=gitReads()
  const cards=await exercise('ownerRepoCards',{owner:'acme'},{per_page:1})
  assert.equal(cards.owner,'acme');assert.deepEqual(cards.items.map(r=>r.name),['demo'])
  assert.equal(cards.nextPage,null);assert.equal(cards.items[0].description,'API fixture')
  assert.equal(cards.items[0].createdAt,new Date(0).toISOString())
  const profile=await exercise('publicDisplayProfile',{owner:'acme'})
  assert.equal(profile.name,'acme');assert.equal(profile.kind,'user')
  assert.ok(!JSON.stringify(profile).includes('fixture@example.test'),'private claim email must not appear in public profile')
  assert.ok(!JSON.stringify(profile).includes('ed25519:fixture'),'claim key must not be serialized')
  const viewer=await exercise('viewerContext',{}, {owner:'acme',repo:'demo'})
  assert.equal(viewer.viewer.name,'acme');assert.equal(viewer.repository.read,true)
  assert.equal(viewer.repository.editPackageManifest,true)
  assert.equal(viewer.repository.updateSettings,true)
  const branches=await exercise('branches',{owner:'acme',repo:'demo'})
  assert.equal(branches.find(b=>b.name==='main').protected,true)
  const refs=await exercise('refs',{owner:'acme',repo:'demo'})
  assert.ok(refs.some(r=>r.ref==='refs/heads/topic/with-slash'))
  const ref=await exercise('ref',{owner:'acme',repo:'demo',ref:'heads/topic/with-slash'})
  assert.equal(ref.ref,'refs/heads/topic/with-slash')
  assert.equal(ref.object.sha,refs.find(r=>r.ref===ref.ref).object.sha)
  const report=await exercise('health',{owner:'acme',repo:'demo'},{ref:'main'})
  const main=refs.find(r=>r.ref==='refs/heads/main').object.sha
  const immutable=await exercise('healthAt',{owner:'acme',repo:'demo',sha:main})
  assert.deepEqual(immutable,report)
  assert.ok(report===null||report.lines>0,'real producer must prepare the seeded source report')
  const commitChange=await exercise('commitChanges',{owner:'acme',repo:'demo',sha:main})
  assert.equal(commitChange.to,main);assert.ok(commitChange.files.some(f=>f.path==='src/main.ts'))
  const pullChange=await exercise('pullChanges',{owner:'acme',repo:'demo',number:2})
  assert.equal(pullChange.from,main);assert.equal(pullChange.to,refs.find(r=>r.ref==='refs/heads/feature').object.sha)
  assert.ok(pullChange.files.some(f=>f.path==='src/main.ts'&&f.hunks.some(h=>h.lines.some(line=>line.includes('hello v1')))))
  const privateResponse=await request('/api/v1/viewer/context?owner=acme&repo=demo')
  assert.equal(privateResponse.status,200);assert.match(privateResponse.headers.get('cache-control'),/no-store/)
  assert.equal((await fetch(origin+'/api/v1/viewer/context')).status,401)
  const anonymous=new GildClient(origin+'/api/v1','',async(input,init)=>{
    const headers=new Headers(init.headers);headers.delete('authorization')
    return fetch(input,{...init,headers})
  })
  assert.equal((await anonymous.request('publicDisplayProfile',{owner:'acme'})).name,'acme')
  assert.deepEqual((await anonymous.request('ownerRepoCards',{owner:'acme'})).items.map(r=>r.name),['demo'])
  await assert.rejects(client.request('publicDisplayProfile',{owner:'not-found'}),error=>error.status===404)
  assert.equal(gitReads(),before,'prepared route HTTP reads must never contact Git')
  assert.equal((await request('/prepared-reads-fixture','POST',{pending:true})).status,200)
  await assert.rejects(client.request('ownerRepoCards',{owner:'acme'}),error=>{
    assert.equal(error.status,503);assert.equal(error.code,'PREPARATION_PENDING')
    assert.deepEqual(error.codes,['PREPARATION_PENDING']);return true
  })
  assert.equal(gitReads(),before,'unprepared HTTP response must not perform ingestion')
  assert.equal((await request('/prepared-reads-fixture','POST',{})).status,200)
  console.log('Prepared reads: ten schema-validated compiled Worker HTTP routes including actual commit/pull diff facts; safe fields/capabilities, anonymous boundary, typed503 and zero Git reads passed')
  return covered
}
