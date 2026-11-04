import type { RpcTarget } from "cloudflare:workers";
import type { GadgetCapabilityJson } from "./gadget-capabilities";
/** Trusted account-only authority. Never pass this capability to an iframe or gadget root. */
export interface NativeAccountAuthority extends RpcTarget {
  identity(): Promise<{ userDurableObjectId: string; profileId: string }>;
  /** Fixed native operations only; each call freshly opens and authorizes the workspace. */
  execute(workspaceId: string, operation: string, input: GadgetCapabilityJson): Promise<GadgetCapabilityJson>;
}
