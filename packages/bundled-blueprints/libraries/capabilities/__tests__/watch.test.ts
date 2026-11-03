// @vitest-environment node
import { expect, it } from "vitest";
import { watchProjection } from "../client";
class RpcTarget {}
function source() {
  let revision = "1",
    facts = ["one"],
    failure: Error | undefined;
  const observers = new Set<any>();
  let reads = 0,
    disposedResults = 0;
  return {
    get active() {
      return observers.size;
    },
    get reads() {
      return reads;
    },
    get disposedResults() {
      return disposedResults;
    },
    fail() {
      failure = Error("Projection revoked.");
    },
    set(next: string, values: string[]) {
      revision = next;
      facts = values;
    },
    async notify() {
      for (const observer of observers) await observer.changed(revision).catch(() => {});
    },
    async revoke() {
      for (const observer of observers) await observer.unavailable("Connection revoked.");
    },
    binding: {
      async project() {
        reads++;
        if (failure) throw failure;
        return {
          revision,
          facts: [...facts],
          [Symbol.dispose]() {
            disposedResults++;
          },
        };
      },
      async subscribe(_request: unknown, observer: any) {
        observers.add(observer);
        return {
          [Symbol.dispose]() {
            observers.delete(observer);
          },
        };
      },
    },
  };
}
function watch() {
  const snapshots: any[] = [],
    errors: unknown[] = [];
  const instance = watchProjection({
    RpcTarget,
    request: {},
    decode: (value: any) => value,
    snapshot: (value) => snapshots.push(value),
    unavailable: (error) => errors.push(error),
  });
  return { instance, snapshots, errors };
}
it("subscribes before full snapshot, coalesces repeated revisions, and disposes every response", async () => {
  const server = source(),
    consumer = watch();
  const binding: any = {
    ...server.binding,
    async subscribe(request: unknown, observer: any) {
      const lease = await server.binding.subscribe(request, observer);
      server.set("2", ["one", "two"]);
      return lease;
    },
  };
  await consumer.instance.reconnect(binding);
  expect(consumer.snapshots.map((s) => s.revision)).toEqual(["2"]);
  expect(server.active).toBe(1);
  await server.notify();
  await server.notify();
  expect(server.reads).toBe(1);
  server.set("3", ["one", "two", "three"]);
  await server.notify();
  expect(consumer.snapshots.at(-1).facts).toEqual(["one", "two", "three"]);
  expect(server.disposedResults).toBe(server.reads);
  consumer.instance[Symbol.dispose]();
  expect(server.active).toBe(0);
});
it("reconnect replaces the lease and recovers missed facts from a complete snapshot once", async () => {
  const first = source(),
    next = source(),
    consumer = watch();
  await consumer.instance.reconnect(first.binding as any);
  next.set("4", ["one", "two", "three", "four"]);
  await consumer.instance.reconnect(next.binding as any);
  expect(first.active).toBe(0);
  expect(next.active).toBe(1);
  await first.notify();
  await next.notify();
  expect(consumer.snapshots.map((s) => s.revision)).toEqual(["1", "4"]);
  consumer.instance[Symbol.dispose]();
  expect(next.active).toBe(0);
});
it("a later read failure marks data unavailable, removes the lease, and requires explicit fresh-source reconnect", async () => {
  const server = source(),
    consumer = watch();
  await consumer.instance.reconnect(server.binding as any);
  server.fail();
  server.set("2", ["one", "two"]);
  await server.notify();
  expect(consumer.errors).toHaveLength(1);
  expect(server.active).toBe(0);
  expect(consumer.snapshots).toHaveLength(1);
  await server.notify();
  expect(consumer.errors).toHaveLength(1);
  const fresh = source();
  fresh.set("3", ["one", "two", "three"]);
  await consumer.instance.reconnect(fresh.binding as any);
  expect(consumer.snapshots.at(-1).facts).toEqual(["one", "two", "three"]);
  consumer.instance[Symbol.dispose]();
  expect(fresh.active).toBe(0);
});
it("kernel revocation clears liveness without needing a subsequent data revision", async () => {
  const server = source(),
    consumer = watch();
  await consumer.instance.reconnect(server.binding as any);
  await server.revoke();
  expect(consumer.errors).toHaveLength(1);
  expect(server.active).toBe(0);
  server.set("2", ["private new fact"]);
  await server.notify();
  expect(consumer.snapshots).toHaveLength(1);
});
it("an initial subscribe failure is reported once and leaves no active watch", async () => {
  const consumer = watch();
  await expect(
    consumer.instance.reconnect({
      project: async () => ({ revision: "1" }),
      subscribe: async () => {
        throw Error("No grant.");
      },
    } as any),
  ).rejects.toThrow("No grant");
  expect(consumer.errors).toHaveLength(1);
  expect(consumer.snapshots).toEqual([]);
});
