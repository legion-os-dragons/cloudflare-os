/** Keep ordinary history responses far below the native RPC's 32 MiB limit. */
export const CHAT_HISTORY_PAGE_BYTES = 8 * 1024 * 1024;
export const CHAT_HISTORY_ITEM_BYTES = 24 * 1024 * 1024;

/** JSON-shaped chat data plus native binary payloads. Binary is accounted at
 * base64 size without expanding every byte into a JSON object or large string. */
export function chatHistoryBytes(value: unknown): number {
  let binaryBytes = 0;
  const json = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Uint8Array || item instanceof ArrayBuffer) {
      binaryBytes += Math.ceil(item.byteLength / 3) * 4 + 64;
      return null;
    }
    return item;
  });
  return binaryBytes + new TextEncoder().encode(json ?? 'null').byteLength;
}
