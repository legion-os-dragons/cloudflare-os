import type {
  DurableObject,
  WorkerEntrypoint,
  RpcStub as NativeRpcStub,
  RpcTarget as NativeRpcTarget,
} from "cloudflare:workers";
import type {
  GadgetCapabilityExports,
  GadgetCommandContext,
  GadgetProjectionObserver,
} from "./gadget-capabilities";

/** Native Worker RPC observer derived from the single revision notification contract. */
export type GadgetProjectionNotification = NativeRpcTarget &
  Pick<GadgetProjectionObserver, "changed">;
/** Consumer observer includes the kernel's terminal revocation notification. */
export type GadgetProjectionConsumerObserver = NativeRpcTarget & GadgetProjectionObserver;

/** Producer-owned WorkerEntrypoint named CapabilityHandler, parameterized by its own gadget class. */
export interface GadgetCapabilityHandler<
  Gadget extends DurableObject<unknown> = DurableObject<unknown>,
> extends WorkerEntrypoint<unknown> {
  /** Declare named ports; this never grants a consumer authority. */
  describe(): Promise<GadgetCapabilityExports>;
  /** Handle only the selected projection port. The gadget stub stays inside the producer. */
  project(gadget: Fetcher<Gadget>, port: string, request: unknown): Promise<unknown>;
  /** Handle only the selected command port under kernel attribution. */
  command(
    gadget: Fetcher<Gadget>,
    port: string,
    request: unknown,
    context: GadgetCommandContext,
  ): Promise<unknown>;
  /** Retain revision notifications until the returned lease is disposed. */
  watch(
    gadget: Fetcher<Gadget>,
    port: string,
    request: unknown,
    observer: NativeRpcStub<GadgetProjectionNotification>,
  ): Promise<NativeRpcStub<NativeRpcTarget>>;
}
