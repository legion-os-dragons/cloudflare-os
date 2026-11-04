import { RpcTarget, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { keyString } from "@gadgets/typed-storage";
import type { AiChatMessage, AiChatStreamEvent } from "@gadgets/workshop-shared/api";
import type {
  NativeChatEvent,
  NativeChatMessage,
  NativeChatSink,
  NativeChatLease,
} from "@gadgets/workshop-shared/embedded-agent";
import type { EmbeddedChatBackend } from "./overseer";
import type { EmbeddedChatState } from "./embedded-agent";

type TextMessage = Extract<AiChatMessage, { type: "message" }>;
/** Expand an actual assistant's identity to its real model steps in the same user turn. */
export function embeddedVisibilityIds(
  messages: readonly AiChatMessage[],
  messageId: string,
  deletePair = false,
): string[] {
  const sequence = Number(messageId);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || String(sequence) !== messageId)
    throw Error("Unknown embedded message.");
  const rows = messages.filter((message): message is TextMessage => message.type === "message"),
    index = rows.findIndex((message) => message.sequence === sequence);
  if (index < 0) throw Error("Unknown embedded message.");
  if (rows[index].author.type !== "agent") {
    if (!deletePair) return [messageId];
    let last = index;
    while (last + 1 < rows.length && rows[last + 1].author.type === "agent") last++;
    return rows.slice(index, last + 1).map((message) => String(message.sequence));
  }
  let first = index,
    last = index;
  while (first > 0 && rows[first - 1].author.type === "agent") first--;
  while (last + 1 < rows.length && rows[last + 1].author.type === "agent") last++;
  if (deletePair && first > 0) first--;
  return rows.slice(first, last + 1).map((message) => String(message.sequence));
}
function project(message: TextMessage, state: EmbeddedChatState): NativeChatMessage {
  return {
    id: String(message.sequence),
    role: message.author.type === "agent" ? "assistant" : "user",
    content:
      message.author.type === "agent"
        ? message.message
        : JSON.stringify(
            state.partsBySequence?.[String(message.sequence)] ?? [
              { type: "text", text: message.message },
            ],
          ),
    createdAt: message.timestamp.toISOString(),
    visibility: state.visibility?.[String(message.sequence)] ?? "visible",
  };
}
/**
 * Original Brain stores one final assistant summary per turn. Workshop stores
 * each provider step; expose the last actual assistant text and its real ID,
 * without inventing durable tool-message rows the original loop never wrote.
 */
export function projectEmbeddedHistory(
  messages: readonly AiChatMessage[],
  state: EmbeddedChatState,
  active = false,
): NativeChatMessage[] {
  const result: NativeChatMessage[] = [];
  let assistant: TextMessage | undefined;
  for (const message of messages) {
    if (message.type !== "message") continue;
    if (message.author.type === "agent") {
      assistant = message;
      continue;
    }
    if (assistant) {
      result.push(project(assistant, state));
      assistant = undefined;
    }
    result.push(project(message, state));
  }
  if (assistant && !active) result.push(project(assistant, state));
  return result;
}

/** Real scoped subscriptions and provider-stream translation for embedded conversations. */
export class EmbeddedChatEvents {
  readonly #listeners = new Map<number, Set<(event: NativeChatEvent) => void>>();
  readonly #parts = new Map<number, { text?: string; reasoning?: string }>();
  constructor(
    readonly impl: EmbeddedChatBackend,
    readonly authorize: (id: number) => Promise<unknown>,
    readonly state: (id: number) => EmbeddedChatState,
  ) {}
  /** Read original user/final-assistant roles from the actual durable source rows. */
  history(id: number): NativeChatMessage[] {
    return projectEmbeddedHistory(
      [...this.impl.storage.chats.list({ prefix: keyString(id) + "." })],
      this.state(id),
      !!this.impl.storage.chatMeta.get(id)?.activeAgent,
    );
  }
  #emit(id: number, event: NativeChatEvent): void {
    for (const deliver of this.#listeners.get(id) ?? []) deliver(event);
  }
  /** Deliver only actual provider deltas, with distinct text and reasoning part identities. */
  stream(id: number, event: AiChatStreamEvent): void {
    if (!this.#listeners.has(id)) return;
    if (event.type === "textDelta" || event.type === "reasoningDelta") {
      const parts = this.#parts.get(id) ?? {},
        kind = event.type === "textDelta" ? "text" : "reasoning";
      const partId = (parts[kind] ??= crypto.randomUUID());
      this.#parts.set(id, parts);
      this.#emit(id, { type: event.type, partId, delta: event.delta });
    } else if (event.type === "toolCallStarted")
      this.#emit(id, { type: "toolCall", id: event.toolCallId, name: event.toolName });
  }
  /** Retain this exact admitted sink until lease disposal or an actual delivery failure. */
  async subscribe(id: number, sink: NativeChatSink): Promise<NativeChatLease> {
    await this.authorize(id);
    // Native RPC parameters are borrowed stubs; dup retains the admitted receiver.
    const retained = (sink as RpcStub<NativeChatSink>).dup();
    let closed = false,
      tail = Promise.resolve(),
      userMessageId: string | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      const listeners = this.#listeners.get(id);
      listeners?.delete(deliver);
      if (!listeners?.size) {
        this.#listeners.delete(id);
        this.#parts.delete(id);
      }
      this.impl.storage.chats.unsubscribe(messages);
      this.impl.storage.chatMeta.unsubscribe(metadata);
      this.impl.storage.chatModelData.unsubscribe(modelData);
      retained[Symbol.dispose]();
    };
    const deliver = (event: NativeChatEvent) => {
      tail = tail
        .then(async () => {
          if (closed) return;
          await this.authorize(id);
          if (closed) return;
          await retained.event(event);
        })
        .catch(close);
    };
    const onMessage = (message: AiChatMessage) => {
      if (message.chatId !== id) return;
      if (message.type === "message") {
        if (message.author.type === "agent") this.#parts.delete(id);
        else {
          userMessageId = String(message.sequence);
          deliver({ type: "message", message: project(message, this.state(id)) });
        }
        for (const tool of message.toolCalls ?? [])
          deliver({
            type: "toolResult",
            id: tool.toolCallId,
            name: tool.toolName,
            output: "output" in tool ? tool.output : undefined,
            ...(tool.error ? { error: tool.error } : {}),
          });
      } else if (message.type === "error") deliver({ type: "error", message: message.message });
    };
    const messages: Parameters<EmbeddedChatBackend["storage"]["chats"]["subscribe"]>[0] = {
      add: onMessage,
      update: (_old, message) => onMessage(message),
      remove: () => {},
    };
    const metadata: Parameters<EmbeddedChatBackend["storage"]["chatMeta"]["subscribe"]>[0] = {
      add: () => {},
      update: (old, meta) => {
        if (meta.id !== id) return;
        if (!old.activeAgent && meta.activeAgent) deliver({ type: "busy" });
        else if (old.activeAgent && !meta.activeAgent) {
          this.#parts.delete(id);
          const rows = this.history(id),
            last = rows.at(-1),
            assistant = last?.role === "assistant" ? last : undefined;
          if (assistant) deliver({ type: "message", message: assistant });
          deliver({
            type: "idle",
            ...(userMessageId ? { userMessageId } : {}),
            ...(assistant ? { assistantMessageId: assistant.id } : {}),
          });
        }
      },
      remove: (meta) => {
        if (meta.id === id) close();
      },
    };
    const onModelData: Parameters<
      EmbeddedChatBackend["storage"]["chatModelData"]["subscribe"]
    >[0]["add"] = (record) => {
      if (record.chatId !== id) return;
      const state = this.state(id);
      if (state.modelId)
        deliver({
          type: "usage",
          modelId: state.modelId,
          inputTokens: record.message.usage.input,
          ...(state.contextWindow ? { contextWindow: state.contextWindow } : {}),
        });
    };
    const modelData: Parameters<EmbeddedChatBackend["storage"]["chatModelData"]["subscribe"]>[0] = {
      add: onModelData,
      update: (_old, record) => onModelData(record),
      remove: () => {},
    };
    const listeners = this.#listeners.get(id) ?? new Set<(event: NativeChatEvent) => void>();
    listeners.add(deliver);
    this.#listeners.set(id, listeners);
    this.impl.storage.chats.subscribe(messages);
    this.impl.storage.chatMeta.subscribe(metadata);
    this.impl.storage.chatModelData.subscribe(modelData);
    // Never emit an initial idle: the original UI arms SSE before POSTing its turn.
    const rows = [...this.impl.storage.chats.list({ prefix: keyString(id) + "." })];
    for (const message of rows)
      if (message.type === "message" && message.author.type !== "agent")
        userMessageId = String(message.sequence);
    const latest = rows
      .toReversed()
      .find((message) => message.type === "message" && message.author.type === "agent");
    if (latest) {
      const actual = this.impl.storage.chatModelData.get(
        `${keyString(id)}.${keyString(latest.sequence)}`,
      );
      if (actual) onModelData(actual);
    }
    if (this.impl.storage.chatMeta.get(id)?.activeAgent) deliver({ type: "busy" });
    return new EmbeddedChatEventLease(close);
  }
}
@validateRpc()
class EmbeddedChatEventLease extends RpcTarget implements NativeChatLease {
  readonly #close: () => void;
  constructor(close: () => void) {
    super();
    this.#close = close;
  }
  async close(): Promise<void> {
    this.#close();
  }
  [Symbol.dispose](): void {
    this.#close();
  }
}
