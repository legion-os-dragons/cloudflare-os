import {useCallback,useState} from 'react'
import type {RpcStub} from 'capnweb'
import type {AdminApi} from '@gadgets/workshop-shared/api'
import {WorkshopButton} from '../../components/WorkshopControls'
import {WorkspaceAccessPanel} from './WorkspaceAccessPanel'

export const AdminWorkspaceAccessPanel=({admin}:{admin:RpcStub<AdminApi>})=>{
  const [input,setInput]=useState('')
  const [workspace,setWorkspace]=useState('')
  const [error,setError]=useState('')
  const getManager=useCallback(()=>admin.getWorkspaceAccess(workspace),[admin,workspace])
  return <section className="rounded-xl border border-kumo-line bg-kumo-elevated p-6">
    <h2 className="text-lg font-semibold">Workspace access</h2>
    <p className="my-2 text-sm text-kumo-subtle">Manage people and connection access for a workspace. Administrator changes are recorded under your own identity.</p>
    <form className="flex flex-wrap items-end gap-2" onSubmit={event=>{
      event.preventDefault();setError('')
      let id=input.trim()
      if(!/^[a-f0-9]{64}$/.test(id)){try{const url=new URL(id);if(url.origin!==window.location.origin)throw Error();id=/^\/workspace\/([a-f0-9]{64})(?:\/|$)/.exec(url.pathname)?.[1]??''}catch{id=''}}
      if(!/^[a-f0-9]{64}$/.test(id)){setError('Enter a workspace URL from this deployment or its full workspace ID.');return}
      setWorkspace(id)
    }}><label className="flex-1 text-sm">Workspace URL or ID<input required value={input} onChange={event=>setInput(event.target.value)} className="mt-1 block w-full rounded-lg border border-kumo-line bg-kumo-base p-2"/></label><WorkshopButton type="submit">Manage access</WorkshopButton></form>
    {error&&<p role="alert" className="mt-2 text-sm text-kumo-danger">{error}</p>}
    {workspace&&<WorkspaceAccessPanel key={workspace} getManager={getManager} managePeople/>}
  </section>
}
