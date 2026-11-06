import { RpcSession, type RpcTransport, type RpcStub, DEFAULT_LIMITS } from 'capnweb'
import type { PublicApi } from '@gadgets/workshop-shared/api'

/** Keep RPC capabilities and callbacks, but give each message a separate HTTP request. */
export const connectWorkshop = (url: string): RpcStub<PublicApi> => {
  const transport = new HttpRpcTransport(url)
  return new RpcSession<PublicApi>(transport).getRemoteMain()
}

class HttpRpcTransport implements RpcTransport {
  private controller = new AbortController()
  private connection: Promise<string>
  private pending: { message: string; resolve: () => void; reject: (error: unknown) => void }[] = []
  private flushing = false
  private sequence = 0
  private cursor = 0
  private received: string[] = []
  private failure: unknown

  constructor(private url: string) {
    this.connection = this.request('open').then(async response => {
      const result: { connection: string } = await response.json()
      if (!/^[a-f0-9]{64}$/.test(result.connection)) throw new Error('Invalid Workshop connection.')
      return result.connection
    })
    // A failed connection must reach the RPC receive loop even before the first send.
    void this.connection.catch(error => this.fail(error))
  }

  private async request(action: string, connection?: string, body?: unknown): Promise<Response> {
    const response = await fetch(this.url, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: {
        'Content-Type': 'application/json', 'X-Workshop-Rpc': action,
        ...(connection ? { 'X-Workshop-Connection': connection } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body), signal: this.controller.signal,
    })
    if (!response.ok) throw new Error(response.status === 410
      ? 'Workshop connection ended. Reconnecting…'
      : `Workshop connection failed (${response.status}).`)
    return response
  }

  send(message: string): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.pending.length >= 128 || message.length > DEFAULT_LIMITS.maxMessageSize) {
      const error = new Error('Workshop connection message queue is full.')
      this.fail(error)
      return Promise.reject(error)
    }
    const result = new Promise<void>((resolve, reject) => this.pending.push({ message, resolve, reject }))
    if (!this.flushing) {
      this.flushing = true
      queueMicrotask(() => { void this.flush() })
    }
    return result
  }

  private async flush(): Promise<void> {
    while (this.pending.length && !this.failure) {
      const batch = this.pending.splice(0, 128)
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
            result.messages.some(message => typeof message !== 'string' || message.length > DEFAULT_LIMITS.maxMessageSize)) {
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
    // Best effort cleanup has no application side effects. It uses a separate signal because
    // the active receive/send requests must stop immediately.
    void this.connection.then(connection => fetch(this.url, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: true,
      headers: { 'X-Workshop-Rpc': 'close', 'X-Workshop-Connection': connection },
    })).catch(() => {})
    this.controller.abort(this.failure)
  }
}
