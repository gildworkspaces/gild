// Evaluated before the Worker on celld 0.6.2 only (never on Cloudflare). Each
// shim covers one runtime gap that is drafted as an upstream celld issue in
// docs/self-host-celld.md; delete a shim when celld fixes its gap.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { Readable, Writable } from 'node:stream'

// console.createTask exists but throws. React's development build
// feature-detects it at module load (workerd does not define it).
if (typeof console.createTask === 'function')
  try {
    console.createTask('celld-probe')
  } catch {
    delete console.createTask
    if (typeof console.createTask === 'function') console.createTask = undefined
  }

// globalThis.process has no EventEmitter methods (workerd's has them under
// nodejs_compat). Next installs process listeners at load.
const emitter = new EventEmitter()
for (const name of ['on', 'once', 'off', 'addListener', 'prependListener', 'prependOnceListener', 'removeListener', 'removeAllListeners', 'listeners', 'rawListeners', 'listenerCount', 'emit', 'eventNames', 'setMaxListeners', 'getMaxListeners'])
  if (globalThis.process && typeof globalThis.process[name] !== 'function')
    globalThis.process[name] = emitter[name].bind(emitter)

// The node:fs namespace answers __esModule with a truthy stub, so Babel/TS
// interop (`_interop_require_default(require('fs')).default`) reaches a stub
// that throws. Answer it honestly.
if (fs && fs.__esModule && typeof fs.__esModule !== 'boolean') fs.__esModule = false

// Readable.toWeb / Writable.toWeb throw (their web-streams adapters are
// missing). Next converts its render streams with them.
const works = (convert, make) => {
  try {
    convert(make())
    return true
  } catch {
    return false
  }
}
if (!works(Readable.toWeb, () => Readable.from([])))
  Readable.toWeb = (readable) =>
    new ReadableStream({
      start(controller) {
        readable.on('data', (chunk) => controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk))
        readable.on('end', () => controller.close())
        readable.on('error', (error) => controller.error(error))
      },
      cancel(reason) {
        readable.destroy(reason)
      },
    })
if (!works(Writable.toWeb, () => new Writable({ write: (_c, _e, cb) => cb() })))
  Writable.toWeb = (writable) =>
    new WritableStream({
      write: (chunk) => new Promise((resolve, reject) => writable.write(chunk, (error) => (error ? reject(error) : resolve()))),
      close: () => new Promise((resolve) => writable.end(resolve)),
      abort: (reason) => void writable.destroy(reason),
    })
