import type { RpcTarget, RpcStub } from "capnweb";

/** Data crossing a gadget connection. RPC capabilities and executable values are excluded. */
export type GadgetCapabilityJson =
  | null
  | boolean
  | number
  | string
  | GadgetCapabilityJson[]
  | { [key: string]: GadgetCapabilityJson };
/** One explicitly exported producer port; its protocol identifies the domain-owned request schema. */
export interface GadgetCapabilitySpec {
  /** Name dispatched by the producer's CapabilityHandler. */
  port: string;
  /** Read projections and write commands are separate authorities. */
  kind: "projection" | "command";
  /** Exact versioned protocol required by this consumer. */
  protocol: string;
}
/** Producer declarations returned by CapabilityHandler.describe(). */
export type GadgetCapabilityExports = Record<string, Omit<GadgetCapabilitySpec, "port">>;
/** Broker-owned connection identity; producer-supplied JSON cannot impersonate this scope. */
export interface GadgetCapabilityIdentity extends GadgetCapabilitySpec {
  /** Workspace that issued the connection. */
  workspaceId: string;
  /** Authoritative producer gadget, independent of domain family IDs. */
  producerGadgetId: number;
  /** Unique edge generation; disconnected capabilities never revive after reconnection. */
  generation: string;
}
/** Kernel-derived attribution; consumers cannot supply or replace it. */
export interface GadgetCommandContext {
  /** Workspace issuing the connection grant. */
  workspaceId: string;
  /** Gadget invoking the command. */
  consumerGadgetId: number;
  /** Gadget owning the authoritative command handler. */
  producerGadgetId: number;
  /** Authenticated user whose authority established this connection. */
  grantedBy: string;
}
/** Notification only: the consumer re-reads a complete projection after a revision changes. */
export interface GadgetProjectionObserver {
  /** Opaque producer revision; duplicates may be coalesced by the consumer. */
  changed(revision: string): Promise<void>;
  /** Terminal kernel notification; clear live figures and reconnect explicitly. */
  unavailable(reason: string): Promise<void>;
}
/** Read-only named connection facet. It cannot invoke producer write commands. */
export interface GadgetProjectionFacet extends RpcTarget {
  /** Obtain live kernel-derived scope before composing projection and command authorities. */
  identity(): Promise<GadgetCapabilityIdentity>;
  /** Read the domain projection, including its domain-owned revision/cutoff metadata. */
  project(request: GadgetCapabilityJson): Promise<GadgetCapabilityJson>;
  /** Watch revision notifications. Dispose the returned lease to cancel. */
  subscribe(
    request: GadgetCapabilityJson,
    observer: GadgetProjectionObserver,
  ): Promise<RpcStub<GadgetCapabilityLease>>;
}
/** A subscription's only authority is cancellation. */
export interface GadgetCapabilityLease extends RpcTarget, Disposable {}
/** Write-only named connection facet. Idempotency belongs to its domain command protocol. */
export interface GadgetCommandFacet extends RpcTarget {
  /** Obtain live kernel-derived scope; never trust producer JSON as proof of identity. */
  identity(): Promise<GadgetCapabilityIdentity>;
  /** Invoke only this named command port, under the kernel-derived grant context. */
  execute(request: GadgetCapabilityJson): Promise<GadgetCapabilityJson>;
}
