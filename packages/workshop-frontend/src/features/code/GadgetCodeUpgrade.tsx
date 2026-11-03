import {useEffect,useRef,useState} from 'react'
import {RpcStub,RpcTarget} from 'capnweb'
import type {GadgetArchiveUpload,GadgetUpgradePreview,Overseer,WorkpieceId} from '@gadgets/workshop-shared/api'
import {useAuthenticatedApi} from '../../AuthContext'
import {WorkshopButton} from '../../components/WorkshopControls'

const PREVIEW_DEADLINE_MS = 30_000

const readWithDeadline = async <T,>(read: PromiseLike<T>): Promise<T> => {
 let timer: ReturnType<typeof setTimeout> | undefined
 try {
  return await Promise.race([read, new Promise<never>((_, reject) => {
   timer = setTimeout(() => reject(new Error('The read-only preview timed out. Reconnect the workspace, then select the archive or preview the library revision again. No upgrade was staged by this preview.')), PREVIEW_DEADLINE_MS)
  })])
 } finally { clearTimeout(timer) }
}

export function GadgetCodeUpgrade({overseer,gadgetId,chatId,ready,hasChat,onCreateReview,onStage,onRetryConnection}:{overseer:RpcStub<Overseer>;gadgetId:WorkpieceId;chatId:number|null;ready:boolean;hasChat:boolean;onCreateReview(candidate:GadgetUpgradePreview):Promise<void>;onStage(candidate:GadgetUpgradePreview):void;onRetryConnection?:()=>void}){
 const {authenticatedApi}=useAuthenticatedApi()
 const [choices,setChoices]=useState<Array<{id:string;title:string}>>([])
 const [open,setOpen]=useState(false),[blueprint,setBlueprint]=useState(''),[candidate,setCandidate]=useState<GadgetUpgradePreview|null>(null),[busy,setBusy]=useState<'preview'|'review'|null>(null),[message,setMessage]=useState(''),[confirmed,setConfirmed]=useState(false)
 const [readFailed,setReadFailed]=useState(false),[reconnecting,setReconnecting]=useState(false),[libraryMessage,setLibraryMessage]=useState('')
 const generation=useRef(0),mounted=useRef(false)
 const context={gadgetId,chatId,overseer,authenticatedApi}
 const scope=useRef(context);scope.current=context
 const candidateScope=useRef<typeof context|null>(null)
 const isCurrent=(own:typeof context,request:number)=>mounted.current&&generation.current===request&&scope.current.gadgetId===own.gadgetId&&scope.current.chatId===own.chatId&&scope.current.overseer===own.overseer&&scope.current.authenticatedApi===own.authenticatedApi
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++}},[])
 useEffect(()=>{generation.current++;candidateScope.current=null;setCandidate(null);setConfirmed(false);setBusy(null);setMessage('');setReadFailed(false);setReconnecting(false)},[gadgetId,chatId,overseer,authenticatedApi])
 useEffect(()=>{
  if(!open)return
  let active=true
  setChoices([]);setLibraryMessage('')
  void readWithDeadline(Promise.all([authenticatedApi.listLibraryBlueprints(),authenticatedApi.listOutputFormats()])).then(([library,formats])=>{
   if(!active)return
   const options=new Map(library.map(item=>[item.id,{id:item.id,title:item.metadata.title}]))
   for(const format of formats)if(!options.has(format.blueprintId))options.set(format.blueprintId,{id:format.blueprintId,title:format.output.noun})
   setChoices([...options.values()])
  }).catch(()=>{if(active)setLibraryMessage('The library list is unavailable. You can still select an archive or enter a blueprint ID.')})
  return()=>{active=false}
 },[open,authenticatedApi,overseer,gadgetId])
 const changeBlueprint=(value:string)=>{generation.current++;candidateScope.current=null;setBlueprint(value);setCandidate(null);setConfirmed(false);setReadFailed(false);setMessage('')}
 async function preview(source:Parameters<Overseer['previewGadgetUpgrade']>[1]){
  if(busy||reconnecting||!mounted.current||scope.current.gadgetId!==gadgetId||scope.current.chatId!==chatId||scope.current.overseer!==overseer||scope.current.authenticatedApi!==authenticatedApi)return
  const own=scope.current,request=++generation.current
  candidateScope.current=null;setBusy('preview');setReadFailed(false);setMessage('');setCandidate(null);setConfirmed(false)
  try{
   const value=await readWithDeadline(overseer.previewGadgetUpgrade(own.gadgetId,source))
   if(isCurrent(own,request)){candidateScope.current=own;setCandidate(value)}
  }catch(error){if(isCurrent(own,request)){setReadFailed(true);setMessage(error instanceof Error?error.message:String(error))}}
  finally{if(isCurrent(own,request))setBusy(null)}
 }
 async function previewArchive(file:File){
  const archive=new RpcStub<GadgetArchiveUpload>(new class extends RpcTarget implements GadgetArchiveUpload{
   #opened=false;
   read():ReadableStream<Uint8Array>{
    if(this.#opened)throw new Error('This archive upload has already been read. Select the archive again.');
    this.#opened=true;return file.stream();
   }
  });
  try{await preview({type:'archive-upload',archive})}finally{archive[Symbol.dispose]()}
 }
 const reconnect=()=>{
  if(busy==='review'||!onRetryConnection)return
  generation.current++;candidateScope.current=null;setCandidate(null);setConfirmed(false);setBusy(null);setReadFailed(true);setReconnecting(true)
  setMessage('Reconnecting the workspace. After it reconnects, select the archive or preview the library revision again. This does not stage or accept an upgrade.')
  onRetryConnection()
 }
 async function review(){
  if(!candidate||busy||reconnecting)return
  const own=candidateScope.current,request=generation.current
  if(!own||!isCurrent(own,request)){setCandidate(null);setConfirmed(false);setMessage('The workspace or conversation changed. Preview this upgrade again.');return}
  if(hasChat){try{onStage(candidate);setCandidate(null);setMessage('Code staged in this conversation. Review the Changes and choose Accept to activate it.')}catch(error){setMessage(error instanceof Error?error.message:String(error))}return}
  // Creating a review writes durable state: never time it out or automatically replay it.
  setBusy('review');setMessage('')
  try{await onCreateReview(candidate);if(isCurrent(own,request)){setCandidate(null);setMessage('Code staged in the new review conversation. Review the Changes and choose Accept to activate it.')}}catch(error){if(isCurrent(own,request))setMessage(error instanceof Error?error.message:String(error))}finally{if(isCurrent(own,request))setBusy(null)}
 }
 return <div className="border-b border-kumo-line bg-kumo-base px-3 py-2 text-sm">
  <WorkshopButton tone="secondary" onClick={()=>setOpen(!open)}>Import / upgrade code</WorkshopButton>
  {open&&<div className="mt-3 space-y-3">
   <p>Replace this gadget’s code through a reviewed conversation. Its identity, stored data, access policy and existing Connections are retained. Review data migrations in the imported code before accepting.</p>
   <label className="block">Gadget archive <input type="file" accept=".gadget" disabled={busy!==null||reconnecting} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void previewArchive(file)}}/></label>
   {libraryMessage&&<p role="status">{libraryMessage}</p>}
   <div className="flex flex-wrap gap-2"><label>Library or standard gadget <select className="rounded border border-kumo-line bg-kumo-base px-2 py-1" value={blueprint} disabled={busy!==null||reconnecting} onChange={event=>changeBlueprint(event.target.value)}><option value="">Choose a blueprint</option>{choices.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></label><label>Blueprint ID <input className="rounded border border-kumo-line bg-kumo-base px-2 py-1" value={blueprint} disabled={busy!==null||reconnecting} onChange={event=>changeBlueprint(event.target.value)}/></label><WorkshopButton tone="secondary" disabled={busy!==null||reconnecting||!blueprint.trim()} onClick={()=>void preview({type:'blueprint',blueprintId:blueprint.trim()})}>Preview latest published revision</WorkshopButton></div>
   {candidate&&<div className="space-y-2"><p>{candidate.title} · version {candidate.version} · {candidate.files.length} files</p><p className="break-all">Content SHA-256: {candidate.contentSha256}</p><p>Expected Connections: {candidate.requiredBindings.join(', ')||'None'}. Connections are not added or replaced by this import.</p><details><summary>Review imported files</summary><ul className="max-h-48 overflow-auto">{candidate.files.map(([path,text])=><li key={path}>{path} · {text.length.toLocaleString()} characters</li>)}</ul></details><label className="block"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/> Stage this complete replacement, including removal of files absent from the archive.</label><WorkshopButton tone="primary" disabled={busy!==null||reconnecting||!confirmed||(hasChat&&!ready)} onClick={()=>void review()}>{hasChat?'Stage upgrade for review':'Create upgrade review'}</WorkshopButton></div>}
   {busy&&<p role="status">{busy==='preview'?'Preparing code upgrade…':'Creating the review conversation…'}</p>}{readFailed&&onRetryConnection&&<WorkshopButton tone="secondary" onClick={reconnect}>{reconnecting?'Try reconnecting again':'Reconnect workspace'}</WorkshopButton>}{message&&<p role="status">{message}</p>}
  </div>}
 </div>
}
