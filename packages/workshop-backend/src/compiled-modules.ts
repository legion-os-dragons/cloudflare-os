/** Reconstruct immutable build artifacts without changing per-source-file limits. */
type Part = {path:string;byteLength:number;sha256:string;encoding?:'utf8'};
type Module = {encoding?:'gzip';encodedByteLength?:number;name:string;type:'esm'|'wasm';target?:'ui';byteLength:number;sha256:string;parts:Part[]};
const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
const validHash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const validPath=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_./-]+$/.test(value)&&!value.startsWith('/')&&!value.split('/').some(part=>!part||part==='.'||part==='..');

export async function readCompiledModules(files:ReadonlyMap<string,string>,target:'worker'|'ui'='worker'):Promise<WorkerLoaderWorkerCode['modules']>{
  const text=files.get('runtime.modules.json');
  if(text===undefined)return {};
  const manifest=JSON.parse(text) as {format?:unknown;modules?:unknown};
  if(manifest.format!=='legion.compiled-worker-modules/v1'||!Array.isArray(manifest.modules))throw Error('Invalid compiled worker module manifest.');
  const output:WorkerLoaderWorkerCode['modules']={};
  const used=new Set<string>();
  for(const module of manifest.modules as Module[]){
    if(module?.target!==undefined&&module.target!=='ui')throw Error('Invalid compiled module target.');
    if((module?.target??'worker')!==target)continue;
    if(target==='ui'&&(module.name!=='client.js'||module.type!=='esm'))throw Error('Invalid compiled UI entry point.');
    if(!module||!validPath(module.name)||module.name==='__kernel_gadget_alarm.js'||(module.type!=='esm'&&module.type!=='wasm')||!module.name.endsWith(module.type==='esm'?'.js':'.wasm')||Object.hasOwn(output,module.name)||files.has(module.name)||!Number.isSafeInteger(module.byteLength)||module.byteLength<=0||module.byteLength>32*1024*1024||!validHash(module.sha256)||!Array.isArray(module.parts)||!module.parts.length)throw Error('Invalid or conflicting compiled worker module.');
    let total=0;
    for(const part of module.parts){
      if(!part||!validPath(part.path)||!part.path.startsWith('runtime-parts/')||!(part.encoding==='utf8'?part.path.endsWith('.txt'):part.encoding===undefined&&part.path.endsWith('.base64'))||used.has(part.path)||!Number.isSafeInteger(part.byteLength)||part.byteLength<=0||part.byteLength>128*1024||!validHash(part.sha256))throw Error('Invalid compiled worker module part.');
      used.add(part.path);total+=part.byteLength;
    }
    if(module.encoding!==undefined&&module.encoding!=='gzip')throw Error('Invalid compiled module encoding.');
    if(total!==(module.encoding==='gzip'?module.encodedByteLength:module.byteLength)||total>32*1024*1024)throw Error('Compiled worker module length does not match its parts.');
    let bytes:Uint8Array=new Uint8Array(total);let offset=0;
    for(const part of module.parts){
      const encoded=files.get(part.path);
      if(typeof encoded!=='string')throw Error('Compiled worker module part is missing.');
      if(part.encoding!=='utf8'&&(encoded.length!==4*Math.ceil(part.byteLength/3)||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)))throw Error('Compiled worker module part is missing or malformed.');
      const decoded=part.encoding==='utf8'?new TextEncoder().encode(encoded):Uint8Array.fromBase64(encoded);
      if(decoded.length!==part.byteLength||await digest(decoded)!==part.sha256)throw Error('Compiled worker module part digest does not match.');
      bytes.set(decoded,offset);offset+=decoded.length;
    }
    if(module.encoding==='gzip'){
      const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
      const decoded=new Uint8Array(module.byteLength);let size=0;
      try{while(true){const item=await reader.read();if(item.done)break;if(size+item.value.length>decoded.length)throw Error('Compiled module expands beyond its declared size.');decoded.set(item.value,size);size+=item.value.length;}}
      finally{await reader.cancel();reader.releaseLock();}
      if(size!==decoded.length)throw Error('Compiled module decoded length does not match.');bytes=decoded;
    }
    if(await digest(bytes)!==module.sha256)throw Error('Compiled worker module digest does not match.');
    output[module.name]=module.type==='wasm'?{wasm:bytes}:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  }
  return output;
}

/** Detect a packaged UI without allocating its executable source for export discovery. */
export function hasCompiledUi(files:ReadonlyMap<string,string>):boolean{
  const text=files.get('runtime.modules.json');if(text===undefined)return false;
  const manifest=JSON.parse(text) as {format?:unknown;modules?:unknown};
  return manifest.format==='legion.compiled-worker-modules/v1'&&Array.isArray(manifest.modules)&&manifest.modules.some(module=>module?.target==='ui'&&module.name==='client.js'&&module.type==='esm');
}
