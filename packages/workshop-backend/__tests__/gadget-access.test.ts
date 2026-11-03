import { describe, expect, it } from 'vitest';
import { env, RpcStub as NativeRpcStub } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import type { OverseerDurableObject } from '../src/overseer';
import { gadgetAccessHash } from '../src/gadget-access';
import { openFakeOverseer } from './fixtures';
async function rejectsNative(call:()=>Promise<unknown>){const outcome=await call().then(()=>({ok:true}),error=>({ok:false,error:String(error)}));expect(outcome.ok).toBe(false);}
const KEY='a'.repeat(43),NEXT='b'.repeat(43);let counter=0;
const CODE=`import{DurableObject,RpcTarget,WorkerEntrypoint,restore}from'cloudflare:workers';
export class Gadget extends DurableObject{
 constructor(ctx,env){super(ctx,env);this.ctx=ctx;this.listeners=new Set();ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,value TEXT,schema TEXT)');}
 write(value,schema){this.ctx.storage.sql.exec('INSERT OR REPLACE INTO records VALUES(?,?,?)','same-record-id',value,schema);for(const fn of this.listeners)Promise.resolve(fn(value)).catch(()=>{});}
 read(){return [...this.ctx.storage.sql.exec('SELECT * FROM records')];}
 record(){return this.ctx.restore({kind:'record'});}
 subscribe(fn){fn=fn.dup();this.listeners.add(fn);Promise.resolve(fn(this.read()[0]?.value)).catch(()=>{});return new Subscription(this.listeners,fn);}
 [restore](params){if(params.kind!=='record')throw Error('bad restore');return new Record(this.ctx.storage);}}
class Record extends RpcTarget{constructor(storage){super();this.storage=storage;}read(){return [...this.storage.sql.exec('SELECT * FROM records')];}}
class Subscription extends RpcTarget{constructor(listeners,fn){super();this.listeners=listeners;this.fn=fn;}[Symbol.dispose](){this.listeners.delete(this.fn);}}
export class ExportHandler extends WorkerEntrypoint{
 getExportFormats(){return[{id:'csv',label:'Private field names',mode:'server',contentType:'text/csv',fileExtension:'.csv'}];}
 async export(gadget){const rows=await gadget.read();let part=0;return new ReadableStream({pull(c){if(part===3)c.close();else c.enqueue(new TextEncoder().encode(JSON.stringify({part:part++,rows})));}});}
}`;
async function withWorkspace(fn:(impl:any,owner:any,viewer:any)=>Promise<void>){
 const stub=env.TEST_OVERSEER.getByName(`gadget-key-${++counter}`);
 await runInDurableObject(stub,async(instance:OverseerDurableObject)=>{
  const impl=(instance as unknown as{impl:any}).impl;
  const commitId=await impl.gitStore.writeFilesAsCommit(new Map([['server.js',CODE],['client.js','document.body.textContent="private custom fields";']]),{parents:[],author:{name:'Owner',email:'owner@example.com'},message:'Synthetic CRM',timestamp:new Date(0)});
  for(const[id,title]of [[1,'Investing CRM'],[2,'Private contacts CRM']]as const)impl.storage.gadgets.put({type:'gadget',id,title,created:new Date(0),bindingName:`CRM_${id}`,bindings:{},commitId});
  impl.storage.nextGatekeeperId.put(3);
  const delegate={gitStore:impl.gitStore,createGadget:(...args:any[])=>impl.createGadget(...args),fetchBlueprint:async()=>({files:{'server.js':CODE,'client.js':'document.body.textContent="reusable app"'},notes:'Synthetic reusable CRM'}),ownerId:'owner-id',getGadgetRecord:(id:number)=>impl.getGadgetRecord(id),subscribeToWorkpieces:(s:any,p:boolean)=>impl.subscribeToWorkpieces(s,p),getGadgetFacet:(id:number,chatId?:number,kind?:string)=>impl.getGadgetFacet(id,chatId,kind),getGadgetUiBundle:(id:number)=>impl.getGadgetUiBundle(id),getGadgetExportFormats:(id:number)=>impl.getGadgetExportFormats(id),exportGadget:(id:number,format:string)=>impl.exportGadget(id,format),bumpVersion:(ids:number[])=>impl.bumpVersion(ids),revokeGadgetConnections:(id:number)=>impl.revokeGadgetConnections(id),assertGadgetUseWithoutCommands:(id:number)=>impl.assertGadgetUseWithoutCommands(id),storage:impl.storage,users:{idFromString:(id:string)=>id,get:()=>({id:{toString:()=> 'viewer-id'},whoami:async()=>({type:'user',id:'viewer',name:'Viewer'}),recordSharedGadgetOpen:async()=>{}})}};
  const owner=await openFakeOverseer({gadgets:impl.storage.gadgets},{role:'build',impl:delegate});const viewer=await openFakeOverseer({gadgets:impl.storage.gadgets},{role:'use',impl:delegate});await fn(impl,owner,viewer);
 });
}
describe('OS gadget key admission',()=>{
 it('keeps shared access, hides locked summaries and denies guessed IDs/code/export/tool capabilities',()=>withWorkspace(async(impl,owner,viewer)=>{
  await(await owner.getGadget(2)).setAccess({visibility:'key',key:KEY});expect(impl.storage.gadgets.get(2).accessKeyHash).toBe(await gadgetAccessHash({visibility:'key',key:KEY}));expect(JSON.stringify(impl.storage.gadgets.get(2))).not.toContain(KEY);expect(impl.defaultBindingList()).toEqual({CRM_1:1});
  const entries:any[]=[];using _sub=await viewer.subscribeToWorkpieces(new NativeRpcStub({entry:(e:any)=>{entries.push(e)},removed:()=>{},ready:()=>{},onRpcBroken:()=>{}})as any);await new Promise(r=>setTimeout(r,0));expect(entries.map(x=>x.id)).toEqual([1]);expect(JSON.stringify(entries)).not.toContain('Private');
  await expect(viewer.getGadget(2)).rejects.toThrow('access key');await expect(viewer.getGadget(2,NEXT)).rejects.toThrow('access key');expect(await(await viewer.getGadget(1)).getTitle()).toBe('Investing CRM');
  await expect(viewer.readFilesAtCommit('guessed',['server.js'])).rejects.toThrow('Unauthorized');await expect(viewer.listChats()).rejects.toThrow('Unauthorized');await expect(viewer.newChat('read private CRM',null)).rejects.toThrow('Unauthorized');
  const admitted=await viewer.getGadget(2,KEY);expect(await admitted.getAccessMode()).toBe('key');expect(await admitted.getTitle()).toBe('Private contacts CRM');expect(await admitted.getUiBundle()).not.toBeNull();expect(await admitted.getExportFormats()).toHaveLength(1);expect(await new Response(await admitted.export('csv')).text()).toContain('part');await expect(admitted.setAccess({visibility:'workspace'})).rejects.toThrow('Unauthorized');
 }));
 it('isolates identical record IDs and revokes held facets, stored nested resources and future subscription events',()=>withWorkspace(async(impl,owner,viewer)=>{
  const manager=await owner.getGadget(2);await manager.setAccess({visibility:'key',key:KEY});using publicFacet=await(await viewer.getGadget(1)).connectToGadget();const admittedPrivate=await(await viewer.getGadget(2,KEY)).connectToGadget();admittedPrivate[Symbol.dispose]();const privateFacet=await impl.getGadgetFacetFetcher(2);await publicFacet.write('shared-investor','investment-stage');await privateFacet.write('secret gate 7654','aircraft-tail-number');expect(await publicFacet.read()).toEqual([{id:'same-record-id',value:'shared-investor',schema:'investment-stage'}]);expect((await privateFacet.read())[0].schema).toBe('aircraft-tail-number');
  const nested=await privateFacet.record();await impl.ctx.storage.put('retained-private-resource',nested);const events:string[]=[];const subscription=await privateFacet.subscribe(new NativeRpcStub((value:string)=>{events.push(value)}));await new Promise(r=>setTimeout(r,0));expect(events).toContain('secret gate 7654');events.length=0;
  const retained=await viewer.getGadget(2,KEY);await manager.setAccess({visibility:'key',key:NEXT});for(const op of [()=>retained.getTitle(),()=>retained.getUiBundle(),()=>retained.connectToGadget(),()=>retained.getExportFormats(),()=>retained.export('csv')])await expect(op()).rejects.toThrow();await rejectsNative(()=>privateFacet.read());await rejectsNative(()=>privateFacet.write('leak','leak'));await rejectsNative(()=>nested.read());expect(()=>impl.restore({type:'gadget',gadgetId:2,accessRevision:1})).toThrow('revoked');void subscription;using fresh=await(await viewer.getGadget(2,NEXT)).connectToGadget();await fresh.write('new private value','new schema');expect(events).toEqual([]);expect((await fresh.read())[0].value).toBe('new private value');expect((await publicFacet.read())[0].value).toBe('shared-investor');
 }));
 it('stops future chunks of an already-open export after key rotation',()=>withWorkspace(async(_impl,owner,viewer)=>{
  const manager=await owner.getGadget(2);await manager.setAccess({visibility:'key',key:KEY});const admitted=await viewer.getGadget(2,KEY);using facet=await admitted.connectToGadget();await facet.write('secret gate code','private custom schema');facet[Symbol.dispose]();const reader=(await admitted.export('csv')).getReader();const first=await reader.read();expect(new TextDecoder().decode(first.value)).toContain('secret gate code');await manager.setAccess({visibility:'key',key:NEXT});await expect(reader.read()).rejects.toThrow();
 }));
 it('creates private and shared instances from one blueprint atomically in the same workspace',()=>withWorkspace(async(impl,owner,viewer)=>{
  const entries:number[]=[];using _sub=await viewer.subscribeToWorkpieces(new NativeRpcStub({entry:(x:any)=>{entries.push(x.id)},removed:()=>{},ready:()=>{},onRpcBroken:()=>{}})as any);await new Promise(r=>setTimeout(r,0));
  const privateInstance=await owner.createGadget('Private contacts',undefined,'PRIVATE_CONTACTS',{visibility:'key',key:KEY},'synthetic-crm');const privateId=await privateInstance.getId();expect(privateId).toBe(3);expect(impl.storage.gadgets.get(privateId).accessRevision).toBe(1);await expect(viewer.getGadget(privateId)).rejects.toThrow();
  const sharedInstance=await owner.createGadget('Investing',undefined,'SHARED_INVESTING',{visibility:'workspace'},'synthetic-crm');const sharedId=await sharedInstance.getId();expect(sharedId).toBe(4);await new Promise(r=>setTimeout(r,0));expect(entries).toEqual([1,2,4]);
  using privateData=await(await viewer.getGadget(privateId,KEY)).connectToGadget();using sharedData=await(await viewer.getGadget(sharedId)).connectToGadget();await privateData.write('gate 1234','tail number');await sharedData.write('public investor','stage');expect((await sharedData.read())[0].value).toBe('public investor');expect((await privateData.read())[0].value).toBe('gate 1234');
 }));
 it('filters output indexes per recipient, including a lock without a title change',()=>withWorkspace(async(impl,owner,_viewer)=>{
  const captured:any[]=[];const receiver=(id:string)=>({id:{toString:()=>id},syncWorkspaceOutputs:async(_workspace:string,rows:any[])=>{captured.push(rows)}});impl.ownerId='owner-id';impl.bumpLastActive=()=>{};
  await impl.syncOutputsTo(receiver('viewer-id'));expect(captured.pop().map((x:any)=>x.workpieceId)).toEqual([1,2]);await(await owner.getGadget(2)).setAccess({visibility:'key',key:KEY});await impl.syncOutputsTo(receiver('viewer-id'));expect(captured.pop().map((x:any)=>x.workpieceId)).toEqual([1]);await impl.syncOutputsTo(receiver('owner-id'));expect(captured.pop().map((x:any)=>x.workpieceId)).toEqual([1,2]);
 }));
 it('removes locked rows live and restores explicit workspace sharing',()=>withWorkspace(async(_impl,owner,viewer)=>{
  const entries:number[]=[],removed:number[]=[];using _sub=await viewer.subscribeToWorkpieces(new NativeRpcStub({entry:(x:any)=>{entries.push(x.id)},removed:(id:number)=>{removed.push(id)},ready:()=>{},onRpcBroken:()=>{}})as any);await new Promise(r=>setTimeout(r,0));expect(entries).toEqual([1,2]);const manager=await owner.getGadget(2);await manager.setAccess({visibility:'key',key:KEY});await new Promise(r=>setTimeout(r,0));expect(removed).toEqual([2]);await manager.setAccess({visibility:'workspace'});await new Promise(r=>setTimeout(r,0));expect(entries).toEqual([1,2,2]);expect(await(await viewer.getGadget(2)).getTitle()).toBe('Private contacts CRM');
 }));
 it('rejects ambient delegation of locked instances and refuses locking already delegated instances',()=>withWorkspace(async(impl,owner,_viewer)=>{
  const manager=await owner.getGadget(2);await manager.setAccess({visibility:'key',key:KEY});
  await expect(owner.newAgentSpawnerGatekeeper({displayName:'Shared agent',modelId:null,env:{CONTACTS:2}})).rejects.toThrow('Key-locked');
  expect(()=>impl.bindWorkpiece(1,'CONTACTS',2)).toThrow('Gadget-to-gadget');
  impl.storage.chatContext.put({chatId:99,spawnerConfig:{displayName:'Old shared agent',modelId:null,env:{CONTACTS:2}},bindings:{CONTACTS:2}});
  expect(()=>impl.startGatekeeperSession({type:'gadget',id:2},{from:'agent',chatId:99})).toThrow('Spawned agents');
  await manager.setAccess({visibility:'workspace'});
  impl.storage.gatekeepers.put({id:20,title:'Existing shared spawner',creationSpec:{type:'agentSpawner',config:{displayName:'Shared agent',modelId:null,env:{CONTACTS:2}}}});
  await expect(manager.setAccess({visibility:'key',key:KEY})).rejects.toThrow('Remove this gadget');
  expect(await manager.getAccessMode()).toBe('workspace');
 }));
 it('enforces real owner/share-link member identities in one workspace without fixture role admission',async()=>{
  const workspace=env.TEST_OVERSEER.getByName(`gadget-real-identities-${++counter}`);
  await runInDurableObject(workspace,async(instance:OverseerDurableObject)=>{
   const impl=(instance as unknown as{impl:any}).impl;
   const ownerUser=impl.users.getByName('synthetic-owner'),memberUser=impl.users.getByName('synthetic-member');
   for(const[user,id,name]of [[ownerUser,'synthetic-owner','Owner'],[memberUser,'synthetic-member','Member']]as const){await runInDurableObject(user,async(account:any)=>{account.storage.created.put(true);account.storage.profile.put({type:'user',id,name});});}
   await ownerUser.newGadget(impl.ctx.id.toString(),'Shared workspace');
   const owner=await instance.open(ownerUser.id.toString(),'synthetic-owner',new NativeRpcStub(()=>{}));
   const shared=await owner.createGadget('Investing',undefined,'INVESTING',{visibility:'workspace'});
   const privateCrm=await owner.createGadget('Private contacts',undefined,'PRIVATE_CONTACTS',{visibility:'key',key:KEY});
   const sharedId=await shared.getId(),privateId=await privateCrm.getId();
   const commitId=await impl.gitStore.writeFilesAsCommit(new Map([['server.js',CODE],['client.js','document.body.textContent="private schema";']]),{parents:[],author:{name:'Owner',email:'synthetic-owner'},message:'Synthetic CRM code',timestamp:new Date(0)});
   for(const id of [sharedId,privateId]){const record=impl.getGadgetRecord(id);record.commitId=commitId;impl.storage.gadgets.put(record);}
   const link=await owner.createShareLink('use');
   const member=await instance.open(memberUser.id.toString(),'synthetic-member',new NativeRpcStub(()=>{}),link.key);
   expect((await member.getMetadata()).role).toBe('use');
   await expect(member.getGadget(privateId)).rejects.toThrow('access key');await expect(member.readFilesAtCommit(commitId,['server.js'])).rejects.toThrow('Unauthorized');
   using sharedData=await(await member.getGadget(sharedId)).connectToGadget();using ownerData=await privateCrm.connectToGadget();
   await sharedData.write('Investing contact','stage');await ownerData.write('Owner gate code','aircraft tail number');
   expect((await sharedData.read())[0].value).toBe('Investing contact');
   const unlocked=await member.getGadget(privateId,KEY);using privateData=await unlocked.connectToGadget();expect((await privateData.read())[0].schema).toBe('aircraft tail number');
   await expect(unlocked.setAccess({visibility:'workspace'})).rejects.toThrow('Unauthorized');
   // Simulate an offline user's persisted index from before locking; a fresh list must not leak it.
   await memberUser.recordSharedGadgetOpen(impl.ctx.id.toString(),'Shared workspace',await ownerUser.whoami(),'use');
   await memberUser.syncWorkspaceOutputs(impl.ctx.id.toString(),impl.outputsSnapshot());
   const listed=await memberUser.listOutputs();expect(listed.outputs.map((entry:any)=>entry.workpieceId)).toEqual([sharedId]);
   expect(JSON.stringify(listed.outputs)).not.toContain('Private contacts');

  });
 });

});
