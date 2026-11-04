import type { LegionJson, LegionToolName } from "./types.js";
import { AuthenticationError } from "./runtime.js";
import { McpPublicError, type McpRuntime } from "./runtime.js";
import { isToolName, TOOL_DEFINITIONS, validateToolInput } from "./tools.js";
import { assertJson, encodedBytes, InputError, isRecord, LimitError, LIMITS, readBody } from "./validation.js";

const PROTOCOL_VERSIONS: readonly string[] = ["2025-11-25", "2025-06-18"];
const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
type RpcId = string | number | null;

class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}
class InvocationTimeout extends Error {}
function response(status: number, value?: LegionJson, headers: Record<string, string> = {}): Response {
  if (value === undefined) return new Response(null, { status, headers: { ...HEADERS, ...headers } });
  return new Response(JSON.stringify(value), { status, headers: { ...HEADERS, "content-type": "application/json", ...headers } });
}
function rpcError(id: RpcId, code: number, message: string, status = 200): Response {
  return response(status, { jsonrpc: "2.0", id, error: { code, message } });
}
async function deadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new InvocationTimeout()), LIMITS.timeoutMilliseconds); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
function hasOnly(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).every(key => keys.includes(key));
}
function requestId(value: unknown): RpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value)) ? value : null;
}
function unauthenticated(): Response {
  return response(401, { error: "not_authenticated", message: "Authenticate with the existing Workshop session or Cloudflare Access connection." });
}
function toolFailure(id: RpcId, code: string, message: string): Response {
  return response(200, {
    jsonrpc: "2.0", id,
    result: {
      content: [{ type: "text", text: message }],
      structuredContent: { error: { code, message } },
      isError: true,
    },
  });
}

/** Stateless Streamable HTTP. All authority stays in the trusted runtime, never clientInfo. */
export function createMcpHandler(runtime: McpRuntime): (request: Request) => Promise<Response> {
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== url.origin) return response(403, { error: "origin_not_allowed" });
    if (url.search) return response(404, { error: "not_found" });
    if (request.method !== "POST") return response(405, undefined, { allow: "POST" });
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") return response(415, { error: "content_type_required" });
    const accept = request.headers.get("accept") ?? "";
    if (!accept.split(",").some(value => ["application/json", "*/*"].includes(value.split(";", 1)[0]?.trim().toLowerCase() ?? ""))) return response(406, { error: "json_response_required" });
    // A session header can be sent by stale client configuration; it never identifies a person.
    let nativeTools;
    try { nativeTools = await deadline(runtime.authenticate()); }
    catch (error) {
      if (error instanceof InvocationTimeout)
        return response(503, { error: "authentication_unavailable" }, { "retry-after": "5" });
      return unauthenticated();
    }

    let raw: unknown;
    try {
      const body = await deadline(readBody(request));
      try { raw = JSON.parse(body); } catch { return rpcError(null, -32700, "Invalid JSON.", 400); }
      assertJson(raw);
    } catch (error) {
      if (error instanceof LimitError) return rpcError(null, -32600, error.message, 413);
      if (error instanceof InputError) return rpcError(null, -32600, error.message, 400);
      return rpcError(null, -32600, "Unable to read the request body.", 400);
    }
    if (!isRecord(raw)) return rpcError(null, -32600, "A single JSON-RPC object is required.", 400);
    const hasId = Object.hasOwn(raw, "id");
    const id = requestId(raw.id);
    if (raw.jsonrpc !== "2.0" || typeof raw.method !== "string" || (hasId && id === null) || !hasOnly(raw, ["jsonrpc", "id", "method", "params"])) return rpcError(id, -32600, "Invalid JSON-RPC request.", 400);
    if (raw.method !== "initialize") {
      const protocol = request.headers.get("mcp-protocol-version");
      if (!protocol || !PROTOCOL_VERSIONS.includes(protocol)) return rpcError(id, -32600, "A supported MCP-Protocol-Version header is required.", 400);
    }
    if (!hasId) {
      // Supported notifications carry no response. Unknown well-formed notifications are ignored.
      if (raw.method === "notifications/initialized" && raw.params !== undefined && !isRecord(raw.params)) return response(400, { error: "invalid_notification" });
      return response(202);
    }

    try {
      if (raw.method === "initialize") {
        if (!isRecord(raw.params) || !hasOnly(raw.params, ["protocolVersion", "capabilities", "clientInfo", "_meta"]) || typeof raw.params.protocolVersion !== "string" || !isRecord(raw.params.capabilities) || !isRecord(raw.params.clientInfo) || typeof raw.params.clientInfo.name !== "string" || typeof raw.params.clientInfo.version !== "string") throw new RpcError(-32602, "Invalid initialize parameters.");
        return response(200, {
          jsonrpc: "2.0", id,
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(raw.params.protocolVersion) ? raw.params.protocolVersion : PROTOCOL_VERSIONS[0]!,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "legion-os-mcp", version: "0.1.0" },
          },
        });
      }
      if (raw.method === "ping") return response(200, { jsonrpc: "2.0", id, result: {} });
      if (raw.method === "tools/list") {
        if (raw.params !== undefined && (!isRecord(raw.params) || !hasOnly(raw.params, ["_meta"]))) throw new RpcError(-32602, "This bounded catalog does not use pagination cursors.");
        const names = await deadline(nativeTools.listAvailableTools());
        const unique = [...new Set(names)];
        if (unique.some(name => !isToolName(name))) throw new Error("Trusted runtime returned an unknown tool.");
        const tools = unique.map(name => TOOL_DEFINITIONS[name]);
        assertJson(tools);
        if (encodedBytes(tools) > LIMITS.responseBytes) throw new LimitError("Tool catalog exceeds the supported limit.");
        return response(200, { jsonrpc: "2.0", id, result: { tools } });
      }
      if (raw.method === "tools/call") {
        if (!isRecord(raw.params) || !hasOnly(raw.params, ["name", "arguments", "_meta"]) || typeof raw.params.name !== "string" || !isToolName(raw.params.name)) throw new RpcError(-32602, "Unknown tool or invalid tool-call parameters.");
        const name: LegionToolName = raw.params.name;
        const args = raw.params.arguments ?? {};
        validateToolInput(name, args);
        const result: unknown = await deadline(nativeTools.invoke(name, args));
        assertJson(result);
        if (!isRecord(result)) throw new Error("Tool results must be objects.");
        if ((name === "legion_data_query" || name === "legion_data_command") && encodedBytes(result.result as LegionJson) > LIMITS.producerResultBytes) throw new LimitError("Producer result exceeds the supported limit.");
        // Keep small-result compatibility text; large data lives once in structuredContent.
        const makeWire = () => {
          const text = JSON.stringify(result);
          return { jsonrpc: "2.0", id, result: {
            content: [{ type: "text", text: encodedBytes(text) <= 65_536 ? text : "Result available in structuredContent." }],
            structuredContent: result,
          } };
        };
        let wire = makeWire();
        if ((name === "legion_code_read" || name === "legion_code_snapshot") && Array.isArray(result.files) && Array.isArray(result.unansweredPaths)) {
          // Preserve native omission semantics: remaining paths are explicitly unanswered,
          // never falsely absent. Each response must make progress on at least one file.
          while (encodedBytes(wire) > LIMITS.responseBytes && result.files.length > 1) {
            const omitted = result.files.pop() as [string, unknown];
            result.unansweredPaths.unshift(omitted[0]);
            wire = makeWire();
          }
        }
        assertJson(wire);
        if (encodedBytes(wire) > LIMITS.responseBytes) throw new LimitError("Tool result exceeds the supported limit.");
        return response(200, wire);
      }
      throw new RpcError(-32601, "Method not found.");
    } catch (error) {
      if (error instanceof AuthenticationError) return unauthenticated();
      if (error instanceof RpcError) return rpcError(id, error.code, error.message);
      if (error instanceof InputError) return rpcError(id, -32602, error.message);
      if (error instanceof McpPublicError) return raw.method === "tools/call"
        ? toolFailure(id, error.code, error.message)
        : rpcError(id, -32603, error.message);
      if (error instanceof InvocationTimeout || error instanceof LimitError) {
        if (raw.method !== "tools/call") return rpcError(id, -32603, "The operation exceeded the supported time or result limits.");
        const effectful = isRecord(raw.params) && (raw.params.name === "legion_data_command" || raw.params.name === "legion_code_submit" || raw.params.name === "legion_gadget_request");
        return toolFailure(id, effectful ? "outcome_unknown" : "limit_exceeded", effectful
          ? "The operation did not return within the supported limits. It may have taken effect. Recover its outcome using the producer's protocol or retry an identical native code submission; do not issue a new command automatically."
          : "The operation exceeded the supported time or result limits.");
      }
      return raw.method === "tools/call"
        ? toolFailure(id, "integration_failed", "The operation failed at the trusted host boundary.")
        : rpcError(id, -32603, "The operation failed at the trusted host boundary.");
    }
  };
}
