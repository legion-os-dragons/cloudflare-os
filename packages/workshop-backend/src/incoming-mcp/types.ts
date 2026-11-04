import type { CodeChangeSubmission, Overseer, TreeNode, FileAtCommit } from "@gadgets/workshop-shared/api";
import type { GadgetCapabilityJson, GadgetCapabilitySpec } from "@gadgets/workshop-shared/gadget-capabilities";
/** Incoming tool arguments name existing native resources; IDs convey no authority. */
export interface LegionToolInputs {
  legion_workspace_get: {workspaceId:string};
  legion_gadget_list: {workspaceId:string};
  legion_gadget_request: {workspaceId:string;gadgetId:number;key?:string;chatId?:number;request:GadgetCapabilityJson};
  legion_data_ports: {workspaceId:string;gadgetId:number};
  legion_data_query: {workspaceId:string;gadgetId:number;spec:GadgetCapabilitySpec & {kind:"projection"};request:GadgetCapabilityJson};
  legion_data_command: {workspaceId:string;gadgetId:number;spec:GadgetCapabilitySpec & {kind:"command"};request:GadgetCapabilityJson};
  legion_access_list: {workspaceId:string};
  legion_code_tree: {workspaceId:string;gadgetId:number;commitId:string};
  legion_code_read: {workspaceId:string;gadgetId:number;commitId:string;paths:string[]};
  legion_code_snapshot: {workspaceId:string;chatId:number;gadgetId:number;paths:string[]};
  legion_code_submit: {workspaceId:string;chatId:number;submission:CodeChangeSubmission};
}
/** Native data represented as bounded MCP JSON; no RPC capabilities cross the wire. */
export interface LegionToolOutputs {
  legion_workspace_get: {id:string;title:string;role:"owner"|"build"|"use"};
  legion_gadget_list: {gadgets:{id:number;title:string;commitId?:string}[]};
  legion_gadget_request: {result:GadgetCapabilityJson};
  legion_data_ports: {ports:({port:string}&GadgetCapabilitySpec)[]};
  legion_data_query: {result:GadgetCapabilityJson};
  legion_data_command: {result:GadgetCapabilityJson};
  legion_access_list: {collaborators:{profileId:string;displayName:string;role:string}[];shareLinks:{linkId:string;role:string;createdAt:string}[]};
  legion_code_tree: {entries:TreeNode[]};
  legion_code_read: {files:[string,FileAtCommit][];unansweredPaths:string[]};
  legion_code_snapshot: Awaited<ReturnType<Overseer["readChatCodeSnapshot"]>>;
  legion_code_submit: Awaited<ReturnType<Overseer["submitCodeChange"]>>;
}
/** Fixed native tool registry names. */
export type LegionToolName=keyof LegionToolInputs;
/** The native finite JSON contract. */
export type LegionJson=GadgetCapabilityJson;
