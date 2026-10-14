import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultAdvertisement, defaultRefsRequest } from './git-default.ts'
const packet = (value: string) => (Buffer.byteLength(value) + 4).toString(16).padStart(4, '0') + value
function values(body: string) {
  const bytes = Buffer.from(body), result: string[] = []
  for (let at = 0; at < bytes.length;) {
    const length = parseInt(bytes.subarray(at, at + 4).toString(), 16)
    assert.ok(length <= 3 || length >= 4 && at + length <= bytes.length)
    if (length > 3) result.push(bytes.subarray(at + 4, at + length).toString())
    at += length > 3 ? length : 4
  }
  return result
}
test('unborn physical HEAD advertises the imported default in Git v0 and v2', () => {
  const meta = 'a'.repeat(40), code = 'b'.repeat(40), branch = 'release/é'
  const input = packet('# service=git-upload-pack\n') + '0000' +
    packet(`${meta} refs/heads/_meta\0multi_ack thin-pack side-band-64k\n`) +
    packet(`${code} refs/heads/${branch}\n`) + '0000'
  const rewritten = defaultAdvertisement(input, branch), refs = values(rewritten)
  assert.equal(refs[1], `${code} HEAD\0multi_ack thin-pack side-band-64k symref=HEAD:refs/heads/${branch}\n`)
  assert.equal(refs[2], `${meta} refs/heads/_meta\n`)
  assert.equal(refs[3], `${code} refs/heads/${branch}\n`)
  assert.equal(defaultAdvertisement(rewritten, branch), rewritten)
  for (const head of ['', packet('unborn HEAD symref-target:refs/heads/main\n')]) {
    const input = head + packet(`${meta} refs/heads/_meta\n`) + packet(`${code} refs/heads/${branch}\n`) + '0000'
    const output = values(defaultAdvertisement(input, branch, 'v2'))
    assert.ok(output.includes(`${code} HEAD symref-target:refs/heads/${branch}\n`))
    assert.equal(output.filter(ref => ref.includes(' HEAD ')).length, 1)
    assert.ok(!output.some(ref => ref.includes('\0') || ref.startsWith('unborn ')))
  }
  assert.equal(defaultAdvertisement(input, 'missing'), input)
})
test('advertisement rewriting preserves invalid input and control packets', () => {
  for (const input of ['nope', '000x', 'ffffshort', '0001' + '0002' + '0000'])
    assert.equal(defaultAdvertisement(input, 'master'), input)
})
test('HEAD-only v2 discovery requests the selected branch oid', () => {
  const input = packet('command=ls-refs\n') + '0001' + packet('symrefs\n') + packet('ref-prefix HEAD\n') + '0000'
  const output = defaultRefsRequest(input, 'master')
  assert.deepEqual(values(output), ['command=ls-refs\n', 'symrefs\n', 'ref-prefix HEAD\n', 'ref-prefix refs/heads/master\n'])
  assert.equal(defaultRefsRequest(output, 'master'), output)
})

test('import readers see source HEAD and no internal branches, including before code arrives',()=>{
  const meta='a'.repeat(40),head='b'.repeat(40),pr='c'.repeat(40)
  const input=packet('# service=git-upload-pack\n')+'0000'+packet(`${meta} HEAD\0multi_ack symref=HEAD:refs/heads/_meta\n`)+packet(`${meta} refs/heads/_meta\n`)+packet(`${pr} refs/heads/import/pr/2\n`)+packet(`${head} refs/heads/master\n`)+'0000'
  const output=values(defaultAdvertisement(input,'master','v0','import/pr'))
  assert.ok(output.some(r=>r.startsWith(head+' HEAD')))
  assert.ok(!output.some(r=>r.includes('refs/heads/_meta')||r.includes('refs/heads/import/pr/')))
  const pending=packet(`${meta} HEAD\0multi_ack symref=HEAD:refs/heads/_meta\n`)+packet(`${meta} refs/heads/_meta\n`)+'0000'
  const empty=values(defaultAdvertisement(pending,'main','v0','import/pr'))
  assert.ok(!empty.some(r=>r.includes('HEAD')||r.includes('_meta')))
  assert.ok(empty.some(r=>r.startsWith('0'.repeat(40)+' capabilities^{}\0')),'empty repositories retain valid Git capabilities')
})

test('unrestricted v2 ref discovery remains unrestricted during imports',()=>{
  const input=packet('command=ls-refs\n')+'0001'+packet('peel\n')+packet('symrefs\n')+'0000'
  assert.equal(defaultRefsRequest(input,'master'),input)
})

test('branch listings hide only the job namespace and preserve colliding source branch names',async()=>{
  const {refsFromAdvertisement}=await import('./repo-refs.ts')
  const refs=refsFromAdvertisement([{ref:'refs/heads/master',oid:'a'},{ref:'refs/heads/import/pr/2',oid:'b'},{ref:'refs/heads/import_/pr/2',oid:'c'},{ref:'refs/heads/_meta',oid:'d'}],'import_/pr')
  assert.deepEqual(refs.branches.map(b=>b.name),['master','import/pr/2'])
  assert.equal(refs.meta,'d')
})
