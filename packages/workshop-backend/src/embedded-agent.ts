import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { keyString } from "@gadgets/typed-storage";
import type {
  NativeChatHost,
  NativeChatScope,
  NativeChatTarget,
  NativeChatPart,
} from "@gadgets/workshop-shared/embedded-agent";
import type { GadgetRequestIdentity } from "@gadgets/workshop-shared/gadget-capabilities";
import type { AiChatStreamEvent } from "@gadgets/workshop-shared/api";
import type { EmbeddedChatBackend } from "./overseer";
import { requireCapabilityJson } from "./gadget-capabilities";
import { validateChatAttachmentUpload } from "./chat-attachment-validation";
import { EmbeddedChatEvents, embeddedVisibilityIds } from "./embedded-agent-events";
import { modelApiSupportsPdfAttachments } from "./chat-attachment-pdf";

/** Persistent restrictions on a chat created by an authenticated gadget caller. */
export interface EmbeddedChatState {
  actorId: string;
  gadgetId: number;
  revision: number;
  scope: NativeChatScope;
  rawTargetSequence: number;
  system?: string;
  thinking?: { enabled: boolean };
  modelId?: string;
  contextWindow?: number;
  visibility?: Record<string, "visible" | "hidden" | "deleted">;
  partsBySequence?: Record<string, NativeChatPart[]>;
}
const SYSCALLS = new Set([
  "legion_target_get_active",
  "legion_target_surface_snapshot",
  "legion_target_surface_capabilities_search",
  "legion_target_surface_capability_describe",
  "legion_target_surface_execute",
  "legion_target_surface_execute_batch",
]);
const key = (chatId: number, sequence: number) => `${keyString(chatId)}.${keyString(sequence)}`;

/** Reuses ordinary chat persistence and inference, with no code or ambient bindings. */
export class EmbeddedChatBroker {
  readonly #events: EmbeddedChatEvents;
  constructor(readonly impl: EmbeddedChatBackend) {
    this.#events = new EmbeddedChatEvents(
      impl,
      (id) => this.#authorize(id),
      (id) => this.#state(id),
    );
  }
  #id(value: string): number {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 0 || String(id) !== value)
      throw Error("Unknown embedded conversation.");
    return id;
  }
  #state(id: number): EmbeddedChatState {
    const value = this.impl.getChatAgentContext(id).embedded;
    if (!value || !this.impl.storage.chatMeta.get(id))
      throw Error("Unknown embedded conversation.");
    return value;
  }
  #enabled(gadgetId: number): void {
    const edge = this.impl.getGadgetRecord(gadgetId).bindings.AGENT_SPAWNER,
      record = edge && !edge.pending && this.impl.storage.gatekeepers.get(edge.target);
    if (
      !record ||
      record.creationSpec?.type !== "agentSpawner" ||
      record.creationSpec.config.modelId !== null ||
      Object.keys(record.creationSpec.config.env).length
    )
      throw Error("Connect an empty-env agent spawner before using embedded chat.");
    this.impl.assertGatekeeperUsable(record.id);
  }
  async #authorize(id: number): Promise<GadgetRequestIdentity> {
    const state = this.#state(id);
    this.#enabled(state.gadgetId);
    return this.impl.resolveEmbeddedIdentity(state.gadgetId, state.actorId, state.revision);
  }
  async #owned(id: number, identity: GadgetRequestIdentity): Promise<EmbeddedChatState> {
    const state = this.#state(id);
    if (state.actorId !== identity.actorId || state.gadgetId !== identity.gadgetId)
      throw Error("This embedded conversation belongs to a different caller.");
    await this.#authorize(id);
    return state;
  }
  host(resolve: () => Promise<GadgetRequestIdentity>): NativeChatHost {
    const caller = async () => {
      const identity = await resolve();
      this.#enabled(identity.gadgetId);
      return identity;
    };
    return {
      models: async () => {
        const identity = await caller();
        const profiles = await this.impl.getEmbeddedUserModels(identity.actorId);
        return Promise.all(
          profiles.map(async (profile) => {
            const context = await this.impl.getEmbeddedUserContext(identity.actorId, profile.id);
            if (!context.aiModel) throw Error("Configured model is unavailable.");
            const config = context.aiModel.config,
              handle = this.impl.getEmbeddedModelCapabilities(config, context.profile);
            return {
              id: profile.id,
              name: profile.name,
              providerID: config.provider,
              modelID: config.model,
              ...(config.contextWindow ? { contextWindow: config.contextWindow } : {}),
              ...(handle.reasoning ? { thinking: { enabled: true } } : {}),
            };
          }),
        );
      },
      create: async (input, target) => {
        const identity = await caller();
        if (input.actorId !== identity.actorId)
          throw Error("The embedded actor must match the current kernel caller.");
        for (const value of [
          input.sessionId,
          input.tenantId,
          input.workspaceId,
          input.scopeId,
          input.agentKey,
        ])
          if (typeof value !== "string" || !value)
            throw Error("The embedded application scope is incomplete.");
        if (typeof input.title !== "string") throw Error("The embedded title must be a string.");
        for (const context of this.impl.storage.chatContext.list()) {
          const state = context.embedded;
          if (
            state &&
            state.actorId === identity.actorId &&
            state.gadgetId === identity.gadgetId &&
            JSON.stringify(state.scope) ===
              JSON.stringify({
                sessionId: input.sessionId,
                actorId: input.actorId,
                tenantId: input.tenantId,
                workspaceId: input.workspaceId,
                scopeId: input.scopeId,
                agentKey: input.agentKey,
              })
          )
            return String(context.chatId);
        }
        const id = this.impl.nextChatId(),
          timestamp = this.impl.getChatTimestamp(),
          profile = (await this.impl.getEmbeddedUserContext(identity.actorId, null)).profile;
        const raw = this.impl.nextChatSequence(id),
          sequence = this.impl.nextChatSequence(id),
          scope: NativeChatScope = {
            sessionId: input.sessionId,
            actorId: identity.actorId,
            tenantId: input.tenantId,
            workspaceId: input.workspaceId,
            scopeId: input.scopeId,
            agentKey: input.agentKey,
          };
        this.impl.storage.chatMeta.put({
          id,
          title: input.title,
          started: timestamp,
          lastActive: timestamp,
          spawnerName: input.title,
        });
        this.impl.storage.chatContext.put({
          chatId: id,
          spawnerConfig: { displayName: input.title, modelId: null, env: {} },
          bindings: {},
          alwaysAvailableCapsuleIds: [],
          embedded: {
            actorId: identity.actorId,
            gadgetId: identity.gadgetId,
            revision: this.impl.getGadgetRecord(identity.gadgetId).accessRevision ?? 0,
            scope,
            rawTargetSequence: raw,
          },
        });
        this.impl.storage.agentCallbackArgs.put({ chatId: id, sequence: raw, args: [target] });
        const proxy = await this.impl.restoreEmbeddedRenderer(id);
        this.impl.storage.agentCallbackArgs.put({ chatId: id, sequence, args: [proxy] });
        this.impl.storage.chats.put({
          chatId: id,
          sequence,
          timestamp,
          author: profile,
          type: "agentCallback",
          methodName: "connect",
          bindingName: "RENDERER",
          argsSummary:
            "A restricted renderer capability is available as env.RENDERER[0]. It supports only the six declared application syscalls.",
        });
        await caller();
        return String(id);
      },
      send: async (chatId, turn) => {
        let identity = await caller(),
          id = this.#id(chatId),
          state = await this.#owned(id, identity);
        this.impl.assertChatNotActive(id);
        const context = await this.impl.getEmbeddedUserContext(identity.actorId, turn.modelId);
        if (!context.aiModel) throw Error("The selected model is unavailable.");
        if (turn.thinking?.budgetTokens !== undefined)
          throw Error("This native model interface does not support a numeric thinking budget.");
        const handle = this.impl.getEmbeddedModelCapabilities(
          context.aiModel.config,
          context.profile,
        );
        if (turn.thinking?.enabled && !handle.reasoning)
          throw Error("The selected model does not support thinking.");
        const text = turn.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n");
        if (!text.trim() && !turn.attachments?.length)
          throw Error("Cannot send an empty chat message.");
        const attachments = [];
        for (const item of turn.attachments ?? []) {
          if (item.bytes.byteLength > 20 * 1024 * 1024)
            throw Error("The original attachment exceeds 20 MiB.");
          const validated = validateChatAttachmentUpload(
            { mimeType: item.mime, name: item.filename, content: item.bytes },
            context.aiModel.config.provider,
            20 * 1024 * 1024,
          );
          if (
            validated.mimeType === "application/pdf" &&
            !modelApiSupportsPdfAttachments(handle.api)
          )
            throw Error("The selected model cannot accept PDF attachments.");
          const fileId = crypto.randomUUID();
          for (let offset = 0; offset < item.bytes.byteLength; offset += 65536)
            await this.impl.embeddedAttachmentStorage.put(
              `embedded-attachment:${id}:${fileId}:${offset}`,
              item.bytes.slice(offset, offset + 65536),
            );
          await this.impl.embeddedAttachmentStorage.put(
            `embedded-attachment:${id}:${fileId}:length`,
            item.bytes.byteLength,
          );
          attachments.push({
            id: fileId,
            mimeType: validated.mimeType,
            name: validated.name,
            size: item.bytes.byteLength,
          });
        }
        await caller();
        this.impl.assertChatNotActive(id);
        state = this.#state(id);
        state.system = turn.system;
        state.thinking = turn.thinking && { enabled: turn.thinking.enabled };
        state.modelId = turn.modelId;
        state.contextWindow = context.aiModel.config.contextWindow;
        this.impl.storage.chatContext.put({
          ...this.impl.getChatAgentContext(id),
          embedded: state,
        });
        const sequence = this.impl.nextChatSequence(id);
        state.partsBySequence = { ...state.partsBySequence, [String(sequence)]: turn.parts };
        this.impl.storage.chatContext.put({
          ...this.impl.getChatAgentContext(id),
          embedded: state,
        });
        const meta = this.impl.getChatMetaOrThrow(id);
        meta.lastActive = this.impl.getChatTimestamp();
        meta.activeAgent = context.aiModel.profile;
        this.impl.storage.chatMeta.put(meta);
        this.impl.storage.chats.put({
          chatId: id,
          sequence,
          timestamp: meta.lastActive,
          author: context.profile,
          type: "message",
          message: text,
          ...(attachments.length ? { attachments } : {}),
        });
        this.impl.startAgent(id, context.aiModel, context.profile, identity.actorId, false, true);
      },
      subscribe: async (chatId, sink) => {
        const identity = await caller(),
          id = this.#id(chatId);
        await this.#owned(id, identity);
        return this.#events.subscribe(id, sink);
      },
      history: async (chatId) => {
        const identity = await caller(),
          id = this.#id(chatId);
        await this.#owned(id, identity);
        return this.#events.history(id);
      },
      stop: async (chatId) => {
        const identity = await caller(),
          id = this.#id(chatId);
        await this.#owned(id, identity);
        this.impl.cancelAgent(id);
      },
      setMessageVisibility: async (chatId, messageId, visibility) => {
        const identity = await caller(),
          id = this.#id(chatId),
          state = await this.#owned(id, identity);
        this.impl.assertChatNotActive(id);
        const ids = embeddedVisibilityIds(
          [...this.impl.storage.chats.list({ prefix: keyString(id) + "." })],
          messageId,
          visibility === "deleted",
        );
        state.visibility = { ...state.visibility };
        for (const message of ids) state.visibility[message] = visibility;
        this.impl.storage.chatContext.put({
          ...this.impl.getChatAgentContext(id),
          embedded: state,
        });
        const meta = this.impl.getChatMetaOrThrow(id);
        delete meta.compactedTo;
        delete meta.totalTokens;
        this.impl.storage.chatMeta.put(meta);
      },
    };
  }
  stream(id: number, event: AiChatStreamEvent) {
    this.#events.stream(id, event);
  }
  async attachment(chatId: number, id: string): Promise<Uint8Array> {
    const length = await this.impl.embeddedAttachmentStorage.get<number>(
      `embedded-attachment:${chatId}:${id}:length`,
    );
    if (length === undefined) throw Error("Embedded attachment is unavailable.");
    const bytes = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += 65536) {
      const part = await this.impl.embeddedAttachmentStorage.get<Uint8Array>(
        `embedded-attachment:${chatId}:${id}:${offset}`,
      );
      if (!part) throw Error("Embedded attachment is incomplete.");
      bytes.set(part, offset);
    }
    return bytes;
  }
  async call(chatId: number, method: string, params: unknown) {
    if (!SYSCALLS.has(method)) throw Error("The embedded agent cannot invoke that syscall.");
    const state = this.#state(chatId),
      guard = this.impl.embeddedGuard(state.gadgetId, state.actorId, state.revision);
    await guard.authorize();
    const record = this.impl.storage.agentCallbackArgs.get(key(chatId, state.rawTargetSequence)),
      target = record?.args[0] as NativeChatTarget | undefined;
    if (!target) throw Error("The original renderer callback is unavailable.");
    const result = await target.call(method, requireCapabilityJson(params), guard);
    await guard.authorize();
    return requireCapabilityJson(result);
  }
}
@validateRpc()
export class EmbeddedRendererProxy extends RpcTarget {
  readonly #broker: EmbeddedChatBroker;
  readonly #chatId: number;
  constructor(broker: EmbeddedChatBroker, chatId: number) {
    super();
    this.#broker = broker;
    this.#chatId = chatId;
  }
  async call(method: string, params: unknown): Promise<unknown> {
    return this.#broker.call(this.#chatId, method, params);
  }
}
