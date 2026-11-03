// A completion signal carries no account, nonce, ticket or credential. It only
// asks each tab to re-read accounts through its own authenticated API session.
const CHANNEL = 'gadgets.connected-accounts.changed'
const STORAGE_KEY = 'gadgets.connected-accounts.changed'
export function notifyConnectedAccountsChanged(): void {
  const signal = { kind: CHANNEL, id: crypto.randomUUID() }
  try { const channel = new BroadcastChannel(CHANNEL); const broadcast = channel.postMessage.bind(channel); broadcast(signal); channel.close() } catch { /* Browser storage fallback below. */ }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(signal)); localStorage.removeItem(STORAGE_KEY) } catch { /* Returning focus also refreshes the owning tab. */ }
}
export function onConnectedAccountsChanged(refresh: () => void): () => void {
  const seen = new Set<string>()
  const receive = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    const signal = value as { kind?: unknown; id?: unknown }
    if (signal.kind !== CHANNEL || typeof signal.id !== 'string' || !/^[a-f0-9-]{36}$/.test(signal.id) || seen.has(signal.id)) return
    if (seen.size >= 64) seen.clear()
    seen.add(signal.id); refresh()
  }
  let channel: BroadcastChannel | undefined
  try { channel = new BroadcastChannel(CHANNEL); channel.addEventListener('message', event => receive(event.data)) } catch { /* Use the same-origin storage event and focus fallback. */ }
  const storage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue || event.newValue.length > 160) return
    try { receive(JSON.parse(event.newValue)) } catch { /* Ignore malformed notifications. */ }
  }
  window.addEventListener('storage', storage)
  window.addEventListener('focus', refresh)
  return () => { channel?.close(); window.removeEventListener('storage', storage); window.removeEventListener('focus', refresh) }
}
