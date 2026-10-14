import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as git from 'isomorphic-git'
import http from 'isomorphic-git/http/web'
import { metaHttp } from './git-meta-http.ts'
import { MemFS } from './memfs.ts'

test('metadata clones and immutable snapshot fetches work with an unborn physical HEAD', async () => {
  mkdirSync('.tmp', { recursive: true })
  const work = mkdtempSync(resolve('.tmp/git-meta-http-')), source = join(work, 'source'), bare = join(work, 'repo.git')
  mkdirSync(source)
  const run = (...args: string[]) => execFileSync('git', args, { cwd: source, stdio: 'pipe', encoding: 'utf8' }).trim()
  run('init', '-b', '_meta')
  writeFileSync(join(source, 'acl.json'), '{"owners":["@owner"]}\n')
  run('add', '.')
  run('-c', 'commit.gpgsign=false', 'commit', '-m', 'Metadata fixture')
  const oid = run('rev-parse', 'HEAD')
  run('init', '--bare', '--initial-branch=main', bare)
  run('push', bare, '_meta')
  const server = createServer((request, response) => {
    const advertise = request.url?.includes('/info/refs'), service = 'upload-pack'
    response.setHeader('content-type', `application/x-git-${service}-${advertise ? 'advertisement' : 'result'}`)
    if (advertise) response.write('001e# service=git-upload-pack\n0000')
    const child = spawn('git', ['-c', 'uploadpack.allowAnySHA1InWant=true', service, '--stateless-rpc', ...(advertise ? ['--advertise-refs'] : []), bare], { stdio: ['pipe', 'pipe', 'pipe'] })
    child.stderr.resume()
    request.pipe(child.stdin)
    child.stdout.pipe(response)
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}/repo.git`
  try {
    const plain = new MemFS()
    await assert.rejects(git.clone({ fs: plain as never, http, dir: '/plain', url, ref: '_meta', singleBranch: true, noTags: true }), /HEAD/)
    const fs = new MemFS()
    await git.clone({ fs: fs as never, http: metaHttp, dir: '/meta', url, ref: '_meta', singleBranch: true, noTags: true })
    assert.equal(new TextDecoder().decode(await fs.readFile('/meta/acl.json') as Uint8Array), '{"owners":["@owner"]}\n')
    const snapshot = new MemFS()
    await git.init({ fs: snapshot as never, dir: '/snapshot' })
    await git.addRemote({ fs: snapshot as never, dir: '/snapshot', remote: 'origin', url })
    await git.fetch({ fs: snapshot as never, http: metaHttp, dir: '/snapshot', url, ref: oid, depth: 1, singleBranch: true, tags: false })
    assert.equal((await git.readCommit({ fs: snapshot as never, dir: '/snapshot', oid })).commit.message, 'Metadata fixture\n')
    assert.equal(run('--git-dir=' + bare, 'symbolic-ref', 'HEAD'), 'refs/heads/main')
    assert.equal(run('--git-dir=' + bare, 'for-each-ref', '--format=%(refname)', 'refs/heads'), 'refs/heads/_meta')
  } finally {
    await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r()))
    rmSync(work, { recursive: true, force: true })
  }
})
