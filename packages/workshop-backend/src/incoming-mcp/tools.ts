import type { LegionToolInputs, LegionToolName } from "./types.js";
import { assertSchema, encodedBytes, InputError, LIMITS, type Schema } from "./validation.js";

const text: Schema = { type: "string" };
const nonempty: Schema = { type: "string", minLength: 1, maxLength: 4096 };
const id: Schema = { type: "integer", minimum: 1 };
const position: Schema = { type: "integer", minimum: 0 };
const workspace: Schema = { type: "string", minLength: 1, maxLength: 512 };
const commit: Schema = { type: "string", pattern: "^[0-9a-f]{40}$" };
const paths: Schema = { type: "array", maxItems: 64, items: { type: "string", minLength: 1, maxLength: 4096 } };
function object(properties: Record<string, Schema>, required = Object.keys(properties)): Schema {
  return { type: "object", properties, required, additionalProperties: false };
}
const workspaceProperties = { workspaceId: workspace };
const gadgetProperties = { ...workspaceProperties, gadgetId: position };
const textChange: Schema = { type: "array", items: { anyOf: [position, { type: "array", minItems: 1, prefixItems: [position], items: text }] } };
const fileChange: Schema = { anyOf: [object({ edit: textChange }), object({ set: text }), object({ remove: { const: true } })] };
const filePair: Schema = { type: "array", minItems: 2, maxItems: 2, prefixItems: [{ type: "string", minLength: 1, maxLength: 4096 }, fileChange], items: false };
const submission = object({
  generation: position,
  revision: position,
  clientId: { type: "string", minLength: 1, maxLength: 1024 },
  seq: id,
  pins: { type: "array", items: object({ gadgetId: position, baseCommit: commit }) },
  change: {
    type: "object",
    propertyNames: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
    additionalProperties: { type: "array", minItems: 1, items: filePair },
  },
}, ["generation", "revision", "clientId", "seq", "change"]);
function dataSchema(kind: "projection" | "command"): Schema {
  return object({ ...gadgetProperties, spec: object({ port: nonempty, kind: { const: kind }, protocol: nonempty }), request: {} });
}

export interface ToolDefinition {
  name: LegionToolName;
  title: string;
  description: string;
  inputSchema: Schema;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}
function tool(name: LegionToolName, title: string, description: string, inputSchema: Schema, readOnly = true, idempotent = true): ToolDefinition {
  return { name, title, description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: idempotent, openWorldHint: name === "legion_data_command" || name === "legion_data_query" } };
}

export const TOOL_DEFINITIONS: Readonly<Record<LegionToolName, ToolDefinition>> = Object.freeze({
  legion_workspace_get: tool("legion_workspace_get", "Read workspace", "Read the selected workspace title and your current role. Workspace IDs route requests; they do not confer access.", object(workspaceProperties)),
  legion_gadget_list: tool("legion_gadget_list", "List gadgets", "List visible gadget workpieces and their committed code heads in this workspace.", object(workspaceProperties)),
  legion_data_ports: tool("legion_data_ports", "Discover gadget data ports", "Read producer-declared projection and command ports and exact versioned protocol identifiers. Use the producer's existing typed protocol contract to construct a request.", object(gadgetProperties)),
  legion_data_query: tool("legion_data_query", "Query gadget data", "Read one explicitly exported projection using its exact port and versioned protocol. Request and result follow that producer's existing typed contract. Only finite bounded JSON is accepted.", dataSchema("projection")),
  legion_data_command: tool("legion_data_command", "Execute gadget command", "Execute one explicitly exported command using its exact port and versioned protocol. Request and result follow that producer's existing typed contract. Requires native command access. Use the producer's idempotency and outcome-recovery rules; do not automatically retry an uncertain result.", dataSchema("command"), false, false),
  legion_access_list: tool("legion_access_list", "Inspect workspace access", "Read the native collaborator and share-link metadata available to your current Workshop account.", object(workspaceProperties)),
  legion_code_tree: tool("legion_code_tree", "Read committed code tree", "Read the tree of a commit belonging to a currently accessible gadget. Requires build access.", object({ ...gadgetProperties, commitId: commit })),
  legion_code_read: tool("legion_code_read", "Read committed code files", "Read up to 64 file paths from an authorized gadget commit. unansweredPaths were omitted by a response budget and must not be treated as absent. Requires build access.", object({ ...gadgetProperties, commitId: commit, paths })),
  legion_code_snapshot: tool("legion_code_snapshot", "Read draft code snapshot", "Read selected draft files together with a chat code stream's generation, revision and visible pins. Requires build access. Use this draft position when composing a code submission.", object({ ...gadgetProperties, chatId: position, paths })),
  legion_code_submit: tool("legion_code_submit", "Stage code changes", "Stage one native code-change submission in an existing chat draft. Requires native build access. Keep one request in flight per clientId and retry transport failures with the identical payload and seq. Owner acceptance in Workshop advances committed code.", object({ ...workspaceProperties, chatId: position, submission }), false, true),
});

export function isToolName(name: string): name is LegionToolName {
  return Object.hasOwn(TOOL_DEFINITIONS, name);
}

export function validateToolInput<N extends LegionToolName>(name: N, value: unknown): asserts value is LegionToolInputs[N] {
  assertSchema(value, TOOL_DEFINITIONS[name].inputSchema);
  if ((name === "legion_data_query" || name === "legion_data_command") && value && typeof value === "object" && "request" in value) {
    // assertJson on the whole message ran before this check.
    const json = value.request as import("./types.js").LegionJson;
    if (encodedBytes(json) > LIMITS.producerRequestBytes) throw new InputError("Producer request exceeds the supported limit.");
  }
}
