import * as Y from 'yjs';
import type {GadgetUpgradeSource,GadgetUpgradePreview,WorkpieceId} from '@gadgets/workshop-shared/api';
import {validateCodeChangeSchema,validateCodeChangeContent,type CodeChange} from '@gadgets/workshop-shared/code-change';
import {parseBlueprintArchive,readBlueprintKvRecord} from './blueprint-archive';

async function bounded(stream:ReadableStream<Uint8Array>,limit:number){
 const reader=stream.getReader(),parts:Uint8Array[]=[];let size=0;
 try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>limit)throw Error('Gadget upgrade archive exceeds the size limit.');parts.push(part.value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
}

/** Decode an editor-selected candidate without mutating the instance or its library. */
export async function previewGadgetCodeUpgrade(env:Pick<Cloudflare.Env,'BLUEPRINTS'|'BLUEPRINT_CONTENT'>,id:WorkpieceId,baseCommit:string,source:GadgetUpgradeSource):Promise<GadgetUpgradePreview>{
 let title:string,version:number,bindings:Record<string,unknown>,snapshot:Uint8Array;
 if(source.type==='archive'||source.type==='archive-upload'){
  const stream=source.type==='archive-upload'?await source.archive.read():source.archive;
  const raw=await bounded(stream,32*1024*1024+65536+24);
  const parsed=await parseBlueprintArchive(new Response(raw).body!);
  const compressed=await bounded(parsed.content,32*1024*1024);
  if(compressed.length!==parsed.contentLength)throw Error('Gadget upgrade archive length does not match its header.');
  snapshot=await bounded(new Response(compressed).body!.pipeThrough(new DecompressionStream('gzip')),8*1024*1024);
  ({title,version,bindings}=parsed.metadata);
 }else{
  const record=await readBlueprintKvRecord(env,source.blueprintId);if(!record)throw Error('Blueprint not found.');
  const object=await env.BLUEPRINT_CONTENT.get(`${source.blueprintId}/${record.metadata.version}`);if(!object)throw Error('Blueprint code is unavailable.');
  snapshot=await bounded(object.body.pipeThrough(new DecompressionStream('gzip')),8*1024*1024);
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
  const change:CodeChange={[id]:files.map(([path,text])=>[path,{set:text}])};
  validateCodeChangeSchema(change);validateCodeChangeContent(change,new Map());
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',snapshot));
  return{title,version,baseCommit,contentSha256:Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join(''),files,requiredBindings:Object.keys(bindings).toSorted()};
 }finally{doc.destroy();}
}
