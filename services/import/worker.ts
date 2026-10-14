/** gild-import: runs a claimed import in a Cloudflare Container, one
 *  container per destination repository. gild-site calls start() over a
 *  service binding right after it claims the job; the container reports
 *  progress to gild's API itself, so nothing here waits or polls.
 *
 *  Cost: one container start per import (billed for the seconds it runs),
 *  one Durable Object call to start it. */
import { Container, getContainer } from '@cloudflare/containers'
import { WorkerEntrypoint } from 'cloudflare:workers'

export class ImportContainer extends Container {
  defaultPort = 8080
  // Idle after a finished import; a running one keeps reporting to gild.
  sleepAfter = '2h'
  enableInternet = true
}

interface Env {
  IMPORT_CONTAINER: DurableObjectNamespace<ImportContainer>
  /** gild's own read-only GitHub token: source metadata for public repositories
   *  imported without the user's token (container IPs share GitHub's anonymous limit). */
  GITHUB_TOKEN?: string
}
export interface ImportJob { repository: string; source: string; forge: string; token: string; source_token?: string; mirror: boolean; checkpoint: string }

export default class GildImport extends WorkerEntrypoint<Env> {
  async start(server: string, job: ImportJob) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(job.repository) || !job.token.startsWith('gi_')) throw new Error('gild-import: invalid job')
    const container = getContainer(this.env.IMPORT_CONTAINER, job.repository)
    await container.startAndWaitForPorts(undefined, undefined, { envVars: this.env.GITHUB_TOKEN ? { GITHUB_TOKEN: this.env.GITHUB_TOKEN } : {} })
    const res = await container.fetch(new Request('http://container/run', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ server, job }),
    }))
    if (res.status !== 202) throw new Error(`gild-import: container answered ${res.status}`)
    return { started: job.repository }
  }
  fetch() { return new Response('Not found', { status: 404 }) }
}
