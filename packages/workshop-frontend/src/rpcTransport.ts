import { RpcSession, type RpcTransport, type RpcStub } from 'capnweb'
import { WORKSHOP_RPC_MAX_MESSAGE_BYTES, WORKSHOP_RPC_MAX_QUEUE_BYTES, WORKSHOP_RPC_MAX_HTTP_BYTES, type PublicApi } from '@gadgets/workshop-shared/api'

// Callback factories must use the connection's own Cap'n Web copy, including in a vendored install.
export { RpcTarget, RpcStub } from 'capnweb'

/** Keep RPC capabilities and callbacks, but give each message a separate HTTP request. */
export const connectWorkshop = (url: string, fetcher: typeof fetch = globalThis.fetch): RpcStub<PublicApi> => {
  const transport = new HttpRpcTransport(url, fetcher)
  return new RpcSession<PublicApi>(transport, undefined, {
    limits: { maxMessageSize: WORKSHOP_RPC_MAX_MESSAGE_BYTES },
  }).getRemoteMain()
}

class HttpRpcTransport implements RpcTransport {
  private controller = new AbortController()
  private connection: Promise<string>
  private pending: { message: string; size: number; resolve: () => void; reject: (error: unknown) => void }[] = []
  private pendingBytes = 0
  private flushing = false
  private sequence = 0
  private cursor = 0
  private received: string[] = []
  private failure: unknown

  constructor(private url: string, private fetcher: typeof fetch) {
    this.connection = this.request('open').then(async response => {
      const result: { connection: string } = await response.json()
      if (!/^[a-f0-9]{64}$/.test(result.connection)) throw new Error('Invalid Workshop connection.')
      return result.connection
    })
    // A failed connection must reach the RPC receive loop even before the first send.
    void this.connection.catch(error => this.fail(error))
  }

  private async request(action: string, connection?: string, body?: unknown): Promise<Response> {
    const encoded = body === undefined ? undefined : JSON.stringify(body)
    if (encoded && new TextEncoder().encode(encoded).byteLength > WORKSHOP_RPC_MAX_HTTP_BYTES) throw new Error('Workshop message batch is too large.')
    const options = {
      method: 'POST', credentials: 'same-origin' as const, cache: 'no-store' as const,
      headers: {
        'Content-Type': 'application/json', 'X-Workshop-Rpc': action,
        ...(connection ? { 'X-Workshop-Connection': connection } : {}),
      },
      body: encoded, signal: this.controller.signal,
    }
    const response = await this.fetcher(this.url, options)
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw new Error(response.status === 410 ? 'Workshop connection ended. Reconnecting…'
        : `Workshop connection failed (${response.status}).`)
    }
    return response
  }

  send(message: string): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    const size = new TextEncoder().encode(JSON.stringify(message)).byteLength
    if (this.pending.length >= 128 || size > WORKSHOP_RPC_MAX_MESSAGE_BYTES || this.pendingBytes + size > WORKSHOP_RPC_MAX_QUEUE_BYTES) {
      const error = new Error('Workshop connection message queue is full.')
      this.fail(error)
      return Promise.reject(error)
    }
    const result = new Promise<void>((resolve, reject) => this.pending.push({ message, size, resolve, reject }))
    this.pendingBytes += size
    if (!this.flushing) {
      this.flushing = true
      queueMicrotask(() => { void this.flush() })
    }
    return result
  }

  private async flush(): Promise<void> {
    while (this.pending.length && !this.failure) {
      // Count JSON escaping as well as message bytes, leaving room for the envelope.
      let count = 0, bytes = 256;
      while (count < this.pending.length && count < 128 &&
          bytes + this.pending[count].size + 1 <= WORKSHOP_RPC_MAX_HTTP_BYTES) {
        bytes += this.pending[count].size + 1;
        ++count;
      }
      const batch = this.pending.splice(0, count)
      this.pendingBytes -= batch.reduce((total, entry) => total + entry.size, 0)
      try {
        const connection = await this.connection
        // Never replay a batch after a lost response: it may contain financial writes.
        const response = await this.request('send', connection, { sequence: this.sequence, messages: batch.map(entry => entry.message) })
        await response.arrayBuffer()
        this.sequence += batch.length
        batch.forEach(entry => entry.resolve())
      } catch (error) {
        batch.forEach(entry => entry.reject(error))
        this.fail(error)
      }
    }
    this.flushing = false
  }

  async receive(): Promise<string> {
    while (true) {
      if (this.failure) throw this.failure
      if (this.received.length) return this.received.shift()!
      try {
        const connection = await this.connection
        const response = await this.request('receive', connection, { cursor: this.cursor })
        const result: { cursor: number; messages: string[] } = await response.json()
        if (!Array.isArray(result.messages) || result.messages.length > 128 ||
            result.cursor !== this.cursor + result.messages.length ||
            result.messages.some(message => typeof message !== 'string' || new TextEncoder().encode(message).byteLength > WORKSHOP_RPC_MAX_MESSAGE_BYTES) ||
            result.messages.reduce((total, message) => total + new TextEncoder().encode(message).byteLength, 0) > WORKSHOP_RPC_MAX_QUEUE_BYTES) {
          throw new Error('Invalid Workshop connection response.')
        }
        this.cursor = result.cursor
        this.received = result.messages
      } catch (error) { this.fail(error); throw error }
    }
  }

  abort(reason: unknown): void { this.fail(reason) }

  private fail(reason: unknown): void {
    if (this.failure) return
    this.failure = reason ?? new Error('Workshop connection closed.')
    this.pending.splice(0).forEach(entry => entry.reject(this.failure))
    this.pendingBytes = 0
    // Best effort cleanup has no application side effects. It uses a separate signal because
    // the active receive/send requests must stop immediately.
    void this.connection.then(connection => {
      const options = {
        method: 'POST', credentials: 'same-origin' as const, cache: 'no-store' as const, keepalive: true,
        headers: { 'X-Workshop-Rpc': 'close', 'X-Workshop-Connection': connection },
      }
      return this.fetcher(this.url, options)
    }).catch(() => {})
    this.controller.abort(this.failure)
  }
}
