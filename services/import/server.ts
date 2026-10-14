/** The import container: gild's own runner, server-side. Receives one claimed
 *  import (the same payload a CLI or owner runner claims), runs it with the
 *  CLI's executeImport against gild's API (git through gild's proxy with the
 *  job's gi_ lease; metadata in batches), and stays idle until stopped.
 *  Tokens arrive in the request body and live only in this process. */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeImport } from '../../../gild-cli/src/import/execute'

let running: string | null = null
createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') { res.end(JSON.stringify({ running })); return }
  if (req.method !== 'POST' || req.url !== '/run') { res.statusCode = 404; res.end(); return }
  let body = ''
  req.on('data', c => { body += c }).on('end', () => {
    if (running) { res.statusCode = 409; res.end(JSON.stringify({ error: 'busy', running })); return }
    const { server, job } = JSON.parse(body) as { server: string; job: Parameters<typeof executeImport>[1] }
    // GitHub's anonymous API limit is shared by every container; gild's own
    // read-only token reads public sources the user gave no token for.
    if (!job.source_token && job.forge === 'github' && process.env.GITHUB_TOKEN) job.source_token = process.env.GITHUB_TOKEN
    running = job.repository
    res.statusCode = 202; res.end(JSON.stringify({ started: job.repository }))
    const log = (m: string) => console.log(`[${job.repository}] ${m}`)
    executeImport(server, job, mkdtempSync(join(tmpdir(), 'gild-import-')), new AbortController().signal, log)
      .then(() => log('done'))
      .catch(e => log(`failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => { running = null })
  })
}).listen(8080, () => console.log('gild import container on 8080'))
