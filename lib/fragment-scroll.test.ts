import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installScroll } from '../packages/render/scroll.ts'

test('reload with no history state restores scroll and leaves navigation active', () => {
  const names = ['history','History','window','document','location','performance'] as const
  const originals = new Map(names.map(name => [name,Object.getOwnPropertyDescriptor(globalThis,name)]))
  const moves: number[][] = []
  const entry = { state:null as null | {gildScrollY?:number}, scrollRestoration:'auto' }
  function HistoryFixture() {}
  HistoryFixture.prototype.replaceState = (state:typeof entry.state) => { entry.state = state }
  const fixtures = {
    history:entry,History:HistoryFixture,
    window:{scrollY:0,scrollTo(x:number,y:number){moves.push([x,y])},addEventListener(){}},
    document:{readyState:'complete',getElementById(){return null}},
    location:{href:'https://gild.test/acme/demo'},
    performance:{getEntriesByType(){return [{type:'reload'}]}},
  }
  try {
    for(const name of names)Object.defineProperty(globalThis,name,{value:fixtures[name],configurable:true})
    const cleanup=installScroll()
    assert.deepEqual(moves,[[0,0]],'reload restores the initial scroll position')
    assert.equal(entry.scrollRestoration,'manual')
    assert.equal(entry.state?.gildScrollY,0,'the restored entry can record subsequent navigation')
    cleanup()
  } finally {
    for(const name of names){const descriptor=originals.get(name);if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name)}
  }
})
