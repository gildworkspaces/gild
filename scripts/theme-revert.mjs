import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {execFileSync,spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
mkdirSync('.tmp',{recursive:true})
const path='components/theme.tsx',fixed=readFileSync(path,'utf8')
try{
  // Actual pre-review component: the mounted default applies dark then restores
  // light/system. A final-value-only check would miss this regression.
  writeFileSync(path,execFileSync('git',['show','c6cc001:components/theme.tsx'],{encoding:'utf8'}))
  const r=spawnSync('node',['scripts/theme-browser.mjs'],{encoding:'utf8'})
  writeFileSync('.tmp/theme-revert.log',r.stdout+r.stderr)
  assert.notEqual(r.status,0)
  assert.match(r.stdout+r.stderr,/No hydration palette clobber|No palette flash/)
  console.log('Revert proof: pre-review theme component fails no-flash hydration check; source restored')
}finally{writeFileSync(path,fixed)}
const restored=spawnSync('node',['scripts/theme-browser.mjs'],{encoding:'utf8'})
writeFileSync('.tmp/theme-restored.log',restored.stdout+restored.stderr)
assert.equal(restored.status,0,restored.stdout+restored.stderr)
console.log('Restored five theme scenarios pass')
