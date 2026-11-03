import { RpcTarget } from 'capnweb'
import { isTransientRpcError } from '../../rpcErrors'

/** Parent-owned admission status; never conveys a human identity, role or access key. */
export class GadgetAccessSession extends RpcTarget {
  #read: () => Promise<'workspace' | 'key'>
  #current: () => boolean
  #onInterrupted?: () => void
  constructor(read: () => Promise<'workspace' | 'key'>, current: () => boolean, onInterrupted?: () => void) { super(); this.#read = read; this.#current = current; this.#onInterrupted = onInterrupted }
  async status(): Promise<{ status: 'available'; value: { mode: 'workspace' | 'key' } } | { status: 'unavailable'; reason: string }> {
    if (!this.#current()) return { status: 'unavailable', reason: 'This gadget session has ended.' }
    try {
      const mode = await this.#read()
      if (!this.#current()) return { status: 'unavailable', reason: 'This gadget session has ended.' }
      return { status: 'available', value: { mode } }
    } catch (error) {
      if (!this.#current()) return { status: 'unavailable', reason: 'This gadget session has ended.' }
      if (isTransientRpcError(error)) {
        // Close the private view immediately while its parent reacquires the
        // same authorized owner. This does not grant access or replay a call.
        this.#onInterrupted?.()
        return { status: 'unavailable', reason: 'The gadget connection was interrupted. Reconnecting.' }
      }
      return { status: 'unavailable', reason: 'This gadget session is no longer admitted.' }
    }
  }
}
