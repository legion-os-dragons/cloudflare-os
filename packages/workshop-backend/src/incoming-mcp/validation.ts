import type { LegionJson } from "./types.js";

export const LIMITS = Object.freeze({
  requestBytes: 1_048_576,
  jsonDepth: 32,
  jsonNodes: 100_000,
  producerRequestBytes: 524_288,
  producerResultBytes: 1_048_576,
  responseBytes: 2_097_152,
  timeoutMilliseconds: 30_000,
});

export class InputError extends Error {}
export class LimitError extends Error {}

/** The bounded JSON-Schema subset used by the fixed server-owned tool definitions. */
export interface Schema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, Schema>;
  required?: readonly string[];
  additionalProperties?: boolean | Schema;
  propertyNames?: Schema;
  items?: Schema | false;
  prefixItems?: readonly Schema[];
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  const?: LegionJson;
  enum?: readonly LegionJson[];
  anyOf?: readonly Schema[];
  description?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Validate values before dispatch and before delivery. Never invokes getters or toJSON. */
export function assertJson(value: unknown): asserts value is LegionJson {
  let nodes = 0;
  const active = new Set<object>();
  function visit(current: unknown, depth: number): void {
    if (++nodes > LIMITS.jsonNodes || depth > LIMITS.jsonDepth) throw new LimitError("JSON structure exceeds the supported limit.");
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number" && Number.isFinite(current)) return;
    if (typeof current !== "object" || current === null) throw new InputError("Only finite JSON values are supported.");
    if (active.has(current)) throw new InputError("Cyclic values are not supported.");
    if (!Array.isArray(current) && !isRecord(current)) throw new InputError("Only plain JSON objects are supported.");
    active.add(current);
    if (Object.getOwnPropertySymbols(current).length) throw new InputError("Symbol properties are not JSON.");
    const descriptors = Object.getOwnPropertyDescriptors(current);
    if (Array.isArray(current)) {
      for (let i = 0; i < current.length; i++) {
        const descriptor = descriptors[String(i)];
        if (!descriptor || !("value" in descriptor)) throw new InputError("Sparse arrays and accessors are not supported.");
        visit(descriptor.value, depth + 1);
      }
      for (const key of Object.keys(descriptors)) {
        if (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length)) throw new InputError("Arrays may only contain indexed JSON values.");
      }
    } else {
      for (const descriptor of Object.values(descriptors)) {
        if (!("value" in descriptor) || !descriptor.enumerable) throw new InputError("Accessors and hidden properties are not JSON.");
        visit(descriptor.value, depth + 1);
      }
    }
    active.delete(current);
  }
  visit(value, 0);
}

export function encodedBytes(value: LegionJson): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function assertSchema(value: unknown, schema: Schema, path = "arguments"): void {
  if (schema.anyOf) {
    for (const choice of schema.anyOf) {
      try { assertSchema(value, choice, path); return; } catch (error) { if (!(error instanceof InputError)) throw error; }
    }
    throw new InputError(`${path} does not match a supported shape.`);
  }
  if (schema.const !== undefined && value !== schema.const) throw new InputError(`${path} has an invalid value.`);
  if (schema.enum && !schema.enum.some(item => item === value)) throw new InputError(`${path} has an unsupported value.`);
  if (schema.type === "null" && value !== null) throw new InputError(`${path} must be null.`);
  if (schema.type === "boolean" && typeof value !== "boolean") throw new InputError(`${path} must be boolean.`);
  if (schema.type === "string") {
    if (typeof value !== "string") throw new InputError(`${path} must be a string.`);
    if ((schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength)) throw new InputError(`${path} has an invalid length.`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new InputError(`${path} has an invalid format.`);
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isSafeInteger(value))) throw new InputError(`${path} must be a finite ${schema.type}.`);
    if ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) throw new InputError(`${path} is outside the supported range.`);
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new InputError(`${path} must be an array.`);
    if ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems)) throw new InputError(`${path} has an invalid number of items.`);
    for (let i = 0; i < value.length; i++) {
      const prefix = schema.prefixItems?.[i];
      if (prefix) assertSchema(value[i], prefix, `${path}[${i}]`);
      else if (schema.items === false) throw new InputError(`${path} has too many tuple entries.`);
      else if (schema.items) assertSchema(value[i], schema.items, `${path}[${i}]`);
    }
  }
  if (schema.type === "object") {
    if (!isRecord(value)) throw new InputError(`${path} must be an object.`);
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new InputError(`${path} is missing a required property.`);
    for (const [key, entry] of Object.entries(value)) {
      if (schema.propertyNames) assertSchema(key, schema.propertyNames, `${path} property name`);
      const property = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
      if (property) assertSchema(entry, property, `${path}.${key}`);
      else if (schema.additionalProperties === false) throw new InputError(`${path} contains an unknown property.`);
      else if (typeof schema.additionalProperties === "object") assertSchema(entry, schema.additionalProperties, `${path}.${key}`);
    }
  }
}

export async function readBody(request: Request): Promise<string> {
  const length = request.headers.get("content-length");
  if (length && (!/^[0-9]+$/.test(length) || Number(length) > LIMITS.requestBytes)) throw new LimitError("Request body exceeds the supported limit.");
  if (!request.body) throw new InputError("A JSON request body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, LIMITS.timeoutMilliseconds);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LIMITS.requestBytes) { await reader.cancel(); throw new LimitError("Request body exceeds the supported limit."); }
      chunks.push(value);
    }
    if (timedOut) throw new LimitError("Request body did not arrive within the supported time limit.");
  } finally { clearTimeout(timer); reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { throw new InputError("The JSON request must be valid UTF-8."); }
}
