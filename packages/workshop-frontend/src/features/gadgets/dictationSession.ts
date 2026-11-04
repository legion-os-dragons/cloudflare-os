import { RpcTarget } from 'capnweb'

type Options = { lang: string; continuous: boolean; interimResults: boolean }
type SpeechEvent = { type: 'result'; resultIndex: number; results: { transcript: string; isFinal: boolean }[] }
  | { type: 'error'; error: string } | { type: 'end' }
type BrowserResult = Event & { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }
type BrowserRecognition = EventTarget & {
  lang: string; continuous: boolean; interimResults: boolean
  start(): void; stop(): void; abort(): void
}
type RecognitionConstructor = new () => BrowserRecognition

const activateRecognition = Symbol('activate browser dictation')

class DictationStream extends RpcTarget {
  readonly #recognition: BrowserRecognition
  readonly #current: () => boolean
  readonly #released: () => void
  readonly #listeners = new AbortController()
  #events: SpeechEvent[] = []
  #waiting: ((event: SpeechEvent) => void) | undefined
  #closed = false
  #timeout: ReturnType<typeof setTimeout>
  readonly #visibility = () => { if (document.hidden) this.close() }
  constructor(recognition: BrowserRecognition, current: () => boolean, released: () => void) {
    super(); this.#recognition = recognition; this.#current = current; this.#released = released
    this.#timeout = setTimeout(() => this.close(), 10 * 60 * 1000)
    document.addEventListener('visibilitychange', this.#visibility)
    recognition.addEventListener('result', raw => {
      const event = raw as BrowserResult
      if (!current()) { this.close(); return }
      if (!Number.isSafeInteger(event.resultIndex) || event.resultIndex < 0 || event.results.length > 512) { this.close('result-limit'); return }
      const results: { transcript: string; isFinal: boolean }[] = []
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index], transcript = result[0]?.transcript
        if (typeof transcript !== 'string' || transcript.length > 65536) { this.close('result-limit'); return }
        results.push({ transcript, isFinal: result.isFinal === true })
      }
      this.#push({ type: 'result', resultIndex: event.resultIndex, results })
    }, { signal: this.#listeners.signal })
    recognition.addEventListener('error', raw => {
      const error = (raw as Event & { error: string }).error
      this.close(/^[a-z-]{1,64}$/.test(error) ? error : 'recognition-error')
    }, { signal: this.#listeners.signal })
    recognition.addEventListener('end', () => this.close(undefined, !current()), { signal: this.#listeners.signal })
  }
  #push(event: SpeechEvent): void {
    if (this.#closed) return
    if (this.#waiting) { const resolve = this.#waiting; this.#waiting = undefined; resolve(event) }
    else if (this.#events.length < 64) this.#events.push(event)
    else this.close('consumer-stopped')
  }
  [activateRecognition](): void { try { this.#recognition.start() } catch { this.close('recognition-error') } }
  async next(): Promise<SpeechEvent> {
    if (!this.#current()) this.close()
    const event = this.#events.shift()
    if (event) return event
    if (this.#closed) return { type: 'end' }
    if (this.#waiting) throw Error('Dictation events must be read sequentially.')
    return new Promise(resolve => { this.#waiting = resolve })
  }
  stop(): void {
    if (this.#closed) return
    clearTimeout(this.#timeout)
    this.#timeout = setTimeout(() => this.close(), 3000)
    try { this.#recognition.stop() } catch { this.close() }
  }
  close(error?: string, discard = true): void {
    if (this.#closed) { if (discard) this.#events = []; return }
    this.#closed = true; clearTimeout(this.#timeout)
    document.removeEventListener('visibilitychange', this.#visibility)
    this.#listeners.abort()
    try { this.#recognition.abort() } catch { /* Already ended by the browser. */ }
    // A closed view retains no dictated text or microphone session.
    if (discard) this.#events = []
    if (error) this.#events.push({ type: 'error', error })
    this.#events.push({ type: 'end' })
    if (this.#waiting) { const resolve = this.#waiting; this.#waiting = undefined; resolve(this.#events.shift()!) }
    this.#released()
  }
  [Symbol.dispose](): void { this.close() }
}

/** Browser-owned dictation only: no raw audio, credentials, remote URLs or persistent recordings. */
export class GadgetDictationSession extends RpcTarget {
  readonly #readAdmission: () => Promise<'workspace' | 'key'>
  readonly #current: () => boolean
  #active: DictationStream | undefined
  #starting = false
  constructor(readAdmission: () => Promise<'workspace' | 'key'>, current: () => boolean) {
    super(); this.#readAdmission = readAdmission; this.#current = current
  }
  async start(options: Options): Promise<DictationStream> {
    if (this.#starting || this.#active) throw Error('This gadget already has an active dictation session.')
    if (!this.#current() || document.hidden || !navigator.userActivation?.isActive) throw Error('Start dictation from a visible gadget button.')
    if (!options || typeof options.lang !== 'string' || !/^[A-Za-z0-9-]{1,35}$/.test(options.lang) || typeof options.continuous !== 'boolean' || typeof options.interimResults !== 'boolean') throw Error('Invalid dictation options.')
    this.#starting = true
    try {
      if (await this.#readAdmission() !== 'workspace' || !this.#current()) throw Error('Dictation requires the current workspace owner session.')
      const speech = window as typeof window & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor }
      const Constructor = speech.SpeechRecognition ?? speech.webkitSpeechRecognition
      if (!Constructor) throw Error('Browser dictation is unavailable in this browser.')
      if (!window.confirm('Start voice dictation for this gadget? Your browser’s speech service processes microphone audio. Only the resulting text is returned to this gadget.')) throw Error('Dictation was cancelled.')
      if (!this.#current() || document.hidden) throw Error('The gadget view has ended.')
      const recognition = new Constructor()
      recognition.lang = options.lang; recognition.continuous = options.continuous; recognition.interimResults = options.interimResults
      const session = new DictationStream(recognition, this.#current, () => { if (this.#active === session) this.#active = undefined })
      this.#active = session; session[activateRecognition](); return session
    } finally { this.#starting = false }
  }
  stop(): void { this.#active?.close(); this.#active = undefined }
  [Symbol.dispose](): void { this.stop() }
}
