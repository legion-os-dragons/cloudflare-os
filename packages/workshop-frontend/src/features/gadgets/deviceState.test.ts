import { describe, expect, it } from 'vitest'
import { GadgetDeviceState } from './deviceState'
const memory = () => { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } } }
describe('gadget device preferences', () => {
  it('persists reloads on one device while isolating users, gadgets and separate browsers', () => {
    const browser = memory(), otherBrowser = memory()
    const first = new GadgetDeviceState({userId:'reader-a',workspaceId:'workspace-a',gadgetId:1},browser,()=>true)
    expect(first.save({mode:'dark',visit:{day:'2026-10-29'},holdingsGroup:{by:'entity',open:['a']}}).status).toBe('available')
    expect(new GadgetDeviceState({userId:'reader-a',workspaceId:'workspace-a',gadgetId:1},browser,()=>true).load()).toMatchObject({status:'available',value:{mode:'dark'}})
    for (const [userId,gadgetId,storage] of [['reader-b',1,browser],['reader-a',2,browser],['reader-a',1,otherBrowser]] as const)
      expect(new GadgetDeviceState({userId,workspaceId:'workspace-a',gadgetId},storage,()=>true).load()).toEqual({status:'available',value:{},scopeVersion:2})
    expect(first.save({textScale:1.25})).toMatchObject({status:'available',value:{mode:'dark',textScale:1.25}})
  })
  it('cannot read or write without a trusted parent scope or after its session ended', () => {
    const storage = memory(); let current = true
    expect(new GadgetDeviceState(undefined,storage,()=>true).save({mode:'dark'}).status).toBe('unavailable')
    const target = new GadgetDeviceState({userId:'reader',workspaceId:'workspace-a',gadgetId:1},storage,()=>current)
    current = false; expect(target.load().status).toBe('unavailable'); expect(target.save({mode:'dark'}).status).toBe('unavailable'); expect(storage.values.size).toBe(0)
  })
  it('reports quota, blocked storage, malformed state and unsafe or oversized patches without replacing saved state', () => {
    const storage = memory(), target = new GadgetDeviceState({userId:'reader',workspaceId:'workspace-a',gadgetId:1},storage,()=>true)
    target.save({mode:'light'}); const before = [...storage.values]
    for (const patch of [JSON.parse('{"__proto__":{"leak":true}}'),{value:Infinity},{value:()=>1},{value:'x'.repeat(32768)}])expect(target.save(patch).status).toBe('failed')
    expect([...storage.values]).toEqual(before)
    expect(new GadgetDeviceState({userId:'reader',workspaceId:'workspace-a',gadgetId:1},{getItem(){throw Error('private storage error')},setItem(){}},()=>true).load()).toEqual({status:'failed',reason:'Device preferences could not be read from this browser.'})
    expect(new GadgetDeviceState({userId:'reader',workspaceId:'workspace-a',gadgetId:1},{getItem(){return null},setItem(){throw Error('quota')}},()=>true).save({mode:'dark'}).status).toBe('failed')
  })
})
