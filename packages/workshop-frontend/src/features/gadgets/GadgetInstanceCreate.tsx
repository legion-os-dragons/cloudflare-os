import { useEffect, useRef, useState } from 'react'
import { Button, Dialog } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'

export default function GadgetInstanceCreate({ api, overseer, onCreated }: { api: RpcStub<AuthenticatedApi>; overseer: RpcStub<Overseer>; onCreated(id: WorkpieceId): void }) {
  const [choices, setChoices] = useState<Array<{ id: string; title: string }>>([])
  const [blueprint, setBlueprint] = useState(''), [title, setTitle] = useState(''), [locked, setLocked] = useState(true), [key, setKey] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const generation = useRef(0)
  useEffect(() => { generation.current++; setChoices([]); setBlueprint(''); setKey(''); setMessage(''); setBusy(false); return () => { generation.current++ } }, [api, overseer])
  const load = async () => {
    const own = generation.current
    try {
      const [formats, library] = await Promise.all([api.listOutputFormats(), api.listLibraryBlueprints()])
      if (own !== generation.current) return
      const found = new Map<string, { id: string; title: string }>()
      for (const format of formats) found.set(format.blueprintId, { id: format.blueprintId, title: format.output.noun })
      for (const item of library) found.set(item.id, { id: item.id, title: item.metadata.title })
      setChoices([...found.values()])
    } catch { if (own === generation.current) setMessage('The app library could not be read.') }
  }
  const create = async () => {
    if (!blueprint || !title.trim()) { setMessage('Choose an app and give this instance a name.'); return }
    const own = generation.current
    const nextKey = locked ? btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : ''
    setBusy(true); setMessage(''); setKey('')
    let client
    try {
      client = await overseer.createGadget(title.trim(), undefined, undefined, locked ? { visibility: 'key', key: nextKey } : { visibility: 'workspace' }, blueprint)
      const id = await client.getId(); if (own !== generation.current) return; setKey(nextKey); setMessage(locked ? `Created gadget ${id}. Copy its key now; it will not be stored in your app configuration.` : `Created shared gadget ${id}.`); onCreated(id)
    } catch (error) { if (own !== generation.current) return; setMessage(error instanceof Error ? error.message : 'The app instance could not be created.') }
    finally { client?.[Symbol.dispose](); if (own === generation.current) setBusy(false) }
  }
  return <>
    <Button size="sm" variant="ghost" onClick={() => { setOpen(true); void load() }}>Add app here</Button>
    <Dialog.Root open={open} onOpenChange={value => { if (!busy) setOpen(value) }}>
      <Dialog size="sm" className="p-5">
        <Dialog.Title>Add app to this workspace</Dialog.Title>
        <Dialog.Description className="mb-4 text-xs text-kumo-subtle">Create an independent instance from your app library.</Dialog.Description>
    <label className="block text-xs">Reusable app<select aria-label="Reusable app" className="my-1 block w-full border border-kumo-line p-2" value={blueprint} onChange={event => setBlueprint(event.target.value)}><option value="">Choose from library</option>{choices.map(choice => <option key={choice.id} value={choice.id}>{choice.title}</option>)}</select></label>
    <label className="block text-xs">Instance name<input aria-label="App instance name" className="my-1 block w-full border border-kumo-line p-2" value={title} onChange={event => setTitle(event.target.value)} /></label>
    <label className="my-2 flex gap-2 text-xs"><input type="checkbox" checked={locked} onChange={event => setLocked(event.target.checked)} />Require a key for workspace users</label>
    <p className="mb-2 text-xs text-kumo-subtle">Creates another app in this workspace with separate runtime data. Configure any required connections in its Connections panel. Owners and build editors remain trusted.</p>
    <Button disabled={busy} onClick={() => { void create() }}>Create app instance</Button>
    {key && <label className="mt-2 block text-xs">New gadget key<input aria-label="Created gadget key" readOnly value={key} className="mt-1 w-full border border-kumo-line p-2" onFocus={event => event.currentTarget.select()} /></label>}
    {message && <p role="status" className="mt-2 text-xs">{message}</p>}
        <div className="mt-4"><Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>Close</Button></div>
      </Dialog>
    </Dialog.Root>
  </>
}
