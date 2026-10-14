import {stripVTControlCharacters} from 'node:util'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
const paths=['lib/pulls.ts','lib/actions/queue-do.ts','lib/merge-queue-store.ts']
const original=new Map(paths.map(path=>[path,readFileSync(path,'utf8')]))
mkdirSync('.tmp/merge-negative',{recursive:true})
const cases=[
 ['ci-gate','lib/pulls.ts','return gate.ok','return true',/✖ pending CI persists/],
 ['current-head-review','lib/pulls.ts','async function requireApprovalForHead(fs: MemFS, pull: Pull, headOid: string) {','async function requireApprovalForHead(fs: MemFS, pull: Pull, headOid: string) { return',/✖ legacy queue also rejects approval/],
 ['queued-head-pin','lib/pulls.ts','if (current.queueIntent && current.queueIntent.headOid !== headSha) return {pending:true}','if (false) return {pending:true}',/✖ fresh approval on a moved head/],
 ['durable-alarm','lib/actions/queue-do.ts','if (this.merges.needed()) {','if (false) {',/✖ actual RunQueue alarm resumes/],
 ['earliest-alarm','lib/actions/queue-do.ts','if (current === null || at < current) await this.ctx.storage.setAlarm(at)','await this.ctx.storage.setAlarm(at)',/✖ merge preparation preserves an earlier Actions alarm/],
 ['receipt-retirement','lib/pulls.ts','receipt?.id === intent.id && receipt.number === intent.number && !queue.includes(intent.number)','!queue.includes(intent.number)',/✖ closed queued PR is removed/],
 ['prepared-receipt','lib/pulls.ts','if (previous?.id === intent && previous.number === number) {','if (false) {',/✖ same queue receipt reconciles/,'lib/merge-prepare.test.ts'],
 ['uncertain-preparation','lib/pulls.ts','if (rejectedBeforeCommit && !mayHaveCommitted) await queue.rejectMerge(intent)','if (rejectedBeforeCommit) await queue.rejectMerge(intent)',/✖ a later retry rejection/,'lib/merge-prepare.test.ts'],
 ['last-review-check','lib/pulls.ts','try { await requireApprovalForHead(checkpoint,latest,headSha) }','try { /* removed final review check */ }',/✖ review changes after the first CI/],
 ['selected-base','lib/pulls.ts','if (current.queueIntent?.head && current.queueIntent.head !== head || current.queueIntent?.base && current.queueIntent.base !== base) return {pending:true}','if (false) return {pending:true}',/✖ queue selection cannot silently move/],
 ['concurrent-finalization','lib/pulls.ts',"if (p.state === 'merged' || (p.queueIntent && p.queueIntent.id !== result.intent)) return false",'if (false) return false',/✖ concurrent drains create one/],
 ['untrusted-commit','lib/pulls.ts','const plans = runtime ? await runtime.planned(intentKey) : await (await runQueue(owner,repo)).plannedMerge(intentKey)',"const plans = (await git.log({fs:fs as never,dir:DIR,ref:base})).filter(entry=>entry.commit.message.includes(marker)).map(entry=>({intent:intentKey,commit:entry.oid,head:current.queueIntent?.headOid,base,before:entry.commit.parent[0]}))",/✖ user-authored Git merge marker/],
]
const selected=process.argv.slice(2).map(arg=>{assert.ok(arg.startsWith('--case='),'Use --case=name');return arg.slice(7)})
for(const name of selected)assert.ok(cases.some(row=>row[0]===name),'Unknown remove-fix case '+name)
const restore=()=>{for(const [path,source] of original)writeFileSync(path,source)}
try {
 for(const [name,path,needle,replacement,effect,suite] of cases) {
  if(selected.length&&!selected.includes(name))continue
  restore();assert.ok(original.get(path).includes(needle),name);writeFileSync(path,original.get(path).replace(needle,replacement))
  const result=spawnSync(process.execPath,['--test','--test-reporter=spec',suite??'lib/merge-queue.test.ts'],{encoding:'utf8'}),output=result.stdout+result.stderr
  writeFileSync(`.tmp/merge-negative/${name}.log`,output);assert.notEqual(result.status,0,name);assert.match(stripVTControlCharacters(output),effect,name)
  console.log('PASS remove-fix '+name+' fails the actual effect regression')
 }
} finally {restore()}
const restored=spawnSync(process.execPath,['--test','--test-reporter=spec','lib/merge-queue.test.ts','lib/merge-prepare.test.ts'],{encoding:'utf8'});writeFileSync('.tmp/merge-negative/restored.log',restored.stdout+restored.stderr);assert.equal(restored.status,0,restored.stdout+restored.stderr)
console.log('PASS restored merge queue regressions')
