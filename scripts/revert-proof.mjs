// Mutations remove two behaviors without changing the new tests. Always
// restore the working sources, even when the expected failure isn't observed.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
mkdirSync('.tmp',{recursive:true})
const cases = [
  {file:'lib/search-query.ts',before:"else if (value[i] === '*') out += '[^/]*'",after:"else if (value[i] === '*') out += '.*'",test:'path literal disables glob'},
  {file:'lib/repo-index-store.ts',before:'WHERE root_tree=? AND ${n.sql}',after:'WHERE ? IS NOT NULL AND ${n.sql}',test:'search fixture: paths'},
]
for (const [i,c] of cases.entries()) {
  const original=readFileSync(c.file,'utf8')
  if (!original.includes(c.before)) throw new Error('mutation no longer applies')
  try {
    writeFileSync(c.file,original.replace(c.before,c.after))
    const result=spawnSync('node',['--test',`--test-name-pattern=${c.test}`,i ? 'lib/repo-index.test.ts':'lib/search-query.test.ts'],{encoding:'utf8'})
    writeFileSync(`.tmp/revert-${i+1}.log`,result.stdout+result.stderr)
    if (result.status===0) throw new Error(`Test did not catch reverted ${c.file}`)
    console.log(`${c.test}: expected failure, exit ${result.status}`)
  } finally { writeFileSync(c.file,original) }
}
