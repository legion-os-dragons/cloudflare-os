import type { GadgetProjectionConsumerObserver } from "@gadgets/workshop-shared/gadget-capabilities-server";
import { RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  GadgetCapabilityExports,
  GadgetCapabilityIdentity,
  GadgetCapabilityJson,
  GadgetCapabilitySpec,
} from "@gadgets/workshop-shared/gadget-capabilities";
import { validateRpc } from "capnweb-validate";

/** Release an RPC result or facet without inventing a branded-stub cast. */
export function disposeCapabilityResult(value: unknown): void {
  const seen = new WeakSet<object>();
  function release(item: unknown): void {
    if (item === null || (typeof item !== "object" && typeof item !== "function") || seen.has(item))
      return;
    seen.add(item);
    if (Symbol.dispose in item) {
      const dispose = item[Symbol.dispose];
      if (typeof dispose === "function") {
        dispose.call(item);
        return;
      }
    }
    // Native RPC composite responses do not always own an aggregate disposer.
    // Rejected nested capabilities still belong to us and must be released.
    if (Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype)
      for (const child of Object.values(item)) release(child);
  }
  release(value);
}

/** Detach validated data before disposing the producer's RPC response. */
export function takeCapabilityJson(value: unknown): GadgetCapabilityJson {
  try {
    return JSON.parse(JSON.stringify(requireCapabilityJson(value)));
  } finally {
    disposeCapabilityResult(value);
  }
}

/** Copy only validated producer declarations; metadata cannot smuggle RPC capabilities. */
export function takeCapabilityExports(value: unknown): GadgetCapabilityExports {
  const json = takeCapabilityJson(value);
  if (json === null || typeof json !== "object" || Array.isArray(json))
    throw Error("Invalid gadget capability declarations.");
  const entries = Object.entries(json);
  if (entries.length > 64) throw Error("Too many gadget capability declarations.");
  return Object.fromEntries(
    entries.map(([port, row]) => {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(port) ||
        row === null ||
        typeof row !== "object" ||
        Array.isArray(row)
      )
        throw Error("Invalid gadget capability declaration.");
      const { kind, protocol } = row;
      if (
        (kind !== "projection" && kind !== "command") ||
        typeof protocol !== "string" ||
        !protocol ||
        protocol.length > 256 ||
        Object.keys(row).some((key) => key !== "kind" && key !== "protocol")
      )
        throw Error("Invalid gadget capability declaration.");
      return [port, { kind, protocol }];
    }),
  );
}

/** Fail closed before RPC capabilities, nonfinite numbers or oversized data cross a port. */
export function requireCapabilityJson(value: unknown): GadgetCapabilityJson {
  let nodes = 0;
  function check(v: unknown, depth: number): asserts v is GadgetCapabilityJson {
    if (++nodes > 100000 || depth > 64) throw Error("Gadget capability data is too large.");
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (
      typeof v !== "object" ||
      (Object.getPrototypeOf(v) !== Object.prototype && !Array.isArray(v))
    )
      throw Error("Gadget capabilities exchange JSON data only.");
    for (const x of Object.values(v)) check(x, depth + 1);
  }
  check(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1024 * 1024)
    throw Error("Gadget capability data is too large.");
  return value;
}

/** Validate a declaration at both grant time and invocation time. */
export function requireCapabilityExport(
  exports: GadgetCapabilityExports,
  spec: GadgetCapabilitySpec,
): void {
  if (
    !["projection", "command"].includes(spec.kind) ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(spec.port) ||
    !Object.hasOwn(exports, spec.port) ||
    !spec.protocol ||
    spec.protocol.length > 256
  )
    throw Error("No such gadget capability port.");
  const declared = exports[spec.port];
  if (declared.kind !== spec.kind || declared.protocol !== spec.protocol)
    throw Error("Gadget capability protocol or authority does not match.");
}

/** Revocable, method-attenuated projection broker. No producer capability is returned. */
@validateRpc()
export class GadgetProjectionBroker extends RpcTarget {
  constructor(
    private authorize: () => void,
    private projectValue: (request: GadgetCapabilityJson) => Promise<GadgetCapabilityJson>,
    private watchValue: (
      request: GadgetCapabilityJson,
      observer: RpcStub<GadgetProjectionConsumerObserver>,
    ) => Promise<RpcStub<RpcTarget>>,
    private identityValue: () => GadgetCapabilityIdentity,
  ) {
    super();
  }
  /** Identity is minted by the broker, not read from the producer. */
  async identity(): Promise<GadgetCapabilityIdentity> {
    this.authorize();
    return this.identityValue();
  }
  /** Revalidate before and after the producer read. */
  async project(request: GadgetCapabilityJson): Promise<GadgetCapabilityJson> {
    this.authorize();
    const value = await this.projectValue(requireCapabilityJson(request));
    this.authorize();
    return requireCapabilityJson(value);
  }
  /** Delivery is revalidated by the observer the kernel supplies to watchValue. */
  async subscribe(
    request: GadgetCapabilityJson,
    observer: RpcStub<GadgetProjectionConsumerObserver>,
  ): Promise<RpcStub<RpcTarget>> {
    this.authorize();
    return this.watchValue(requireCapabilityJson(request), observer);
  }
}

/** Revocable write-only broker; it exposes no read or arbitrary method surface. */
@validateRpc()
export class GadgetCommandBroker extends RpcTarget {
  constructor(
    private authorize: () => void,
    private commandValue: (request: GadgetCapabilityJson) => Promise<GadgetCapabilityJson>,
    private identityValue: () => GadgetCapabilityIdentity,
  ) {
    super();
  }
  /** Identity is minted by the broker, not read from the producer. */
  async identity(): Promise<GadgetCapabilityIdentity> {
    this.authorize();
    return this.identityValue();
  }
  /** Command protocols own fact identity, idempotency and financial validation. */
  async execute(request: GadgetCapabilityJson): Promise<GadgetCapabilityJson> {
    this.authorize();
    const value = await this.commandValue(requireCapabilityJson(request));
    this.authorize();
    return requireCapabilityJson(value);
  }
}
