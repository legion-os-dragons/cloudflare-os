// @vitest-environment jsdom
import React, { act } from 'react'
import type {GadgetClient, Overseer} from '@gadgets/workshop-shared/api'
import type {UnlockedGadget} from './GadgetKeyUnlock'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import GadgetAccessControl from './GadgetAccessControl'
import GadgetKeyUnlock from './GadgetKeyUnlock'
import GadgetInstanceCreate from './GadgetInstanceCreate'
vi.mock('@cloudflare/kumo', () => ({ Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} /> }))
;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
let root:Root|undefined, container:HTMLDivElement
async function render(node:React.ReactNode){ container=document.createElement('div');document.body.append(container);root=createRoot(container);await act(async()=>{root!.render(node)}) }
async function click(label:string){const button=[...container.querySelectorAll('button')].find(x=>x.textContent===label)!;expect(button).toBeTruthy();await act(async()=>{button.click()})}
async function input(label:string,value:string){const el=container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}))})}
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;document.body.replaceChildren();vi.restoreAllMocks()})
it('owner lock/rotate/share displays generated capability once without persisting it',async()=>{
 const setAccess=vi.fn<GadgetClient['setAccess']>(async()=>{});const storage=vi.spyOn(Storage.prototype,'setItem');
 await render(<GadgetAccessControl gadget={{getAccessMode:async()=> 'workspace',setAccess} as never}/>);
 await click('Lock and create key');const key=container.querySelector<HTMLInputElement>('[aria-label="New gadget key"]')!.value;expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(setAccess).toHaveBeenLastCalledWith({visibility:'key',key});
 await click('Rotate key');expect(container.querySelector<HTMLInputElement>('[aria-label="New gadget key"]')!.value).not.toBe(key);
 await click('Share with workspace');expect(setAccess).toHaveBeenLastCalledWith({visibility:'workspace'});expect(container.querySelector('[aria-label="New gadget key"]')).toBeNull();expect(storage).not.toHaveBeenCalled();
})
it('member unlock hands over only the admitted stub and clears the presented key',async()=>{
 const onUnlocked=vi.fn<(value:UnlockedGadget)=>void>();const client={getTitle:async()=> 'Private contacts', [Symbol.dispose]:vi.fn<()=>void>()};const getGadget=vi.fn<(...args:Parameters<Overseer['getGadget']>)=>Promise<typeof client>&typeof client>((..._args:Parameters<Overseer['getGadget']>)=>Object.assign(Promise.resolve(client),client));
 await render(<GadgetKeyUnlock overseer={{getGadget} as never} onUnlocked={onUnlocked}/>);await input('Protected gadget ID','2');await input('Gadget access key','a'.repeat(43));await click('Open gadget');
 expect(getGadget).toHaveBeenCalledWith(2,'a'.repeat(43));expect(onUnlocked).toHaveBeenCalledWith({id:2,title:'Private contacts',stub:client});expect(container.querySelector<HTMLInputElement>('[aria-label="Gadget access key"]')!.value).toBe('');
})
it('creates a key-private instance atomically from the selected reusable blueprint',async()=>{
 const createGadget=vi.fn<(...args:Parameters<Overseer['createGadget']>)=>Promise<{getId():Promise<number>;[Symbol.dispose]():void}>>(async()=>({getId:async()=>7,[Symbol.dispose]:vi.fn<()=>void>()}));const onCreated=vi.fn<(id:number)=>void>();await render(<GadgetInstanceCreate api={{listOutputFormats:async()=>[],listLibraryBlueprints:async()=>[{id:'crm-v1',metadata:{title:'CRM'}}]} as never} overseer={{createGadget} as never} onCreated={onCreated}/>);
 await act(async()=>{container.querySelector('details')!.open=true;container.querySelector('details')!.dispatchEvent(new Event('toggle'))});
 const select=container.querySelector<HTMLSelectElement>('select')!;await act(async()=>{select.value='crm-v1';select.dispatchEvent(new Event('change',{bubbles:true}))});await input('App instance name','Private contacts');await click('Create app instance');
 expect(createGadget.mock.calls[0]).toEqual(['Private contacts',undefined,undefined,{visibility:'key',key:expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)},'crm-v1']);expect(onCreated).toHaveBeenCalledWith(7);
})
