import { expect, it } from "vitest";
import { env, RpcTarget, RpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { GADGET_CAPABILITY_BRIDGE_TOKEN } from "@gadgets/workshop-shared/gadget-capabilities";
import type { OverseerDurableObject } from "../src/overseer";
import { openFakeOverseer } from "./fixtures";
const projection = { port: "facts", kind: "projection", protocol: "facts/1" } as const;
const command = { port: "recordFact", kind: "command", protocol: "facts-command/1" } as const;
let workspace = 0;
async function rejected(call: () => Promise<unknown>, message?: string) {
  const result = await call().then(
    () => ({ ok: true, message: "" }),
    (error) => ({ ok: false, message: String(error) }),
  );
  expect(result.ok).toBe(false);
  if (message) expect(result.message).toContain(message);
}
const producer = `import{DurableObject,RpcTarget,WorkerEntrypoint}from'cloudflare:workers';
export class Gadget extends DurableObject{
 constructor(ctx,env){super(ctx,env);this.ctx=ctx;this.listeners=new Set();ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS facts(id TEXT PRIMARY KEY,value TEXT,grantor TEXT,consumer INTEGER)');}
 snapshot(request){if(request.pause)return new Promise(resolve=>{this.resumeRead=()=>resolve(this.snapshot({}));});if(request.leak)return new Hidden();return{revision:String(this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM facts').one().n),facts:[...this.ctx.storage.sql.exec('SELECT * FROM facts ORDER BY id')]};}
 async record(request,context,token){if(!this.env.GADGET_CAPABILITY_BRIDGE_TOKEN||token!==this.env.GADGET_CAPABILITY_BRIDGE_TOKEN)throw Error('Bridge required');const old=this.ctx.storage.sql.exec('SELECT value FROM facts WHERE id=?',request.id).toArray()[0];if(old){if(old.value!==request.value)throw Error('Fact identity conflict');return this.snapshot({});}this.ctx.storage.sql.exec('INSERT INTO facts VALUES(?,?,?,?)',request.id,request.value,context.grantedBy,context.consumerGadgetId);const value=this.snapshot({});await Promise.all([...this.listeners].map(observer=>observer.changed(value.revision).catch(()=>{this.listeners.delete(observer);observer[Symbol.dispose]();})));return value;}
 resume(){this.resumeRead?.();this.resumeRead=undefined;}
 pending(){return!!this.resumeRead;}
 watchCount(){return this.listeners.size;}
 watch(observer){observer=observer.dup();this.listeners.add(observer);return new Lease(()=>{this.listeners.delete(observer);observer[Symbol.dispose]();});}}
class Hidden extends RpcTarget{secret(){return'should not escape';}}
class Lease extends RpcTarget{constructor(cancel){super();this.cancel=cancel;}[Symbol.dispose](){this.cancel();}}
export class CapabilityHandler extends WorkerEntrypoint{
 describe(){return{facts:{kind:'projection',protocol:'facts/1'},recordFact:{kind:'command',protocol:'facts-command/1'}};}
 project(gadget,port,request){if(port!=='facts')throw Error('Unknown read');return gadget.snapshot(request);}
 command(gadget,port,request,context){if(port!=='recordFact')throw Error('Unknown command');return gadget.record(request,context,this.env.GADGET_CAPABILITY_BRIDGE_TOKEN);}
 watch(gadget,port,request,observer){if(port!=='facts')throw Error('Unknown watch');return gadget.watch(observer);}}
`;
const consumer = `import{DurableObject,WorkerEntrypoint}from'cloudflare:workers';export class Gadget extends DurableObject{
 project(request){return this.env.READ.project(request);}
 execute(request){return this.env.WRITE.execute(request);}
 subscribe(observer){return this.env.READ.subscribe({},observer);}
 identities(){return Promise.all([this.env.READ.identity(),this.env.WRITE.identity()]);}
 illegalWrite(request){return this.env.READ.execute(request);}
 illegalRead(){return this.env.WRITE.project({});}}
export class CapabilityHandler extends WorkerEntrypoint{
 describe(){return{facts:{kind:'projection',protocol:'facts/1'}};}
 project(gadget,port,request){return gadget.project(request);}
 watch(gadget,port,request,observer){return gadget.subscribe(observer);}}
`;
async function withWorkspace(run: (impl: any, owner: any, viewer: any) => Promise<void>) {
  await runInDurableObject(
    env.TEST_OVERSEER.getByName(`capability-${++workspace}`),
    async (instance: OverseerDurableObject) => {
      const impl = (instance as unknown as { impl: any }).impl;
      impl.ownerId = "owner-id";
      for (const [id, title, code] of [
        [1, "Facts", producer],
        [2, "Consumer", consumer],
        [3, "Other producer", producer],
      ] as const) {
        const commitId = await impl.gitStore.writeFilesAsCommit(new Map([["server.js", code]]), {
          parents: [],
          author: { name: "Owner", email: "owner@example.com" },
          message: "Capability fixture",
          timestamp: new Date(0),
        });
        impl.storage.gadgets.put({
          type: "gadget",
          id,
          title,
          created: new Date(0),
          bindingName: `GADGET_${id}`,
          bindings: {},
          commitId,
        });
      }
      const delegate = {
        logger: impl.logger,
        ownerId: "owner-id",
        storage: impl.storage,
        users: {
          idFromString: (id: string) => id,
          get: () => ({
            id: { toString: () => "viewer-id" },
            whoami: async () => ({ type: "user", id: "viewer", name: "Viewer" }),
            recordSharedGadgetOpen: async () => {},
          }),
        },
        getGadgetRecord: (id: number) => impl.getGadgetRecord(id),
        getGadgetFacet: (id: number, chatId?: number, kind?: string) =>
          impl.getGadgetFacet(id, chatId, kind),
        assertGadgetUseWithoutCommands: (id: number) => impl.assertGadgetUseWithoutCommands(id),
        getCapabilityExports: (id: number) => impl.getCapabilityExports(id),
        executeGadgetCapability: (...args: any[]) => impl.executeGadgetCapability(...args),
        bindGadgetCapability: (...args: any[]) => impl.bindGadgetCapability(...args),
        revokeGadgetConnections: (id: number) => impl.revokeGadgetConnections(id),
        bumpVersion: (ids: number[]) => impl.bumpVersion(ids),
      };
      const owner = await openFakeOverseer(
        { gadgets: impl.storage.gadgets },
        { role: "build", impl: delegate },
      );
      const viewer = await openFakeOverseer(
        { gadgets: impl.storage.gadgets },
        { role: "use", impl: delegate },
      );
      await run(impl, owner, viewer);
    },
  );
}
it("grants only named matching ports and cannot bind a raw, locked, remote or cyclic gadget", () =>
  withWorkspace(async (impl, owner, viewer) => {
    const source = await owner.getGadget(1),
      target = await owner.getGadget(2);
    expect(await source.getCapabilityExports()).toEqual({
      facts: { kind: "projection", protocol: "facts/1" },
      recordFact: { kind: "command", protocol: "facts-command/1" },
    });
    await expect((await viewer.getGadget(2)).bindCapability("READ", 1, projection)).rejects.toThrow(
      "Unauthorized",
    );
    expect(() => impl.bindWorkpiece(2, "RAW", 1)).toThrow("Gadget-to-gadget");
    await expect(
      target.bindCapability("WRONG", 1, { ...projection, kind: "command" }),
    ).rejects.toThrow("does not match");
    await expect(target.bindCapability("REMOTE", 999999, projection)).rejects.toThrow();
    await target.bindCapability("READ", 1, projection);
    await target.bindCapability("WRITE", 1, command);
    expect(impl.collectBindingMetadata(2).READ).toMatchObject({
      type: "gadgetCapability",
      optional: true,
      capability: projection,
    });
    await expect(impl.bindGadgetCapability(1, "CYCLE", 2, projection, "owner-id")).rejects.toThrow(
      "cycle",
    );
    const record = impl.storage.gadgets.get(1);
    record.accessKeyHash = "locked";
    record.accessRevision = 1;
    impl.storage.gadgets.put(record);
    await expect(
      (await owner.getGadget(3)).bindCapability("LOCKED", 1, projection),
    ).rejects.toThrow("Key-locked");
  }));
it("attenuates methods, enforces JSON and derives command attribution from the grant", () =>
  withWorkspace(async (impl, owner) => {
    const target = await owner.getGadget(2);
    await target.bindCapability("READ", 1, projection);
    await target.bindCapability("WRITE", 1, command);
    const gadget = await impl.getGadgetFacetFetcher(2);
    expect(await gadget.project({})).toEqual({ revision: "0", facts: [] });
    await rejected(() => gadget.illegalWrite({ id: "bad", value: "bad" }));
    await rejected(() => gadget.illegalRead());
    await rejected(() => gadget.project({ leak: true }), "JSON");
    const first = await gadget.execute({
      id: "stable-fact",
      value: "100000001",
      grantedBy: "forged",
    });
    expect(first.facts).toEqual([
      { id: "stable-fact", value: "100000001", grantor: "owner-id", consumer: 2 },
    ]);
    expect(await gadget.execute({ id: "stable-fact", value: "100000001" })).toEqual(first);
    await rejected(() => gadget.execute({ id: "stable-fact", value: "different" }), "conflict");
  }));
it("disconnect revokes retained facets and notifications; reconnect reads missed facts once", () =>
  withWorkspace(async (impl, owner) => {
    const target = await owner.getGadget(2);
    await target.bindCapability("READ", 1, projection);
    await target.bindCapability("WRITE", 1, command);
    const generation = impl.storage.gadgets.get(2).bindings.READ.capability.generation;
    const retained = impl.openGadgetCapability(2, "READ", generation);
    const events: string[] = [],
      closed: string[] = [];
    class Observer extends RpcTarget {
      async changed(revision: string) {
        events.push(revision);
      }
      async unavailable(reason: string) {
        closed.push(reason);
      }
    }
    using observer = new RpcStub(new Observer());
    using _subscription = await retained.subscribe({}, observer);
    const source = await impl.getGadgetFacetFetcher(1);
    expect(await source.watchCount()).toBe(1);
    await impl.executeGadgetCapability(1, command, { id: "one", value: "1" }, "owner-id");
    await observer.changed("barrier");
    expect(events).toContain("1");
    impl.unbindWorkpiece(2, "READ");
    await expect(retained.project({})).rejects.toThrow("revoked");
    await expect.poll(() => source.watchCount()).toBe(0);
    await expect.poll(() => closed.length).toBe(1);
    await impl.executeGadgetCapability(1, command, { id: "two", value: "2" }, "owner-id");
    await observer.changed("barrier");
    expect(events).not.toContain("2");
    await target.bindCapability("READ", 1, projection);
    expect(impl.storage.gadgets.get(2).bindings.READ.capability.generation).not.toBe(generation);
    await expect(retained.project({})).rejects.toThrow("revoked");
    const fresh = impl.openGadgetCapability(
      2,
      "READ",
      impl.storage.gadgets.get(2).bindings.READ.capability.generation,
    );
    const snapshot = await fresh.project({ afterRevision: "1" });
    expect(snapshot.revision).toBe("2");
    expect(snapshot.facts.map((fact: any) => fact.id)).toEqual(["one", "two"]);
    const producerRecord = impl.storage.gadgets.get(1);
    producerRecord.accessRevision = 1;
    impl.storage.gadgets.put(producerRecord);
    impl.revokeGadgetConnections(1);
    await expect(fresh.project({})).rejects.toThrow("revoked");
  }));
it("identity distinguishes producers even when their domain IDs and protocol labels could match", () =>
  withWorkspace(async (impl, owner) => {
    const target = await owner.getGadget(2);
    await target.bindCapability("READ", 1, projection);
    await target.bindCapability("WRITE", 3, command);
    const consumer = await impl.getGadgetFacetFetcher(2),
      [read, write] = await consumer.identities();
    expect(read).toMatchObject({
      producerGadgetId: 1,
      kind: "projection",
      port: "facts",
      protocol: "facts/1",
    });
    expect(write).toMatchObject({
      producerGadgetId: 3,
      kind: "command",
      port: "recordFact",
      protocol: "facts-command/1",
    });
    expect(read.workspaceId).toBe(write.workspaceId);
    expect(read.generation).not.toBe(write.generation);
    impl.revokeGadgetConnectionSessions();
    await rejected(() => consumer.project({}), "session has been revoked");
    impl.bumpVersion([2]);
    const fresh = await impl.getGadgetFacetFetcher(2);
    expect(await fresh.project({})).toEqual({ revision: "0", facts: [] });
  }));

it("does not let a UI-only consumer root exercise a stored command grant", () =>
  withWorkspace(async (impl, owner, viewer) => {
    const target = await owner.getGadget(2);
    await target.bindCapability("READ", 1, projection);
    using readOnly = await (await viewer.getGadget(2)).connectToGadget();
    expect(await readOnly.project({})).toEqual({ revision: "0", facts: [] });
    await target.bindCapability("WRITE", 1, command);
    await expect((await viewer.getGadget(2)).connectToGadget()).rejects.toThrow(
      "require build access",
    );
    await expect((await viewer.getGadget(2)).getExportFormats()).rejects.toThrow(
      "require build access",
    );
    await expect((await viewer.getGadget(2)).export("csv")).rejects.toThrow("require build access");
    await rejected(() => readOnly.execute({ id: "viewer", value: "forbidden" }));
    using writer = await target.connectToGadget();
    expect((await writer.execute({ id: "owner", value: "allowed" })).facts).toHaveLength(1);
    const source = await impl.getGadgetFacetFetcher(1);
    expect((await source.snapshot({})).facts.map((row: any) => row.id)).toEqual(["owner"]);
    // Projection access to a command-connected gadget must not launder its root authority.
    await (await owner.getGadget(3)).bindCapability("READ", 2, projection);
    await expect((await viewer.getGadget(3)).connectToGadget()).rejects.toThrow(
      "require build access",
    );
  }));

it("keeps producer resource verification in the existing use permission traversal", () =>
  withWorkspace(async (impl, owner) => {
    for (const id of [100, 101])
      impl.storage.gatekeepers.put({
        id,
        resourceTitle: `Connection ${id}`,
        class: {},
        creationSpec: {
          type: "gatekeeper",
          vendorId: "testvendor",
          resourceUrl: `https://example.com/${id}`,
          typeUrlPattern: "https://*",
        },
      });
    impl.bindWorkpiece(1, "SOURCE", 100);
    await (await owner.getGadget(2)).bindCapability("READ", 1, projection);
    expect(impl.listObserverRequirements("use").map((need: any) => need.gatekeeperId)).toEqual([
      100,
    ]);
    expect(impl.listObserverRequirements("build").map((need: any) => need.gatekeeperId)).toEqual([
      100, 101,
    ]);
  }));

it("does not deliver a projection that completes after its connection was revoked", () =>
  withWorkspace(async (impl, owner) => {
    const target = await owner.getGadget(2);
    await target.bindCapability("READ", 1, projection);
    const generation = impl.storage.gadgets.get(2).bindings.READ.capability.generation;
    const retained = impl.openGadgetCapability(2, "READ", generation),
      source = await impl.getGadgetFacetFetcher(1);
    const result = retained.project({ pause: true }).then(
      () => ({ ok: true, message: "" }),
      (error: unknown) => ({ ok: false, message: String(error) }),
    );
    await expect.poll(() => source.pending()).toBe(true);
    impl.unbindWorkpiece(2, "READ");
    await source.resume();
    expect(await result).toMatchObject({ ok: false, message: expect.stringContaining("revoked") });
  }));
it("rechecks source admission after asynchronous declaration lookup", () =>
  withWorkspace(async (impl, owner) => {
    const target = await owner.getGadget(2);
    let finish!: (value: unknown) => void;
    impl.getCapabilityExports = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const granting = target.bindCapability("READ", 1, projection).then(
      () => ({ ok: true, message: "" }),
      (error: unknown) => ({ ok: false, message: String(error) }),
    );
    const source = impl.storage.gadgets.get(1);
    source.accessKeyHash = "locked";
    source.accessRevision = 1;
    impl.storage.gadgets.put(source);
    finish({ facts: { kind: "projection", protocol: "facts/1" } });
    expect(await granting).toMatchObject({
      ok: false,
      message: expect.stringContaining("changed while granting"),
    });
    expect(impl.storage.gadgets.get(2).bindings.READ).toBeUndefined();
  }));

it("seals each producer bridge and provides build-only standalone commands without a self-edge", () =>
  withWorkspace(async (impl, owner, viewer) => {
    const source = await owner.getGadget(1);
    await expect(
      (await viewer.getGadget(1)).executeCapability(command, { id: "denied", value: "bad" }),
    ).rejects.toThrow("Unauthorized");
    await expect(
      source.executeCapability({ ...command, protocol: "wrong" }, { id: "denied", value: "bad" }),
    ).rejects.toThrow("does not match");
    const producerEnv = impl.getEnvForLoader(1, { from: "gadget", gadgetId: 1 });
    const otherEnv = impl.getEnvForLoader(3, { from: "gadget", gadgetId: 3 });
    const secret = producerEnv[GADGET_CAPABILITY_BRIDGE_TOKEN];
    expect(typeof secret).toBe("string");
    expect(secret).toHaveLength(64);
    expect(otherEnv[GADGET_CAPABILITY_BRIDGE_TOKEN]).not.toBe(secret);
    const raw = await impl.getGadgetFacetFetcher(1);
    await rejected(
      () =>
        raw.record({ id: "spoof", value: "bad" }, { grantedBy: "victim", consumerGadgetId: 99 }),
      "Bridge required",
    );
    await rejected(
      () =>
        raw.record(
          { id: "spoof", value: "bad" },
          { grantedBy: "victim", consumerGadgetId: 99 },
          otherEnv[GADGET_CAPABILITY_BRIDGE_TOKEN],
        ),
      "Bridge required",
    );
    const result = await source.executeCapability(command, {
      id: "self",
      value: "ok",
      actor: "victim",
    });
    expect(result.facts).toEqual([{ id: "self", value: "ok", grantor: "owner-id", consumer: 1 }]);
    expect(impl.storage.gadgets.get(1).bindings).toEqual({});
    expect(JSON.stringify(impl.collectBindingMetadata(1))).not.toContain(secret);
    expect(() => impl.bindWorkpiece(1, GADGET_CAPABILITY_BRIDGE_TOKEN, 100)).toThrow("reserved");
    impl.revokeGadgetConnectionSessions();
    impl.bumpVersion([1]);
    expect(
      impl.getEnvForLoader(1, { from: "gadget", gadgetId: 1 })[GADGET_CAPABILITY_BRIDGE_TOKEN],
    ).toBe(secret);
    expect(
      (await source.executeCapability(command, { id: "after", value: "restart" })).facts,
    ).toHaveLength(2);
    await expect(
      impl.executeGadgetCommand(1, command, { id: "anonymous", value: "bad" }, 999),
    ).rejects.toThrow("authenticated");
    let currentRole: "build" | "use" | null = "build";
    impl.users = {
      idFromString: (id: string) => id,
      get: () => ({ whoami: async () => ({ id: "agent-profile" }) }),
    };
    impl.authorizeCollaborator = async () => currentRole;
    impl.getSharingManager = async () => ({ getEffectiveRole: () => currentRole });
    impl.storage.chatMeta.put({id: 123, title: "Command", started: new Date(0), lastActive: new Date(0)});
    impl.storage.activeAgents.put({ chatId: 123, initiatorUserId: "authenticated-agent-user" });
    const agentResult = await impl.executeGadgetCommand(
      1,
      command,
      { id: "agent", value: "trusted", grantedBy: "victim" },
      123,
    );
    expect(agentResult.facts.find((fact: any) => fact.id === "agent")).toMatchObject({
      grantor: "authenticated-agent-user",
      consumer: 1,
    });
    currentRole = "use";
    await expect(
      impl.executeGadgetCommand(1, command, { id: "use-only", value: "bad" }, 123),
    ).rejects.toThrow("current build access");
    currentRole = null;
    await expect(
      impl.executeGadgetCommand(1, command, { id: "removed", value: "bad" }, 123),
    ).rejects.toThrow("current build access");
    currentRole = "build";
    impl.authorizeCollaborator = async () => {
      currentRole = "use";
      return "build";
    };
    await expect(
      impl.executeGadgetCommand(1, command, { id: "downgraded-during-check", value: "bad" }, 123),
    ).rejects.toThrow("current build access");
  }));
