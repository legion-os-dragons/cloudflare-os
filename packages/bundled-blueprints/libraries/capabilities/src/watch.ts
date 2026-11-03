import { createSubscriber, type SyncHost } from "../../sync/client";
import type {
  GadgetCapabilityJson,
  GadgetProjectionFacet,
} from "@gadgets/workshop-shared/gadget-capabilities";

/** Producer-specific snapshot with an opaque revision, validated by the consumer's decoder. */
export interface ProjectionSnapshot {
  revision: string;
}
/** Domain validation and rendering remain with the consuming gadget. */
export interface ProjectionWatchOptions<T extends ProjectionSnapshot> {
  /** RPC target constructor supplied by the gadget bootstrap, as for the sync library. */
  RpcTarget: SyncHost["RpcTarget"];
  /** Domain-owned projection request, including any effective/knowledge cutoffs. */
  request: GadgetCapabilityJson;
  /** Validate the producer's data before accepting a snapshot. */
  decode(value: GadgetCapabilityJson): T;
  /** Receive complete snapshots once per observed revision. */
  snapshot(value: T): void;
  /** Stop presenting live data after an active read, subscription or revocation fails. */
  unavailable(error: unknown): void;
}
/** A reconnectable projection subscription. It owns its leases, not the supplied source stubs. */
export interface ProjectionWatch extends Disposable {
  /** Subscribe before reading a complete snapshot so missed notifications cannot lose updates. */
  reconnect(source: Pick<GadgetProjectionFacet, "project" | "subscribe">): Promise<void>;
}

/** Reuse the sync library's subscriber construction; reconnect always starts from a complete snapshot. */
export function watchProjection<T extends ProjectionSnapshot>(
  options: ProjectionWatchOptions<T>,
): ProjectionWatch {
  let epoch = 0,
    revision: string | undefined,
    lease: Awaited<ReturnType<GadgetProjectionFacet["subscribe"]>> | undefined;
  return {
    async reconnect(source) {
      const current = ++epoch;
      revision = undefined;
      lease?.[Symbol.dispose]();
      lease = undefined;
      const fail = (error: unknown) => {
        if (epoch !== current) return;
        epoch++;
        try {
          lease?.[Symbol.dispose]();
        } finally {
          lease = undefined;
          options.unavailable(error);
        }
      };
      let queue = Promise.resolve();
      const refresh = () => {
        const read = async () => {
          if (epoch !== current) return;
          let snapshot: T;
          try {
            const response = await source.project(options.request);
            try {
              snapshot = options.decode(response);
            } finally {
              if (response !== null && typeof response === "object" && Symbol.dispose in response) {
                const dispose = response[Symbol.dispose];
                if (typeof dispose === "function") dispose.call(response);
              }
            }
          } catch (error) {
            fail(error);
            throw error;
          }
          if (epoch === current && snapshot.revision !== revision) {
            revision = snapshot.revision;
            options.snapshot(snapshot);
          }
        };
        queue = queue.then(read, read);
        return queue;
      };
      const observer = createSubscriber(options.RpcTarget, {
        changed: async (next: string) => {
          if (epoch === current && next !== revision) await refresh();
        },
        unavailable: async (reason: string) => {
          fail(new Error(reason));
        },
      });
      let subscribed: Awaited<ReturnType<GadgetProjectionFacet["subscribe"]>>;
      try {
        subscribed = await source.subscribe(options.request, observer);
      } catch (error) {
        fail(error);
        throw error;
      }
      if (epoch !== current) {
        subscribed[Symbol.dispose]();
        return;
      }
      lease = subscribed;
      await refresh();
    },
    [Symbol.dispose]() {
      epoch++;
      lease?.[Symbol.dispose]();
      lease = undefined;
    },
  };
}
