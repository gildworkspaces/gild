import assert from 'node:assert/strict'

// Fixture preparation only: a successful HTTP response can explicitly decline
// publication while the producer is Pending or its input fence changes.
export async function publishFixturePage(f,path,deadline=Date.now()+180000,prepare=fetch) {
  for(;;){
    const response=await prepare(f.origin+'/__fixture/public-pages?route='+encodeURIComponent(path))
    assert.equal(response.status,200)
    const result=await response.json()
    if(result.published===true)return result
    assert.ok(Date.now()<deadline,path+' publication: '+f.logs.slice(-3000))
    await new Promise(resolve=>setTimeout(resolve,250))
  }
}

// Cold fixture indexing and publication can overlap. Require real stored pages
// before measuring transitions, rather than accepting a 503 retry shell.
export async function publishRepoTabs(f, base) {
  const deadline = Date.now() + 180000
  while (true) {
    try {
      const response = await fetch(f.origin + base, {
        signal: AbortSignal.timeout(10000),
      })
      const html = await response.text()
      if (response.status === 200 && response.headers.get('x-gild-state') !== 'pending' && !html.includes('data-artifact-pending')) break
    } catch {}
    assert.ok(Date.now() < deadline, 'Fixture startup: ' + f.logs.slice(-3000))
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  for (const tab of ['issues', 'pulls', 'actions', 'agents']) {
    await publishFixturePage(f,base+'/'+tab,deadline)
  }
  // A successful Pending response is not a prepared Score artifact either.
  // Finish producer initialization before measuring the deliberate metadata miss.
  for (;;) {
    const response = await fetch(f.origin + base + '/score', { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(10000) })
    const html = await response.text()
    if (response.status === 200 && response.headers.get('x-gild-state') !== 'pending' && !html.includes('data-artifact-pending')) break
    assert.ok(Date.now() < deadline, 'Score preparation: ' + f.logs.slice(-3000))
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}
