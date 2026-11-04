import {codeChangeSerializedSize, type CodeChange} from '@gadgets/workshop-shared/code-change';

/** Keep the cheap UTF-16 bound for ordinary edits; canonicalize a large JSON-only change.
 * V8's one-byte JSON parser allocates decoded Latin-1 strings as one-byte strings. Feeding
 * it an ASCII source (including escaped Unicode) makes the representation independent of
 * whether an input happened to be a slice of a two-byte string. Wide strings retain the
 * original two-byte bound. Structure/header allowances remain those of the shared helper.
 * This is an upper bound, not an exact serializer or a larger storage limit.
 */
export function prepareCodeChangeStorage(change: CodeChange, cheapBoundLimit: number):
    {change: CodeChange, bytes: number} {
  const conservative = codeChangeSerializedSize(change);
  if (conservative <= cheapBoundLimit) return {change, bytes: conservative};
  const ascii = JSON.stringify(change).replace(/[\u0080-\uffff]/g,
      c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const canonical: CodeChange = JSON.parse(new TextDecoder().decode(new TextEncoder().encode(ascii)));
  let bytes = codeChangeSerializedSize(canonical);
  for (const entries of Object.values(canonical)) {
    for (const [, file] of entries) {
      if ('set' in file && !/[\u0100-\uffff]/.test(file.set)) bytes -= file.set.length;
    }
  }
  return {change: canonical, bytes};
}
