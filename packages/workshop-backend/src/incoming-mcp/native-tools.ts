import { RpcStub, RpcTarget } from "capnweb";
import type { AuthenticatedApi, WorkpieceSummary, WorkpiecesSubscriber } from "@gadgets/workshop-shared/api";
import type { LegionToolInputs, LegionToolName, LegionToolOutputs } from "./types.js";
import type { McpToolRuntime } from "./runtime.js";
import { McpPublicError } from "./runtime.js";
import { assertJson, LimitError } from "./validation.js";
import { TOOL_DEFINITIONS } from "./tools.js";
import { takeCapabilityJson, takeCapabilityExports, disposeCapabilityResult } from "../gadget-capabilities.js";
class Workpieces extends RpcTarget implements WorkpiecesSubscriber {
  readonly rows = new Map<number, WorkpieceSummary>();
  #resolveReady!: () => void;
  readonly completed = new Promise<void>(resolve => { this.#resolveReady = resolve; });
  entry(summary: WorkpieceSummary): void { this.rows.set(summary.id, summary); }
  removed(id: number): void { this.rows.delete(id); }
  ready(): void { this.#resolveReady(); }
}
async function listGadgets(workspace: Awaited<ReturnType<AuthenticatedApi["openGadget"]>>) {
  const receiver = new Workpieces();
  using callback = new RpcStub<WorkpiecesSubscriber>(receiver);
  using subscription = await workspace.subscribeToWorkpieces(callback);
  await receiver.completed;
  return [...receiver.rows.values()].filter(row => row.type === "gadget").map(row => ({id:row.id,title:row.title,...(row.commitId?{commitId:row.commitId}:{})}));
}
/** Every operation uses the native authenticated API; the adapter owns no authority or grants. */
export class NativeMcpTools implements McpToolRuntime {
  constructor(private readonly api: AuthenticatedApi) {}
  async listAvailableTools(): Promise<readonly LegionToolName[]> { return Object.keys(TOOL_DEFINITIONS) as LegionToolName[]; }
  async invoke<N extends LegionToolName>(name: N, input: LegionToolInputs[N]): Promise<LegionToolOutputs[N]> {
    using workspace = await this.api.openGadget(input.workspaceId);
    let result: unknown;
    let dispatched = false;
    try {
      switch (name) {
        case "legion_workspace_get": {
          const meta = await workspace.getMetadata();
          result = {id:meta.id,title:meta.title,role:meta.owner?meta.role??"build":"owner"}; disposeCapabilityResult(meta); break;
        }
        case "legion_gadget_list": result = {gadgets:await listGadgets(workspace)}; break;
        case "legion_access_list": {
          const collaborators = await workspace.listCollaborators();
          const links = await workspace.listShareLinks();
          result = {collaborators:collaborators.map(row=>({profileId:row.profile.id,displayName:row.profile.name,role:row.role??"build"})),shareLinks:links.map(row=>({linkId:row.linkId,role:row.role??"build",createdAt:row.created.toISOString()}))}; disposeCapabilityResult(collaborators); disposeCapabilityResult(links); break;
        }
        case "legion_gadget_request": {
          const args = input as LegionToolInputs["legion_gadget_request"];
          using gadget = await workspace.getGadget(args.gadgetId, args.key);
          dispatched = true;
          result = {result: takeCapabilityJson(await gadget.dispatchRequest(args.request, args.chatId))};
          break;
        }
        case "legion_code_submit": {
          const args = input as LegionToolInputs["legion_code_submit"]; dispatched=true;
          result=await workspace.submitCodeChange(args.chatId,args.submission);break;
        }
        case "legion_code_snapshot": {
          const args=input as LegionToolInputs["legion_code_snapshot"];
          result=await workspace.readChatCodeSnapshot(args.chatId,args.gadgetId,args.paths);break;
        }
        case "legion_code_tree":
        case "legion_code_read": {
          const args=input as LegionToolInputs["legion_code_read"];
          const row=(await listGadgets(workspace)).find(row=>row.id===args.gadgetId);
          if (!row?.commitId) throw new McpPublicError("access_denied", "This gadget has no committed revision.");
          const history = await workspace.getCommitLog(row.commitId);
          try {
            if (!history.some(commit => commit.oid === args.commitId)) throw new McpPublicError("access_denied", "Commit is outside this gadget's history.");
          } finally { disposeCapabilityResult(history); }
          if(name==="legion_code_tree")result={entries:await workspace.listTree(args.commitId)};
          else {const files=await workspace.readFilesAtCommit(args.commitId,args.paths);result={files,unansweredPaths:args.paths.filter(path=>!files.some(([answer])=>answer===path))};}break;
        }
        default: {
          const args=input as LegionToolInputs["legion_data_query"];
          using gadget=await workspace.getGadget(args.gadgetId);
          if(name==="legion_data_ports"){
            const ports=takeCapabilityExports(await gadget.getCapabilityExports());
            result={ports:Object.entries(ports).map(([port,spec])=>({port,...spec}))};
          }else if(name==="legion_data_query")result={result:takeCapabilityJson(await gadget.queryCapability(args.spec,args.request))};
          else if(name==="legion_data_command"){dispatched=true;result={result:takeCapabilityJson(await gadget.executeCapability(args.spec,args.request))};}
          else throw new McpPublicError("invalid_request","Unknown tool.");
        }
      }
      // Producer values were bounded before wrapping. Detach native typed metadata without
      // applying a producer payload limit to the larger MCP envelope.
      try {
        const detached: unknown = JSON.parse(JSON.stringify(result));
        assertJson(detached);
        return detached as LegionToolOutputs[N];
      } finally { disposeCapabilityResult(result); }
    }catch(error){
      if(error instanceof McpPublicError || error instanceof LimitError)throw error;
      if(dispatched)throw new McpPublicError("outcome_unknown","The native operation may have taken effect. Recover its outcome before retrying; code retries must use the identical submission.");
      throw new McpPublicError("access_denied","The native Workshop API did not authorize or complete this operation.");
    }
  }
}
