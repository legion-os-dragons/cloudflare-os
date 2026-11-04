import type { LegionToolInputs, LegionToolName, LegionToolOutputs } from "./types.js";
/** Wire adapter over the authenticated Workshop API; all access decisions remain native. */
export interface McpToolRuntime {
  listAvailableTools(): Promise<readonly LegionToolName[]>;
  invoke<N extends LegionToolName>(name: N, input: LegionToolInputs[N]): Promise<LegionToolOutputs[N]>;
}
/** Authentication is supplied by the same native server that owns /api. */
export interface McpRuntime { authenticate(): Promise<McpToolRuntime> }
export class AuthenticationError extends Error {}
export class McpPublicError extends Error {
  constructor(readonly code: "access_denied"|"integration_unavailable"|"conflict"|"invalid_request"|"outcome_unknown", message:string){super(message);}
}
