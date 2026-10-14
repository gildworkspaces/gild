import { ApiError } from '../lib/api/errors'
import { snapshotSource } from '../lib/repo-index-source'
// Local-only worker harness. Production never exposes seed, SQL or a local
// git URL. It inherits RepoIndex's actual RPC reads and SQLite migrations.
import { RepoIndex } from '../lib/repo-index-do'
export class TestRepoIndex extends RepoIndex {
  protected connection() { return Promise.resolve({ url: this.index.setting('fixture-url')!, token: '' }) }
  protected async readObject(kind:'commit'|'tree'|'blob',hash:string) {
    const tip=this.index.resolve()!
    try {const source=await snapshotSource(this.index.setting('fixture-url')!,tip);return kind==='commit' ? {commit:await source.commit(hash)} : kind==='tree' ? {tree:await source.tree(hash)} : {bytes:await source.blob(hash)}}catch{throw new ApiError(404,'Fixture object not found')}
  }
  protected get lightHistory() { return false }
  evictRaw(hash:string) {this.ctx.storage.sql.exec('DELETE FROM blob_bytes WHERE hash=?',hash);this.ctx.storage.sql.exec('DELETE FROM hydrated_roots')}
  async indexFixture(url: string) {
    this.index.setting('fixture-url', url)
    if (!this.index.setting('owner')) await this.refresh('acme','demo')
    // Exercise the production alarm, including the advertisement and cursor.
    await this.alarm()
    const refs=this.refs();for(const ref of refs.refs)this.index.requestHistory(ref.hash);await this.alarm()
    const status = this.status()
    return { done: status.ready, pending: status.pending, counts: status.counts }
  }
  pendingRefAcknowledgementFixture(){
    const original=this.index.setting('fragments:pending-refs')??'{}'
    const unknown='f'.repeat(40),zero='0'.repeat(40)
    try{
      this.index.setting('fragments:pending-refs',JSON.stringify({main:unknown,_meta:unknown,feature:zero,'deleted-ref':zero}))
      this.acknowledgeIndexedRefs()
      return {unknown,zero,pending:JSON.parse(this.index.setting('fragments:pending-refs')!)}
    }finally{this.index.setting('fragments:pending-refs',original)}
  }
  private paginationTrace:any[]|null=null
  protected async preparePageChanges(){
    let before:any=null
    try{before=JSON.parse(this.index.setting('page:prepared-walk')??'null')}catch{}
    await super.preparePageChanges()
    if(this.paginationTrace)this.paginationTrace.push({before,after:JSON.parse(this.index.setting('page:prepared-walk')!)})
  }
  async preparedPaginationFixture(){
    this.paginationTrace=[]
    const tip=this.index.resolve()!
    this.ctx.storage.sql.exec("DELETE FROM api_views WHERE key LIKE 'page-change:%'")
    this.index.setting('page:prepared-walk','')
    this.index.setting('page:changes',JSON.stringify(Object.fromEntries(Array.from({length:100},(_,i)=>['fixture-busy-'+i,{kind:'commit',to:tip,from:null}]))))
    await this.preparePageChanges()
    const blocked={...JSON.parse(this.index.setting('page:prepared-walk')!),pending:Object.keys(JSON.parse(this.index.setting('page:changes')!)).length}
    // Only these deliberately seeded test jobs are removed; no production
    // caller or fixture client has submitted requests to this isolated index.
    this.index.setting('page:changes','{}')
    const pages=[]
    for(let step=0;step<30;step++){
      await this.preparePageChanges()
      // Drain actual hydration/index work requested by a distinct later head.
      await this.alarm()
      const state=JSON.parse(this.index.setting('page:prepared-walk')!)
      pages.push(state)
      const metadata=JSON.parse(this.index.metaFile('.gild/index.json')!)
      if(state.pulls===metadata.pulls.length&&!Object.keys(JSON.parse(this.index.setting('page:changes')!)).length)return {blocked,pages,producerCalls:this.paginationTrace,final:state}
    }
    throw new Error('Actual paginated producer did not complete within bounded fixture calls')
  }

  private conversationTrace:{before:number;after:number}[]|null=null
  protected async prepareConversationReads(){
    const count=async()=>Number((await this.env.DB.prepare('SELECT (SELECT count(*) FROM prepared_conversation_threads)+(SELECT count(*) FROM prepared_conversation_comments)+(SELECT count(*) FROM prepared_conversation_reviews) AS n').first<{n:number}>())!.n)
    const before=this.conversationTrace?await count():0
    await super.prepareConversationReads()
    if(this.conversationTrace)this.conversationTrace.push({before,after:await count()})
  }
  async preparedConversationFixture(){
    const state=await (await import('../lib/drivers/d1')).d1Store(this.env.DB).settings.state('acme/demo')
    for(const table of ['prepared_conversation_receipts','prepared_conversation_threads','prepared_conversation_comments','prepared_conversation_reviews','prepared_conversation_runs'])await this.env.DB.prepare('DELETE FROM '+table+' WHERE id=?').bind(state.id).run()
    this.ctx.storage.sql.exec("DELETE FROM settings WHERE key LIKE 'conversations:%'")
    this.conversationTrace=[]
    for(let step=0;step<30;step++){
      await this.alarm()
      const state=await (await import('../lib/drivers/d1')).d1Store(this.env.DB).settings.state('acme/demo')
      const receipt=await this.env.DB.prepare('SELECT c.generation FROM prepared_conversation_receipts c JOIN prepared_repository_refs f ON f.id=c.id AND f.epoch=c.epoch AND f.meta IS c.meta AND f.pending=0 WHERE c.id=?').bind(state.id).first<{generation:string}>()
      if(receipt)return {producerCalls:step+1,producerTrace:this.conversationTrace,generation:receipt.generation,counts:(await this.env.DB.prepare('SELECT threads,comments,reviews FROM prepared_conversation_runs WHERE id=? AND generation=?').bind(state.id,receipt.generation).first())}
    }
    throw new Error('Background conversations remain Pending')
  }
  legacyContentFixture(){
    const blob=this.index.file('binary.dat',this.index.resolve()!)!.hash
    this.evictRaw(blob)
    this.ctx.storage.sql.exec("DELETE FROM settings WHERE key LIKE 'content:%'")
    return {blob,rawBytesPresent:!!this.index.rawBlob(blob)}
  }
  async preparedContentFixture(){
    for(let step=0;step<30;step++){
      await this.alarm()
      const tips=[...new Set([...this.index.refs().map(r=>r.hash),...(this.index.setting('meta')?[this.index.setting('meta')!]:[])])]
      const {CONTENT_VERSION}=await import('../lib/prepared-repository-content')
      const state=await (await import('../lib/drivers/d1')).d1Store(this.env.DB).settings.state('acme/demo')
      if(tips.every(sha=>this.index.setting(`content:${CONTENT_VERSION}:${state.id}:${sha}`)==='ready'))return {producerCalls:step+1,tips}
    }
    throw new Error('Background content preparation remains Pending')
  }
  async preparedDiffFixture(url:string){
    for(let step=0;step<100;step++){
      await this.indexFixture(url)
      if(this.status().ready&&!Object.keys(JSON.parse(this.index.setting('page:changes')??'{}')).length)return
    }
    throw new Error('Actual diff producer did not finish within fixture bound')
  }

}
export default {
  async fetch(request: Request, env: { REPO_INDEX: { idFromName(name: string): unknown; get(id: unknown): { indexFixture: TestRepoIndex["indexFixture"]; status: TestRepoIndex["status"]; refs: TestRepoIndex["refs"]; search: TestRepoIndex["search"]; findFiles: TestRepoIndex["findFiles"]; findSymbols: TestRepoIndex["findSymbols"] } } }) {
    const index = env.REPO_INDEX.get(env.REPO_INDEX.idFromName('acme/demo'))
    const url = new URL(request.url)
    if (url.pathname === '/index' && request.method === 'POST') {
      const body = await request.json() as { url: string }
      return Response.json(await index.indexFixture(body.url))
    }
    if (url.pathname === '/status') return Response.json(await index.status())
    const q = url.searchParams.get('q') ?? ''
    const refs = await index.refs(), ref = refs.defaultBranch
    const result = await index.search(q,{ repo:'acme/demo',ownerKind:'org' })
    const suggestions = [...(await index.findFiles(q,ref,8)).map((f) => ({ ...f, repo:'acme/demo',ref,line:1,kind:'file' })),...(await index.findSymbols(q,ref)).map((f) => ({ ...f,repo:'acme/demo',ref,kind:'symbol' }))]
    return Response.json({ ...result,suggestions,indexing:false })
  },
}
