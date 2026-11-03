/** Canonical producer/broker contracts; type-only exports add no authority or runtime dependency. */
export type {
  GadgetCapabilityExports,
  GadgetCapabilityIdentity,
  GadgetCapabilityJson,
  GadgetCapabilitySpec,
  GadgetCommandContext,
  GadgetCommandFacet,
  GadgetProjectionFacet,
  GadgetProjectionObserver,
} from "@gadgets/workshop-shared/gadget-capabilities";

export type {
  GadgetCapabilityHandler,
  GadgetProjectionNotification,
} from "@gadgets/workshop-shared/gadget-capabilities-server";

/** The same DOM-free subscription lifecycle works with a Worker RpcTarget constructor. */
export {
  watchProjection,
  type ProjectionSnapshot,
  type ProjectionWatch,
  type ProjectionWatchOptions,
} from "./src/watch";
