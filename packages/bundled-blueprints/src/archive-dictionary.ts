import {readFile} from "node:fs/promises";
import ts from "typescript6";
import {createHash} from "node:crypto";
import {gunzipSync} from "node:zlib";
import {extractFiles,parseArchive} from "./files.ts";

/** An exact archive prefix plus a lossless plan for its original uncompressed Yjs bytes. */
export type PackedArchive = {prefix:string;gzipHeader:string;snapshotLength:number;segments:(number|string)[]};
/** A dictionary stores each common file text once, independent of archive metadata and Yjs IDs. */
export type ArchiveDictionary = {files:string[];archives:(PackedArchive|null)[]};

/**
 * Pure runtime decoder. Emitted into the generated module, so it must have no lexical dependencies.
 * The caller supplies its existing pako level-9 compressor; the build verifies exact reconstruction.
 */
export function restoreArchiveBytes(plan:PackedArchive,files:readonly string[],cache:(Uint8Array|undefined)[],gzip:(snapshot:Uint8Array)=>Uint8Array):Uint8Array {
  if(!Number.isSafeInteger(plan.snapshotLength)||plan.snapshotLength<0||plan.snapshotLength>32*1024*1024)throw Error("Invalid bundled snapshot length.");
  const decode=(value:string)=>Uint8Array.from(atob(value),character=>character.charCodeAt(0));
  const snapshot=new Uint8Array(plan.snapshotLength),encoder=new TextEncoder();let offset=0;
  for(const segment of plan.segments){
    let bytes:Uint8Array;
    if(typeof segment==="number"){
      if(!Number.isSafeInteger(segment)||segment<0||segment>=files.length)throw Error("Invalid bundled file reference.");
      bytes=cache[segment]??=encoder.encode(files[segment]);
    }else bytes=decode(segment);
    if(offset+bytes.byteLength>snapshot.byteLength)throw Error("Bundled snapshot exceeds its declared length.");
    snapshot.set(bytes,offset);offset+=bytes.byteLength;
  }
  if(offset!==snapshot.byteLength)throw Error("Bundled snapshot is incomplete.");
  const content=gzip(snapshot),header=decode(plan.gzipHeader),prefix=decode(plan.prefix);
  if(header.byteLength!==10||content.byteLength<18)throw Error("Invalid bundled gzip header.");
  // zlib records the build platform's OS byte. Preserve the actual original header,
  // rather than changing a native archive's fingerprint on the Worker platform.
  content.set(header,0);
  const result=new Uint8Array(prefix.byteLength+content.byteLength);result.set(prefix);result.set(content,prefix.byteLength);return result;
}

/** Deduplicate exact file slices while retaining original Yjs and gzip byte identities. */
export function buildArchiveDictionary(archives:readonly Uint8Array[],gzip:(snapshot:Uint8Array)=>Uint8Array):ArchiveDictionary {
  const decoded=archives.map((bytes,index)=>{const parsed=parseArchive(bytes,`bundled archive ${index}`);return{bytes,content:parsed.content,snapshot:Buffer.from(gunzipSync(parsed.content)),files:extractFiles(parsed.content,`bundled archive ${index}`)};});
  const candidates=new Map<string,{text:string;bytes:Buffer;uses:Set<number>}>();
  for(const [index,archive]of decoded.entries())for(const text of archive.files.values()){
    const bytes=Buffer.from(text);if(bytes.byteLength<256)continue;
    const hash=createHash("sha256").update(bytes).digest("hex"),entry=candidates.get(hash);
    if(entry)entry.uses.add(index);else candidates.set(hash,{text,bytes,uses:new Set([index])});
  }
  const dictionary=[...candidates].filter(([,value])=>value.uses.size>1).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,value])=>value);
  const plans=decoded.map((archive,index):PackedArchive|null=>{
    if(archive.snapshot.byteLength>32*1024*1024||archive.content.byteLength<18||archive.content[3]!==0)return null;
    const slices=dictionary.flatMap((file,reference)=>{if(!file.uses.has(index))return[];const at=archive.snapshot.indexOf(file.bytes);return at<0?[]:[{at,length:file.bytes.byteLength,reference}];}).sort((a,b)=>a.at-b.at||b.length-a.length);
    const segments:(number|string)[]=[];let cursor=0,covered=0;
    for(const slice of slices){if(slice.at<cursor)continue;if(slice.at>cursor)segments.push(archive.snapshot.subarray(cursor,slice.at).toString("base64"));segments.push(slice.reference);cursor=slice.at+slice.length;covered+=slice.length;}
    if(covered<archive.snapshot.byteLength/5)return null;
    if(cursor<archive.snapshot.byteLength)segments.push(archive.snapshot.subarray(cursor).toString("base64"));
    const plan:PackedArchive={prefix:Buffer.from(archive.bytes.subarray(0,archive.bytes.byteLength-archive.content.byteLength)).toString("base64"),gzipHeader:Buffer.from(archive.content.subarray(0,10)).toString("base64"),snapshotLength:archive.snapshot.byteLength,segments};
    // A legacy archive may use another compressor, level, or gzip extension. Keep
    // that archive untouched if this runtime codec cannot reproduce every byte.
    const restored=restoreArchiveBytes(plan,dictionary.map(file=>file.text),[],gzip);
    return Buffer.from(restored).equals(archive.bytes)?plan:null;
  });
  const used=[...new Set(plans.flatMap(plan=>plan?plan.segments.filter((s):s is number=>typeof s==="number"):[]))].sort((a,b)=>a-b),indices=new Map(used.map((old,index)=>[old,index]));
  return{files:used.map(index=>dictionary[index].text),archives:plans.map(plan=>plan?{...plan,segments:plan.segments.map(segment=>typeof segment==="number"?indices.get(segment)!:segment)}:null)};
}

/** Portable base64 output for both Node build verification and native Workers. */
export function archiveBytesBase64(bytes:Uint8Array):string {
  let binary="";
  for(let offset=0;offset<bytes.byteLength;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
  return btoa(binary);
}

/** Copy the same typed pure codec declarations into the generated consumer module. */
export async function archiveDictionaryRuntimeSource():Promise<string> {
  const text=await readFile(new URL("./archive-dictionary.ts",import.meta.url),"utf8");
  const source=ts.createSourceFile("archive-dictionary.ts",text,ts.ScriptTarget.Latest,true);
  const names=new Set(["PackedArchive","restoreArchiveBytes","archiveBytesBase64"]);
  return source.statements.filter(statement=>(ts.isFunctionDeclaration(statement)||ts.isTypeAliasDeclaration(statement))&&statement.name!==undefined&&names.has(statement.name.text)).map(statement=>statement.getText(source).replace(/^export\s+/u,"")).join("\n");
}
