import {readFileSync,writeFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
const path='lib/actions/pool-store.ts',original=readFileSync(path,'utf8'),proof=[]
for(const [name,check] of [['group eligibility blocks leasing outside selected repositories',"  if (\n    group.visibility === 'selected' &&\n    !group.repositories.includes(repository)\n  )\n    return 'Repository is not selected in this runner group'"],['public repository exclusion blocks leasing until allow-public is enabled',"  if (isPublic && !group.allow_public_repositories)\n    return 'Public repository in a group that disallows public repositories'"]]) {
 try {assert.ok(original.includes(check));writeFileSync(path,original.replace(check,''));const result=spawnSync('node',['--test','--test-name-pattern',name,'lib/runner-pool.test.ts'],{encoding:'utf8'});assert.notEqual(result.status,0,'Mutated guard must fail the named effect test');proof.push({test:name,exit:result.status,output:result.stdout+result.stderr})} finally {writeFileSync(path,original)}
}
for (const [path, name, check, replacement] of [
  ['lib/actions/runner-validation.ts', 'registration parity rejects', "  if (!result.success) throw new ApiError(422, 'invalid runner name, OS, arch or labels')\n  return result.data", '  return data'],
  ['lib/actions/pool-do.ts', 'saveGroup rejects', '    data = validateGroup(data, !!id)', ''],
  ['lib/actions/pool-do.ts', 'saveGroup rejects', "          await rawRepo(ns, repo, 'GET', undefined, this.env.ARTIFACTS_TOKEN)", ''],
]) {
  const original = readFileSync(path, 'utf8')
  try {
    assert.ok(original.includes(check))
    writeFileSync(path, original.replace(check, replacement))
    const result = spawnSync('node', ['--test', '--test-name-pattern', name, 'lib/runner-runtime.test.ts'], { encoding: 'utf8' })
    assert.notEqual(result.status, 0, 'Reverted validation must fail its effect test')
    assert.ok(result.stdout.includes('AssertionError'), 'Proof must fail an assertion, not loading or compiling')
    proof.push({ test: name, reverted: check.trim(), exit: result.status, output: result.stdout + result.stderr })
  } finally { writeFileSync(path, original) }
}
writeFileSync('docs/actions/owner-runner-revert-evidence.json',JSON.stringify(proof,null,2)+'\n');console.log(proof.map(p=>({test:p.test,exit:p.exit})))
