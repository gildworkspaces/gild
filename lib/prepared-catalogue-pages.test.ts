import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {readFileSync,readdirSync} from 'node:fs'
import {beginCatalogueObservation,catalogueObservationProgress,beginCataloguePage,stageCataloguePageRows,commitCataloguePage,publishCatalogueObservation,
  cataloguePageDigest,advanceCatalogueObservation,resumableCatalogueObservation,type CatalogueObservation,type CatalogueSourcePage} from './prepared-catalogue-pages.ts'
import {publishPreparedCatalogue,type CatalogueRepository} from './prepared-catalogue-producer.ts'
function fixture(){
  const db=new DatabaseSync(':memory:')
  for(const f of readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync('migrations/'+f,'utf8'))
  db.prepare('INSERT INTO claims VALUES (?,?,?,?,?)').run('alice','fixture','alice@test.invalid',1,'2026-10-13')
  let maxBatch=0,maxBindings=0,publicationStatements=0
  const prepare=(q:string,a:any[]=[])=>({bind:(...v:any[])=>{maxBindings=Math.max(maxBindings,v.length);return prepare(q,v)},
    async first(){return db.prepare(q).get(...a)??null},async all(){return {results:db.prepare(q).all(...a)}},
    async run(){if(q.includes('INSERT INTO prepared_repositories SELECT'))publicationStatements++;return {success:true,meta:db.prepare(q).run(...a)}}})
  const sql={prepare,async batch(items:any[]){maxBatch=Math.max(maxBatch,items.length);db.exec('BEGIN');try{
    const out=[];for(const i of items)out.push(await i.run());db.exec('COMMIT');return out
  }catch(e){db.exec('ROLLBACK');throw e}}}
  const ticket=(generation:string,startedAt=100):CatalogueObservation=>({owner:'alice',kind:'user',generation,startedAt})
  const rows=()=>db.prepare(`SELECT r.name FROM prepared_repositories r JOIN prepared_catalogues c ON c.owner=r.owner AND c.checked_at=r.checked_at WHERE r.active=1 ORDER BY r.name`).all()
  return {db,sql,ticket,rows,effects:()=>({maxBatch,maxBindings,publicationStatements}),close:()=>db.close()}
}
const row=(i:number):CatalogueRepository=>({name:'repo-'+i,id:'id-'+i,description:null,defaultBranch:'main',createdAt:null,updatedAt:null})
async function page(f:ReturnType<typeof fixture>,t:CatalogueObservation,cursor:string|null,nextCursor:string|null,rows:CatalogueRepository[],terminal=nextCursor===null){
  await beginCataloguePage(f.sql as any,t,{cursor,nextCursor,terminal,rowCount:rows.length,digest:await cataloguePageDigest(rows)})
  for(let offset=0;offset<rows.length;offset+=100)await stageCataloguePageRows(f.sql as any,t,cursor,offset,rows.slice(offset,offset+100))
  assert.equal(await commitCataloguePage(f.sql as any,t,cursor),true)
}
test('complete inventory beyond1000 publishes atomically with bounded staging and one INSERT SELECT',async()=>{
  const f=fixture();try{
    const t=f.ticket('large');assert.ok(await beginCatalogueObservation(f.sql as any,t))
    let sourceCalls=0
    const source=async(_owner:string,_kind:string,cursor:string|null,generation:string):Promise<CatalogueSourcePage>=>{
      sourceCalls++;const index=cursor?Number(cursor):0,end=Math.min(index+200,1203)
      return {generation,cursor,nextCursor:end===1203?null:String(end),terminal:end===1203,rows:Array.from({length:end-index},(_,j)=>row(index+j))}
    }
    for(let i=0;i<6;i++){
      const result=await advanceCatalogueObservation(f.sql as any,t,source)
      assert.equal(sourceCalls,i+1,'one source page per scheduled invocation');assert.equal(result.ready,false);assert.deepEqual(f.rows(),[])
    }
    const done=await advanceCatalogueObservation(f.sql as any,t,source);assert.equal(done.ready,true)
    assert.equal(f.rows().length,1203);assert.equal(f.db.prepare('SELECT checked_at FROM prepared_catalogues').get()!.checked_at,100)
    assert.ok(f.effects().maxBatch<=4);assert.ok(f.effects().maxBindings<30)
    assert.equal(f.effects().publicationStatements,1)
  }finally{f.close()}
})
test('interrupted chunk resumes exact observation and preserves prior valid reader generation',async()=>{
  const f=fixture();try{
    const old=f.ticket('old',10);await beginCatalogueObservation(f.sql as any,old);await page(f,old,null,null,[row(99)]);await publishCatalogueObservation(f.sql as any,old)
    const t=f.ticket('new',100),rows=Array.from({length:200},(_,i)=>row(i)),digest=await cataloguePageDigest(rows)
    await beginCatalogueObservation(f.sql as any,t)
    const facts={cursor:null,nextCursor:'second',terminal:false,rowCount:200,digest}
    await beginCataloguePage(f.sql as any,t,facts);await stageCataloguePageRows(f.sql as any,t,null,0,rows.slice(0,100))
    const resumed=await resumableCatalogueObservation(f.sql as any,'alice');assert.equal(resumed!.generation,t.generation);assert.equal(resumed!.startedAt,100)
    assert.equal(await commitCataloguePage(f.sql as any,t,null),false);assert.equal(await publishCatalogueObservation(f.sql as any,t),false)
    assert.equal(f.rows()[0].name,'repo-99')
    assert.equal(await beginCataloguePage(f.sql as any,t,facts),100)
    await assert.rejects(stageCataloguePageRows(f.sql as any,t,null,0,rows.slice(0,100)),/replayed/)
    await stageCataloguePageRows(f.sql as any,t,null,100,rows.slice(100));assert.equal(await commitCataloguePage(f.sql as any,t,null),true)
    assert.equal(f.rows().length,1);await page(f,t,'second',null,[row(201)])
    assert.equal(await publishCatalogueObservation(f.sql as any,t),true);assert.equal(f.rows().length,201)
    assert.equal(f.db.prepare('SELECT checked_at FROM prepared_catalogues').get()!.checked_at,100)
  }finally{f.close()}
})
test('cursor replay, cycle, generation mismatch and unknown completeness reject without partial receipt',async()=>{
  const f=fixture();try{
    const t=f.ticket('cursor');await beginCatalogueObservation(f.sql as any,t)
    await assert.rejects(advanceCatalogueObservation(f.sql as any,t,async()=>({generation:'wrong',cursor:null,nextCursor:null,terminal:true,rows:[]})),/Mismatched/)
    await assert.rejects(advanceCatalogueObservation(f.sql as any,t,async()=>({generation:t.generation,cursor:null,rows:Array.from({length:200},(_,i)=>row(i))} as any)),/cursor|completeness/)
    assert.equal(await publishCatalogueObservation(f.sql as any,t),false)
    await page(f,t,null,'a',[row(1)]);await page(f,t,'a','b',[row(2)])
    await assert.rejects(beginCataloguePage(f.sql as any,t,{cursor:'b',nextCursor:'a',terminal:false,rowCount:0,digest:await cataloguePageDigest([])}),/cycle/)
    await assert.rejects(beginCataloguePage(f.sql as any,t,{cursor:'a',nextCursor:'b',terminal:false,rowCount:1,digest:await cataloguePageDigest([row(2)])}),/replayed/)
    assert.deepEqual(f.rows(),[])
    assert.equal((await catalogueObservationProgress(f.sql as any,t))!.cursor,'b')
  }finally{f.close()}
})
test('explicit full200 terminal and genuine empty complete pages certify, duplicate/malformed inventory cannot',async()=>{
  const f=fixture();try{
    const t=f.ticket('full');await beginCatalogueObservation(f.sql as any,t)
    await page(f,t,null,null,Array.from({length:200},(_,i)=>row(i)),true);assert.equal(await publishCatalogueObservation(f.sql as any,t),true)
    const empty=f.ticket('empty',200);await beginCatalogueObservation(f.sql as any,empty);await page(f,empty,null,null,[])
    assert.equal(await publishCatalogueObservation(f.sql as any,empty),true);assert.deepEqual(f.rows(),[])
    const duplicate=f.ticket('duplicate',300);await beginCatalogueObservation(f.sql as any,duplicate);await page(f,duplicate,null,'next',[row(1)])
    await beginCataloguePage(f.sql as any,duplicate,{cursor:'next',nextCursor:null,terminal:true,rowCount:1,digest:await cataloguePageDigest([row(1)])})
    await assert.rejects(stageCataloguePageRows(f.sql as any,duplicate,'next',0,[row(1)]),/UNIQUE/)
    await assert.rejects(stageCataloguePageRows(f.sql as any,duplicate,'next',0,[{...row(2),id:undefined as any}]),/Invalid/)
    assert.equal(await commitCataloguePage(f.sql as any,duplicate,'next'),false);assert.equal(await publishCatalogueObservation(f.sql as any,duplicate),false)
    assert.deepEqual(f.rows(),[])
    const changed=f.ticket('changed',400);await beginCatalogueObservation(f.sql as any,changed)
    await beginCataloguePage(f.sql as any,changed,{cursor:null,nextCursor:null,terminal:true,rowCount:1,digest:await cataloguePageDigest([row(7)])})
    await stageCataloguePageRows(f.sql as any,changed,null,0,[row(8)])
    await assert.rejects(commitCataloguePage(f.sql as any,changed,null),/differs from observed/)
    assert.equal(await publishCatalogueObservation(f.sql as any,changed),false)
  }finally{f.close()}
})
test('new observation and current owner lifecycle prevent stale completion or resurrection',async()=>{
  const f=fixture();try{
    const old=f.ticket('old',100);await beginCatalogueObservation(f.sql as any,old);await page(f,old,null,null,[row(1)])
    const next=f.ticket('next',200);await beginCatalogueObservation(f.sql as any,next)
    assert.equal(await publishCatalogueObservation(f.sql as any,old),false);assert.equal(await beginCatalogueObservation(f.sql as any,f.ticket('late',150)),null)
    await page(f,next,null,null,[row(2)]);assert.equal(await publishCatalogueObservation(f.sql as any,next),true)
    assert.equal(await publishCatalogueObservation(f.sql as any,old),false);assert.equal(f.rows()[0].name,'repo-2')
    const deleted=f.ticket('delete',300);await beginCatalogueObservation(f.sql as any,deleted);await page(f,deleted,null,null,[row(3)])
    f.db.prepare('INSERT INTO settings_entities(key,id,deleted_at) VALUES (?,?,1)').run('alice','alice')
    assert.equal(await publishCatalogueObservation(f.sql as any,deleted),false);assert.equal(f.rows()[0].name,'repo-2')
    f.db.prepare('UPDATE settings_entities SET deleted_at=NULL,moving=1').run()
    assert.equal(await publishCatalogueObservation(f.sql as any,deleted),false)
    f.db.prepare('UPDATE owner_names SET kind=?').run('user')
    await publishPreparedCatalogue(f.sql as any,'alice',[row(9)],400)
    assert.equal(await publishCatalogueObservation(f.sql as any,deleted),false,'newer complete receipt wins even against terminal pending producer')
    assert.equal(f.rows()[0].name,'repo-9')
    f.db.prepare('UPDATE settings_entities SET moving=0').run();f.db.prepare('UPDATE owner_names SET kind=?').run('org')
    assert.equal(await publishCatalogueObservation(f.sql as any,deleted),false)
  }finally{f.close()}
})
