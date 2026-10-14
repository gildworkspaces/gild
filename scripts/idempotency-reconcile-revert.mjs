import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
mkdirSync('.tmp/idempotency-review', { recursive: true })
const files = ['lib/api/dispatch.ts','lib/api/control-store.ts','lib/metastore.ts','lib/api/service.ts']
const original = Object.fromEntries(files.map(f => [f,readFileSync(f,'utf8')]))
const restore = () => files.forEach(f => writeFileSync(f,original[f]))
const run = (name,file,pattern) => {
 const result=spawnSync(process.execPath,['--test',file],{encoding:'utf8'})
 const output=result.stdout+result.stderr;writeFileSync(`.tmp/idempotency-review/${name}.log`,output)
 assert.notEqual(result.status,0,name+' must fail');assert.match(output,pattern);console.log('PASS '+name)
}
try {
 const dispatch=original[files[0]],marker='    executed = true\n    const result = recovered'
 assert.ok(dispatch.includes(marker))
 writeFileSync(files[0],dispatch.replace(marker,'    executed = false\n    const result = recovered'))
 run('released-uncertain-write','lib/api-reconciliation.test.ts',/unprepared receipt stays unresolved/)
 restore()
 const expiry="DELETE FROM idem WHERE expires<=? AND state!='running'"
 assert.ok(original[files[1]].includes(expiry))
 writeFileSync(files[1],original[files[1]].replace(expiry,'DELETE FROM idem WHERE expires<=?'))
 run('expired-unknown-outcome','lib/api-reconciliation.test.ts',/unknown operation must stay reserved after 24 hours/)
 restore()
 const receipt='    if (operation) await writeJson(fs, `${DIR}/${metadataOperationPath(operation)}`, { result, ...await metadataOperationSnapshot(result, fs) })'
 assert.ok(original[files[2]].includes(receipt))
 writeFileSync(files[2],original[files[2]].replace(receipt,''))
 run('missing-committed-receipt','lib/metadata-operation.test.ts',/committed write must carry its durable operation receipt/)
 restore()
 const frozen='      return data ? { data } : null'
 assert.ok(original[files[3]].includes(frozen))
 writeFileSync(files[3],original[files[3]].replace(frozen,"      const found = await index.metaItem(Number(result), 'pr'); return found ? { data: await pullData(c, index, found.item as Pull, found.comments.length) } : null"))
 run('mutable-creation-recovery','lib/api-reconciliation.test.ts',/immutable creation must survive deleted branch|creation head must remain immutable/)
} finally {restore()}
const positive=spawnSync(process.execPath,['--test','lib/api-reconciliation.test.ts','lib/metadata-operation.test.ts'],{encoding:'utf8'})
writeFileSync('.tmp/idempotency-review/restored.log',positive.stdout+positive.stderr)
assert.equal(positive.status,0,positive.stdout+positive.stderr);console.log('PASS restored')
