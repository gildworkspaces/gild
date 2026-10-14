import test from 'node:test'
import assert from 'node:assert/strict'
import { MemFS } from './memfs.ts'

test('metadata filesystem lists direct children through normalized writes and removals',async()=>{
  const fs=new MemFS()
  for(let n=0;n<12000;n++)await fs.writeFile(`/repo/.gild/${n}/issue/item.json`,'{}')
  await fs.writeFile('/repo/.gild/../README.md','source')
  assert.deepEqual((await fs.readdir('/repo//./')).sort(),['.gild','README.md'])
  assert.equal((await fs.readdir('/repo/.gild')).length,12000)
  assert.deepEqual(await fs.readdir('/repo/.gild/999/issue'),['item.json'])
  await fs.unlink('/repo/.gild/999/issue/item.json')
  assert.deepEqual(await fs.readdir('/repo/.gild/999/issue'),[])
  await fs.rmdir('/repo/.gild/999/issue')
  await fs.rm('/repo/.gild/999')
  assert.equal((await fs.readdir('/repo/.gild')).length,11999)
  await fs.writeFile('/repo/.gild/999/pr/item.json','restored')
  assert.deepEqual(await fs.readdir('/repo/.gild/999'),['pr'])
  assert.equal(await fs.readFile('/repo/.gild/999/pr/item.json',{encoding:'utf8'}),'restored')
  await fs.rm('/repo/README.md')
  assert.deepEqual(await fs.readdir('/repo'),['.gild'])
  await assert.rejects(fs.stat('/repo/README.md'),{code:'ENOENT'})
})
