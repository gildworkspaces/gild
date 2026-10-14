import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {execFileSync,spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'

const path='lib/api/client.ts',source=readFileSync(path)
mkdirSync('.tmp/client-repair',{recursive:true})
try {
  writeFileSync(path,execFileSync('git',['show','b73e2f12618027b95ddf9e6ad17b077d269d1a2d:'+path]))
  const omitted=spawnSync(process.execPath,['--test','lib/api-client.test.mjs','lib/prepared-read-models.test.ts'],{encoding:'utf8'})
  writeFileSync('.tmp/client-repair/omitted.log',omitted.stdout+omitted.stderr)
  assert.notEqual(omitted.status,0,'old canonical client must fail actual structured code effects')
  assert.match(omitted.stdout,/canonical generated client preserves typed Pending/)
  assert.match(omitted.stdout,/structured API codes retain old constructor/)
  console.log('PASS old canonical client fails actual immutable codes and dispatch/nativeD1 Pending effects')
} finally {writeFileSync(path,source)}
const restored=spawnSync(process.execPath,['--test','lib/api-client.test.mjs','lib/prepared-read-models.test.ts'],{encoding:'utf8'})
writeFileSync('.tmp/client-repair/restored.log',restored.stdout+restored.stderr)
assert.equal(restored.status,0,'restored canonical client must pass');console.log('PASS restored canonical client and all prepared native effects')
