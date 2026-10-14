import { RpcTarget, WorkerEntrypoint } from 'cloudflare:workers'
import { heavyWithinLimits } from './lib/cqx-heavy-limits'
import c from './cqx/c.wasm'
import csharp from './cqx/csharp.wasm'
import { BUILD, checked, loadModule, snapshot, type Host, type SourceFile } from './lib/cqx-module'

class Scan extends RpcTarget {
  #host: Host | null
  constructor(id: 'c' | 'csharp', files: SourceFile[], label: string) {
    super()
    this.#host = loadModule(id === 'c' ? c : csharp, id)
    snapshot(this.#host, label, files)
  }
  gather(metadata: string) { return checked(this.#host!.call('cqx_gather', metadata), 'heavy gather') }
  emit(shared: string) { return checked(this.#host!.call('cqx_emit', shared), 'heavy emit') }
  quote(report: string) { return checked(this.#host!.call('cqx_quote', report), 'heavy quote') }
  [Symbol.dispose]() { this.#host = null }
}

export default class CqxHeavy extends WorkerEntrypoint {
  open(id: 'c' | 'csharp', files: SourceFile[], label: string, build: string) {
    if (build !== BUILD || !['c', 'csharp'].includes(id)) throw new Error('cqx heavy: incompatible module request')
    if (!heavyWithinLimits(files)) throw new Error('cqx heavy: too large to score C-family here')
    return new Scan(id, files, label)
  }
  // Also deny HTTP in local preview; production has no route or workers.dev.
  fetch() { return new Response('Not found', { status: 404 }) }
}
