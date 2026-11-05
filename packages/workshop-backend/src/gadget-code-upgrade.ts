import {RpcStub,RpcTarget} from 'capnweb';
import * as Y from 'yjs';
import type {GadgetUpgradeSource,GadgetUpgradePreview,GadgetUpgradeFiles,WorkpieceId} from '@gadgets/workshop-shared/api';
import {validateCodeChangeSchema,validateCodeChangeContent,type CodeChange} from '@gadgets/workshop-shared/code-change';
import {parseBlueprintArchive,readBlueprintKvRecord} from './blueprint-archive';

async function bounded(stream:ReadableStream<Uint8Array>,limit:number){
 const reader=stream.getReader(),parts:Uint8Array[]=[];let size=0;
 try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>limit)throw Error('Gadget upgrade archive exceeds the size limit.');parts.push(part.value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
}

/** Decode an editor-selected candidate without mutating the instance or its library. */
export async function previewGadgetCodeUpgrade(env:Pick<Cloudflare.Env,'BLUEPRINTS'|'BLUEPRINT_CONTENT'>,id:WorkpieceId,baseCommit:string,source:GadgetUpgradeSource,storage?:{
 save(files:ReadonlyMap<string,string>):Promise<string>;
 read(commitId:string,path:string):Promise<string>;
 stage(chatId:number,commitId:string,files:[string,number][],sha256:string):Promise<boolean>;
}):Promise<GadgetUpgradePreview>{
 let title:string,version:number,bindings:Record<string,unknown>,snapshot:Uint8Array;
 if(source.type==='archive'||source.type==='archive-upload'){
  const stream=source.type==='archive-upload'?await source.archive.read():source.archive;
  const raw=await bounded(stream,32*1024*1024+65536+24);
  const parsed=await parseBlueprintArchive(new Response(raw).body!);
  const compressed=await bounded(parsed.content,32*1024*1024);
  if(compressed.length!==parsed.contentLength)throw Error('Gadget upgrade archive length does not match its header.');
  snapshot=await bounded(new Response(compressed).body!.pipeThrough(new DecompressionStream('gzip')),32*1024*1024);
  ({title,version,bindings}=parsed.metadata);
 }else{
  const record=await readBlueprintKvRecord(env,source.blueprintId);if(!record)throw Error('Blueprint not found.');
  const object=await env.BLUEPRINT_CONTENT.get(`${source.blueprintId}/${record.metadata.version}`);if(!object)throw Error('Blueprint code is unavailable.');
  snapshot=await bounded(object.body.pipeThrough(new DecompressionStream('gzip')),32*1024*1024);
  ({title,version,bindings}=record.metadata);
 }
 if(typeof title!=='string'||title.length>1024||!Number.isSafeInteger(version)||version<1||!bindings||typeof bindings!=='object'||Array.isArray(bindings))throw Error('Invalid gadget upgrade metadata.');
 const doc=new Y.Doc();
 try{
  Y.applyUpdateV2(doc,snapshot);
  const files:[string,string][]=[];
  for(const[path,value]of doc.getMap<Y.Text>()){
   if(!(value instanceof Y.Text))throw Error('Gadget archive contains a non-text file.');
   files.push([path,value.toString()]);
  }
  files.sort(([a],[b])=>a.localeCompare(b));if(files.length===0)throw Error('Gadget archive has no code files.');
  // An archive can contain many bounded source files; the editor submits it in bounded batches.
  for(const [path,text]of files){const change:CodeChange={[id]:[[path,{set:text}]]};validateCodeChangeSchema(change);validateCodeChangeContent(change,new Map());}
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',snapshot));
  const contentSha256=Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join('');
  const large=files.reduce((size,[path,text])=>size+path.length+text.length,0)>512*1024;
  if(large&&!source.paged)throw Error('Reload Workshop to preview this complete package using bounded source pages. No upgrade was staged.');
  const fileSizes=large?files.map(([path,text]):[string,number]=>[path,text.length]):undefined;
  let candidateCommit='';
  if(large){
   if(!storage)throw Error('Candidate source storage is unavailable.');
   snapshot=new Uint8Array();
   const owned=new Map(files);candidateCommit=await storage.save(owned);owned.clear();files.length=0;
  }
  const filePages=large?new RpcStub<GadgetUpgradeFiles>(new class extends RpcTarget implements GadgetUpgradeFiles{
   async stageNext(chatId:number){if(!storage||!fileSizes)throw Error('This preview cannot stage code.');return await storage.stage(chatId,candidateCommit,fileSizes,contentSha256);}
   async stageReview(chatId:number){while(!await this.stageNext(chatId)){} }
   async readPage(offset:number){
    if(!storage||!fileSizes||!Number.isSafeInteger(offset)||offset<0||offset>=fileSizes.length)throw Error('Invalid package file offset.');
    const page:[string,string][]=[];let size=0,index=offset;
    while(index<fileSizes.length){const [path,length]=fileSizes[index],weight=path.length+length+16;if(page.length&&size+weight>512*1024)break;page.push([path,await storage.read(candidateCommit,path)]);size+=weight;index++;}
    return{files:page,next:index<fileSizes.length?index:null};
   }
  }):undefined;
  return{title,version,baseCommit,contentSha256,files:large?[]:files,...(filePages?{filePages,fileCount:fileSizes!.length,fileSizes}:{}),requiredBindings:Object.keys(bindings).toSorted()};
 }finally{doc.destroy();}
}
