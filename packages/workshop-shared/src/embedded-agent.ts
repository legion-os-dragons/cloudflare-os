import type { RpcTarget } from "cloudflare:workers";
import type { GadgetRequestContext } from "./gadget-capabilities";

/** Live kernel-issued caller guard, forwarded as a capability rather than asserted JSON. */
export interface NativeChatGuard
  extends RpcTarget, Pick<GadgetRequestContext, "current" | "authorize"> {
  /** Producer-only proof using the existing kernel bridge token; never expose to agents or JSON. */ producerProof(): Promise<string>;
}
/** Original application scope; kernel actor and producer identity are checked separately. */
export interface NativeChatScope {
  /** Original application session ID. */ sessionId: string;
  /** Must equal the authenticated kernel actor. */ actorId: string;
  /** Original application tenant. */ tenantId: string;
  /** Original application workspace, not the kernel workspace ID. */ workspaceId: string;
  /** Producer application scope. */ scopeId: string;
  /** Original application agent configuration key. */ agentKey: string;
}
/** One actually configured model; no credentials or silent model aliases. */
export interface NativeChatModel {
  /** Kernel model profile ID used when sending. */ id: string;
  /** Actual configured display name. */ name: string;
  /** Actual provider identifier. */ providerID: string;
  /** Actual provider model identifier. */ modelID: string;
  /** Configured context window when known. */ contextWindow?: number;
  /** Supported thinking control when verified. */ thinking?: {
    enabled: boolean;
    budgetTokens?: number;
  };
}
/** Original message part; attachment URLs are labels, never network authority. */
export interface NativeChatPart {
  /** Part kind. */ type: "text" | "file";
  /** Text content. */ text?: string;
  /** Attachment media type. */ mime?: string;
  /** Application-owned attachment reference. */ url?: string;
  /** Original attachment name. */ filename?: string;
}
/** Persisted message projected into the original application's transcript. */
export interface NativeChatMessage {
  /** Stable kernel sequence ID. */ id: string;
  /** Original transcript role. */ role: "user" | "assistant" | "tool_call" | "tool_result";
  /** Original content. */ content: string;
  /** Original event time. */ createdAt: string;
  /** Hidden affects rendering; deleted affects future model replay. */ visibility?:
    | "visible"
    | "hidden"
    | "deleted";
}
/** Actual model and tool events delivered to the original renderer. */
export type NativeChatEvent =
  | { type: "textDelta" | "reasoningDelta"; partId: string; delta: string }
  | { type: "toolCall"; id: string; name: string; input?: unknown }
  | { type: "toolResult"; id: string; name: string; output: unknown; error?: string }
  | { type: "message"; message: NativeChatMessage }
  | { type: "idle"; userMessageId?: string; assistantMessageId?: string }
  | { type: "busy" }
  | { type: "error"; message: string }
  | { type: "usage"; modelId: string; inputTokens: number; contextWindow?: number };
/** Only receives chat events; it grants no application data access. */
export interface NativeChatSink extends RpcTarget {
  /** Deliver one actual kernel/model event. */ event(event: NativeChatEvent): Promise<void>;
}
/** Producer-owned persistent renderer. The agent never receives this raw capability. */
export interface NativeChatTarget extends RpcTarget {
  /** Invoke one declared renderer syscall under a fresh kernel-issued caller guard. */
  call(method: string, params: unknown, guard: NativeChatGuard): Promise<unknown>;
}
/** Original send options, with attachment bytes resolved by the owning application. */
export interface NativeChatTurn {
  /** Exact configured model profile ID. */ modelId: string;
  /** Original message parts. */ parts: NativeChatPart[];
  /** Original application system instructions. */ system?: string;
  /** Requested thinking behavior. */ thinking?: { enabled: boolean; budgetTokens?: number };
  /** Original active renderer grounding. */ grounding?: { generation: string; active: unknown };
  /** App-owned streams avoid aggregate RPC serialization limits; URLs grant no network access. */
  attachments?: {
    /** Original application-owned attachment label. */ url: string;
    /** Original filename. */ filename: string;
    /** Claimed media type, validated against the actual streamed bytes. */ mime: string;
    /** Exact file size; each original attachment is limited to 20 MiB. */ byteLength: number;
    /** Byte stream from the owning application's filesystem. */ stream: ReadableStream<Uint8Array>;
  }[];
}
/** A subscription can only be closed. */
export interface NativeChatLease extends RpcTarget {
  /** Release this sink and its retained capabilities. */ close(): Promise<void>;
}
/** Caller-scoped host injected beside GADGET_REQUEST; no account-wide dispatcher. */
export interface NativeChatHost {
  /** List only this authenticated user's configured models. */ models(): Promise<
    NativeChatModel[]
  >;
  /** Create an empty-env session with one private restricted renderer callback. */ create(
    input: NativeChatScope & { title: string },
    target: NativeChatTarget,
  ): Promise<string>;
  /** Append a real user message and queue the actual selected model. */ send(
    chatId: string,
    turn: NativeChatTurn,
  ): Promise<void>;
  /** Subscribe once to actual events from this session only. */ subscribe(
    chatId: string,
    sink: NativeChatSink,
  ): Promise<NativeChatLease>;
  /** Read this session's original transcript. */ history(
    chatId: string,
  ): Promise<NativeChatMessage[]>;
  /** Stop this session's active turn. */ stop(chatId: string): Promise<void>;
  /** Hidden remains model context; deleted atomically removes the original paired user/assistant turn from subsequent replay. */ setMessageVisibility(
    chatId: string,
    messageId: string,
    visibility: "visible" | "hidden" | "deleted",
  ): Promise<void>;
}
