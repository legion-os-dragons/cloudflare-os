import { DEFAULT_LIMITS, type RpcTransport } from 'capnweb';

/** Message transport for one connection; the owner delivers each message in a fresh request. */
export class HttpRpcTransport implements RpcTransport {
  private incoming: string[] = [];
  private outgoing: string[] = [];
  private incomingSize = 0;
  private outgoingSize = 0;
  private nextSequence = 0;
  private acknowledged = 0;
  private receiver?: { resolve: (message: string) => void; reject: (error: unknown) => void };
  private poll?: () => void;
  private failure?: Error;

  /** Publish a reply or callback without tying it to the request that created the connection. */
  send(message: string): void {
    if (this.failure) throw this.failure;
    if (message.length > DEFAULT_LIMITS.maxMessageSize ||
        this.outgoingSize + message.length > DEFAULT_LIMITS.maxMessageSize * 2 || this.outgoing.length >= 128) {
      this.abort(new Error('Workshop connection reply queue is full.'));
      throw this.failure;
    }
    this.outgoing.push(message);
    this.outgoingSize += message.length;
    this.poll?.();
  }

  /** Await the next client message for the existing Cap’n Web session. */
  receive(): Promise<string> {
    if (this.failure) return Promise.reject(this.failure);
    const message = this.incoming.shift();
    if (message !== undefined) { this.incomingSize -= message.length; return Promise.resolve(message); }
    return new Promise((resolve, reject) => { this.receiver = { resolve, reject }; });
  }

  /** Admit each ordered client message once; a transport failure never replays application work. */
  accept(sequence: number, message: string): void {
    if (this.failure) throw this.failure;
    if (sequence !== this.nextSequence || typeof message !== 'string' ||
        message.length > DEFAULT_LIMITS.maxMessageSize ||
        this.incomingSize + message.length > DEFAULT_LIMITS.maxMessageSize * 2 || this.incoming.length >= 128) {
      this.abort(new Error('Invalid Workshop connection message.'));
      throw this.failure;
    }
    ++this.nextSequence;
    if (this.receiver) {
      const receiver = this.receiver;
      this.receiver = undefined;
      receiver.resolve(message);
    } else { this.incoming.push(message); this.incomingSize += message.length; }
  }

  /** Return unacknowledged replies; a lost read response does not lose a capability or result. */
  async read(cursor: number): Promise<{ cursor: number; messages: string[] }> {
    if (this.failure) throw this.failure;
    if (!Number.isSafeInteger(cursor) || cursor < this.acknowledged ||
        cursor > this.acknowledged + this.outgoing.length || this.poll) {
      throw new Error('Invalid Workshop connection cursor.');
    }
    const acknowledged = this.outgoing.splice(0, cursor - this.acknowledged);
    this.outgoingSize -= acknowledged.reduce((size, message) => size + message.length, 0);
    this.acknowledged = cursor;
    if (!this.outgoing.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>(resolve => {
          this.poll = resolve;
          timer = setTimeout(resolve, 20_000);
        });
      } finally { clearTimeout(timer); this.poll = undefined; }
    }
    if (this.failure) throw this.failure;
    const messages = this.outgoing.slice();
    return { cursor: this.acknowledged + messages.length, messages };
  }

  /** End pending reads and let Cap’n Web dispose all connection-owned capabilities. */
  abort(reason: unknown): void {
    if (this.failure) return;
    this.failure = reason instanceof Error ? reason : new Error('Workshop connection closed.');
    this.receiver?.reject(this.failure);
    this.receiver = undefined;
    this.poll?.();
    this.incoming = [];
    this.outgoing = [];
    this.incomingSize = this.outgoingSize = 0;
  }
}
