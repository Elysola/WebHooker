import { describe, it, expect, beforeEach } from "bun:test";
import { handleQueueBatch } from "../server/lib/queue/consumer";
import { invalidateConfigCache } from "../server/lib/config";
import { invalidateGroupsCache } from "../server/lib/web/groups";
import type { Env } from "../server/lib/types";
import type { DeliveryMessage, DispatchSummary } from "../server/lib/queue/delivery";
import { createMemoryKV, createSqliteD1 } from "./d1-sqlite";
import type { DispatchOptions } from "../server/lib/core/dispatch";

let summary: DispatchSummary;
let dispatchCalls: number;
let lastArgs: unknown[];

async function fakeDispatch(...args: unknown[]): Promise<DispatchSummary> {
  dispatchCalls += 1;
  lastArgs = args;
  return summary;
}

function createMockKV(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string) => (store.has(key) ? store.get(key)! : null),
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace;
  return { kv, store };
}

function createEnv(kv: KVNamespace): Env {
  return {
    GITHUB_WEBHOOK_SECRET: "secret",
    KV: kv,
    DB: {} as D1Database,
  };
}

interface FakeMessage {
  body: DeliveryMessage;
  attempts: number;
  acked: boolean;
  retried: { delaySeconds?: number } | null;
  ack: () => void;
  retry: (opts?: { delaySeconds?: number }) => void;
}

function makeMessage(body: DeliveryMessage, attempts = 1): FakeMessage {
  return {
    body,
    attempts,
    acked: false,
    retried: null,
    ack(): void {
      this.acked = true;
    },
    retry(opts): void {
      this.retried = opts ?? {};
    },
  };
}

function makeBatch(queue: string, messages: FakeMessage[]): MessageBatch<DeliveryMessage> {
  return {
    queue,
    messages: messages as never,
    ackAll: () => {},
    retryAll: () => {},
  } as unknown as MessageBatch<DeliveryMessage>;
}

function body(overrides: Partial<DeliveryMessage> = {}): DeliveryMessage {
  return {
    deliveryId: "d1",
    provider: "github",
    event: "push",
    payload: { ref: "refs/heads/main" },
    receivedAt: Date.now(),
    ...overrides,
  };
}

const STATE_KEY = "delivery-state:github:@global:d1";

describe("handleQueueBatch", () => {
  beforeEach(() => {
    invalidateConfigCache();
    invalidateGroupsCache();
    summary = { attempts: 0, failures: [] };
    dispatchCalls = 0;
  });

  it("marks DLQ messages dead and acks them", async () => {
    const { kv, store } = createMockKV();
    const msg = makeMessage(body());
    await handleQueueBatch(makeBatch("webhooker-delivery-dlq", [msg]), createEnv(kv), fakeDispatch);
    expect(msg.acked).toBe(true);
    expect(JSON.parse(store.get(STATE_KEY)!)).toMatchObject({ status: "dead" });
  });

  it("acks and marks delivered on success", async () => {
    const { kv, store } = createMockKV();
    summary = { attempts: 1, failures: [] };
    const msg = makeMessage(body());
    await handleQueueBatch(makeBatch("webhooker-delivery", [msg]), createEnv(kv), fakeDispatch);
    expect(msg.acked).toBe(true);
    expect(msg.retried).toBeNull();
    expect(JSON.parse(store.get(STATE_KEY)!)).toMatchObject({ status: "delivered" });
  });

  it("retries with backoff on a retryable failure", async () => {
    const { kv, store } = createMockKV();
    summary = { attempts: 2, failures: [{ target: "c1", errorCode: "DISCORD_5XX" }] };
    const msg = makeMessage(body(), 1);
    await handleQueueBatch(makeBatch("webhooker-delivery", [msg]), createEnv(kv), fakeDispatch);
    expect(msg.acked).toBe(false);
    expect(msg.retried).toEqual({ delaySeconds: 5 });
    expect(JSON.parse(store.get(STATE_KEY)!)).toMatchObject({ status: "retrying" });
  });

  it("acks and marks failed on a permanent failure", async () => {
    const { kv, store } = createMockKV();
    summary = { attempts: 2, failures: [{ target: "c1", errorCode: "DISCORD_ERROR" }] };
    const msg = makeMessage(body());
    await handleQueueBatch(makeBatch("webhooker-delivery", [msg]), createEnv(kv), fakeDispatch);
    expect(msg.acked).toBe(true);
    expect(msg.retried).toBeNull();
    expect(JSON.parse(store.get(STATE_KEY)!)).toMatchObject({ status: "failed" });
  });

  it("skips already-delivered deliveries without re-dispatching", async () => {
    const { kv, store } = createMockKV();
    store.set(STATE_KEY, JSON.stringify({ status: "delivered", at: Date.now() }));
    const msg = makeMessage(body());
    await handleQueueBatch(makeBatch("webhooker-delivery", [msg]), createEnv(kv), fakeDispatch);
    expect(msg.acked).toBe(true);
    expect(dispatchCalls).toBe(0);
  });

  it("never records a lost parked payload as delivered, nor closes the delivery", async () => {
    const { kv, store } = createMockKV();
    const msg = makeMessage(
      body({
        payload: undefined,
        payloadRef: "queue:payload:gone",
        receivedAt: Date.now() - 3600_000,
      }),
    );
    await handleQueueBatch(makeBatch("webhooker-delivery", [msg]), createEnv(kv), fakeDispatch);
    expect(dispatchCalls).toBe(0);
    expect(msg.acked).toBe(true);
    // Left open: a redelivery carrying its own payload can still deliver it.
    expect(JSON.parse(store.get(STATE_KEY)!)).toMatchObject({ status: "retrying" });
    const redelivery = makeMessage(body());
    await handleQueueBatch(
      makeBatch("webhooker-delivery", [redelivery]),
      createEnv(kv),
      fakeDispatch,
    );
    expect(dispatchCalls).toBe(1);
  });

  it("retries only the transient targets of a partially failed delivery", async () => {
    const { kv, store } = createMockKV();
    const env = createEnv(kv);
    summary = {
      attempts: 3,
      succeeded: ["g:r:discord:ok"],
      failures: [
        { key: "g:r:discord:flaky", target: "flaky", errorCode: "DISCORD_5XX" },
        { key: "g:r:discord:bad", target: "bad", errorCode: "DISCORD_ERROR" },
      ],
    };
    const first = makeMessage(body(), 1);
    await handleQueueBatch(makeBatch("webhooker-delivery", [first]), env, fakeDispatch);
    expect(first.retried).toEqual({ delaySeconds: 5 });
    // Every attempt consults the ledger (another message may have sent some).
    expect(typeof (lastArgs[4] as { skipTarget?: unknown }).skipTarget).toBe("function");

    const second = makeMessage(body(), 2);
    summary = { attempts: 1, failures: [], succeeded: ["g:r:discord:flaky"] };
    await handleQueueBatch(makeBatch("webhooker-delivery", [second]), env, fakeDispatch);
    const skip = (lastArgs[4] as { skipTarget: (k: string) => Promise<boolean> }).skipTarget;
    expect(await skip("g:r:discord:ok")).toBe(true);
    expect(await skip("g:r:discord:bad")).toBe(true);
    // Recorded too, now that the retry delivered it.
    expect(await skip("g:r:discord:flaky")).toBe(true);
    expect(second.acked).toBe(true);
    // The 403 target never got the message: the delivery ends as failed.
    expect(JSON.parse(store.get(STATE_KEY)!)).toMatchObject({ status: "failed" });
  });

  it("follows a tenant group renamed while the delivery was queued", async () => {
    const { kv, store } = createMemoryKV();
    store.set("config:groups", JSON.stringify([{ id: "new-id", name: "G", adminIds: [] }]));
    store.set(
      "config:routes",
      JSON.stringify([
        { id: "r1", name: "R", enabled: true, filters: [], targets: [], groupId: "new-id" },
      ]),
    );
    store.set("group:renamed:old-id", "new-id");
    const msg = makeMessage(body({ groupId: "old-id" }));
    await handleQueueBatch(makeBatch("webhooker-delivery", [msg]), createEnv(kv), fakeDispatch);
    const config = lastArgs[0] as { routes: Array<{ id: string }> };
    expect(config.routes.map((r) => r.id)).toEqual(["r1"]);
    expect((lastArgs[4] as { tenantId?: string }).tenantId).toBe("new-id");
  });
});

describe("handleQueueBatch edge cases", () => {
  beforeEach(() => {
    summary = { attempts: 0, failures: [] };
    dispatchCalls = 0;
  });

  it("waits out a busy lease with a single long retry", async () => {
    const { kv, store } = createMockKV();
    store.set(STATE_KEY, JSON.stringify({ status: "processing", at: Date.now() }));
    // KV leases are best effort: emulate the D1 answer with a fake.
    const env = {
      ...createEnv(kv),
      DB: {
        prepare: (sql: string): unknown => {
          const stmt = {
            run: async (): Promise<unknown> => ({ meta: { changes: 0 } }),
            // Delivery state answers "processing"; the configuration is empty.
            first: async (): Promise<unknown> =>
              sql.includes("delivery_state") ? { status: "processing" } : null,
            all: async (): Promise<unknown> => ({ results: [] }),
          };
          return { ...stmt, bind: (): unknown => stmt };
        },
        batch: async (stmts: unknown[]) => stmts.map(() => ({ results: [], meta: { changes: 0 } })),
      } as unknown as D1Database,
    };
    const msg = makeMessage(body());
    await handleQueueBatch(makeBatch("webhooker-delivery", [msg]), env, fakeDispatch);
    expect(dispatchCalls).toBe(0);
    expect(msg.retried).toEqual({ delaySeconds: 310 });
  });

  it("does not reopen a delivered delivery when payload cleanup fails", async () => {
    const { kv, store } = createMockKV();
    const failingDelete = {
      ...kv,
      delete: async (): Promise<never> => Promise.reject(new Error("KV down")),
    };
    store.set("queue:payload:x", JSON.stringify({ a: 1 }));
    summary = { attempts: 1, failures: [] };
    const msg = makeMessage(
      body({ payload: undefined, payloadRef: "queue:payload:x", payloadRefType: "kv" }),
    );
    await handleQueueBatch(
      makeBatch("webhooker-delivery", [msg]),
      createEnv(failingDelete as unknown as KVNamespace),
      fakeDispatch,
    );
    expect(msg.acked).toBe(true);
    expect(msg.retried).toBeNull();
    expect(JSON.parse(store.get(STATE_KEY)!)).toMatchObject({ status: "delivered" });
  });

  it("marks a delivery for a deleted tenant group as failed", async () => {
    const { kv, store } = createMemoryKV();
    store.set("config:groups", JSON.stringify([]));
    const msg = makeMessage(body({ groupId: "gone" }));
    await handleQueueBatch(makeBatch("webhooker-delivery", [msg]), createEnv(kv), fakeDispatch);
    expect(dispatchCalls).toBe(0);
    expect(msg.acked).toBe(true);
    expect(JSON.parse(store.get("delivery-state:github:gone:d1")!)).toMatchObject({
      status: "failed",
    });
  });
});

describe("tenant resolution by group instance", () => {
  beforeEach(() => {
    summary = { attempts: 1, failures: [] };
    dispatchCalls = 0;
  });

  it("follows the instance across renames and ignores a re-created id", async () => {
    const { kv, store } = createMemoryKV();
    // Identities as the server assigned them (after the one-time migration).
    store.set("config:identity-migrated", "1");
    store.set(
      "config:groups",
      JSON.stringify([
        { id: "team", name: "T", adminIds: [], instance: "new-one" },
        { id: "moved", name: "M", adminIds: [], instance: "orig" },
      ]),
    );
    store.set(
      "config:routes",
      JSON.stringify([
        { id: "r1", name: "R", enabled: true, filters: [], targets: [], groupId: "moved" },
        { id: "r2", name: "R", enabled: true, filters: [], targets: [], groupId: "team" },
      ]),
    );
    const msg = makeMessage(body({ groupId: "team", groupInstance: "orig" }));
    await handleQueueBatch(makeBatch("webhooker-delivery", [msg]), createEnv(kv), fakeDispatch);
    const config = lastArgs[0] as { routes: Array<{ id: string }> };
    // Delivered to the renamed original group, not to the new "team".
    expect(config.routes.map((r) => r.id)).toEqual(["r1"]);
  });

  it("shares one lease renewal between routes running in parallel", async () => {
    const { db } = createSqliteD1();
    const { kv } = createMemoryKV();
    const env: Env = { GITHUB_WEBHOOK_SECRET: "s", KV: kv, DB: db };
    let answers: boolean[] = [];
    const dispatch = async (...args: unknown[]): Promise<DispatchSummary> => {
      const opts = args[4] as DispatchOptions;
      const realNow = Date.now;
      // Both routes reach their next target once a renewal is due.
      Date.now = (): number => realNow() + 90_000;
      try {
        answers = await Promise.all([opts.beforeTarget!(), opts.beforeTarget!()]);
      } finally {
        Date.now = realNow;
      }
      return { attempts: 0, failures: [] };
    };
    const msg = makeMessage(body());
    await handleQueueBatch(makeBatch("webhooker-delivery", [msg]), env, dispatch);
    // Neither route takes the shared renewal for a lost lease.
    expect(answers).toEqual([true, true]);
    expect(msg.acked).toBe(true);
    const row = await db
      .prepare("SELECT status FROM delivery_state WHERE key = ?")
      .bind("delivery-state:github:@global:d1")
      .first<{ status: string }>();
    expect(row?.status).toBe("delivered");
  });

  it("never acks when its own renewal went through unseen", async () => {
    const { db: real } = createSqliteD1();
    // The renewal commits, but its answer is lost.
    const db = {
      ...real,
      batch: real.batch.bind(real),
      prepare: (sql: string): D1PreparedStatement => {
        const stmt = real.prepare(sql);
        if (!sql.includes("UPDATE delivery_state SET updated_at = ?")) return stmt;
        return {
          ...stmt,
          bind: (...args: unknown[]) => {
            const bound = stmt.bind(...args);
            return {
              ...bound,
              run: async () => {
                await bound.run();
                throw new Error("network");
              },
            } as D1PreparedStatement;
          },
        } as D1PreparedStatement;
      },
    } as D1Database;
    const env: Env = { GITHUB_WEBHOOK_SECRET: "s", KV: createMemoryKV().kv, DB: db };
    const dispatch = async (...args: unknown[]): Promise<DispatchSummary> => {
      const opts = args[4] as DispatchOptions;
      const realNow = Date.now;
      Date.now = (): number => realNow() + 90_000;
      try {
        expect(await opts.beforeTarget!()).toBe(false);
      } finally {
        Date.now = realNow;
      }
      return {
        attempts: 1,
        failures: [{ key: "k", target: "t", error: "Delivery lease lost; left to its new holder" }],
      };
    };
    const msg = makeMessage(body());
    await handleQueueBatch(makeBatch("webhooker-delivery", [msg]), env, dispatch);
    // No new holder exists: the message comes back once the lease surely expired.
    expect(msg.acked).toBe(false);
    expect(msg.retried).toEqual({ delaySeconds: 310 });
  });

  it("never hands a pre-instance message to a group renamed onto its id", async () => {
    const { kv, store } = createMemoryKV();
    // Identities as the server assigned them (after the one-time migration).
    store.set("config:identity-migrated", "1");
    // "team" is held by a pre-instance group that had another id back then.
    store.set(
      "config:groups",
      JSON.stringify([
        {
          id: "team",
          name: "T",
          adminIds: [],
          instance: "b",
          instanceBackfilled: true,
          legacyId: "other",
        },
      ]),
    );
    store.set("config:routes", JSON.stringify([]));
    const msg = makeMessage(body({ groupId: "team" }));
    await handleQueueBatch(makeBatch("webhooker-delivery", [msg]), createEnv(kv), fakeDispatch);
    expect(dispatchCalls).toBe(0);
    expect(msg.acked).toBe(true);
  });

  it("never hands a pre-instance message to a group created since", async () => {
    const { kv, store } = createMemoryKV();
    // Identities as the server assigned them (after the one-time migration).
    store.set("config:identity-migrated", "1");
    // "team" now belongs to a group created after instances existed.
    store.set(
      "config:groups",
      JSON.stringify([{ id: "team", name: "T", adminIds: [], instance: "fresh" }]),
    );
    store.set(
      "config:routes",
      JSON.stringify([
        { id: "r2", name: "R", enabled: true, filters: [], targets: [], groupId: "team" },
      ]),
    );
    const msg = makeMessage(body({ groupId: "team" }));
    await handleQueueBatch(makeBatch("webhooker-delivery", [msg]), createEnv(kv), fakeDispatch);
    expect(dispatchCalls).toBe(0);
    expect(msg.acked).toBe(true);
    expect(JSON.parse(store.get("delivery-state:github:team:d1")!)).toMatchObject({
      status: "failed",
    });
  });
});

describe("consumer time budget", () => {
  beforeEach(() => {
    invalidateConfigCache();
    invalidateGroupsCache();
    dispatchCalls = 0;
  });

  it("gives a message it has no time left for back to the queue, uncopied", async () => {
    const { kv } = createMockKV();
    const sent: unknown[] = [];
    const env: Env = {
      ...createEnv(kv),
      QUEUE: { send: async (b: unknown) => void sent.push(b) } as unknown as Queue,
    };
    const msg = makeMessage(body());
    await handleQueueBatch(makeBatch("webhooker-delivery", [msg]), env, fakeDispatch, 0);
    expect(dispatchCalls).toBe(0);
    // Back to the queue as it is (one queue read), not copied (a write and a
    // delete more).
    expect(sent).toHaveLength(0);
    expect(msg.retried).not.toBeNull();
  });

  it("never spends a waiting message's last retry: it is copied instead", async () => {
    const { kv } = createMockKV();
    const sent: unknown[] = [];
    const env: Env = {
      ...createEnv(kv),
      QUEUE: { send: async (b: unknown) => void sent.push(b) } as unknown as Queue,
    };
    // Left for later on every earlier attempt (max_retries is 5).
    const msg = makeMessage(body(), 6);
    await handleQueueBatch(makeBatch("webhooker-delivery", [msg]), env, fakeDispatch, 0);
    expect(dispatchCalls).toBe(0);
    expect(sent).toHaveLength(1);
    expect(msg.acked).toBe(true);
    expect(msg.retried).toBeNull();
  });

  it("keeps the retry count of a started delivery that has to wait", async () => {
    const { kv, store } = createMockKV();
    // Taken and failed before: its attempts were real failures.
    store.set(STATE_KEY, JSON.stringify({ status: "retrying", at: Date.now() }));
    const sent: unknown[] = [];
    const env: Env = {
      ...createEnv(kv),
      QUEUE: { send: async (b: unknown) => void sent.push(b) } as unknown as Queue,
    };
    const msg = makeMessage(body(), 6);
    await handleQueueBatch(makeBatch("webhooker-delivery", [msg]), env, fakeDispatch, 0);
    // Not copied (a copy would start its failure count over): retried.
    expect(sent).toHaveLength(0);
    expect(msg.retried).not.toBeNull();
  });

  it("continues a delivery that ran out of time in a new message", async () => {
    const { kv } = createMockKV();
    const sent: unknown[] = [];
    const env: Env = {
      ...createEnv(kv),
      QUEUE: { send: async (b: unknown) => void sent.push(b) } as unknown as Queue,
    };
    const slowDispatch = async (...args: unknown[]): Promise<DispatchSummary> => {
      const options = args[4] as DispatchOptions;
      await new Promise((r) => setTimeout(r, 60));
      expect(await options.beforeTarget!()).toBe(false);
      return {
        attempts: 2,
        succeeded: ["k0"],
        failures: [{ key: "k", target: "t", error: "paused" }],
      };
    };
    const msg = makeMessage(body());
    await handleQueueBatch(makeBatch("webhooker-delivery", [msg]), env, slowDispatch, 30);
    expect(sent).toHaveLength(1);
    expect(msg.acked).toBe(true);
    expect(msg.retried).toBeNull();
  });
});

describe("consumer time budget without progress", () => {
  it("retries (and counts) a delivery that ran out of time without finishing a target", async () => {
    invalidateConfigCache();
    invalidateGroupsCache();
    const { kv } = createMockKV();
    const sent: unknown[] = [];
    const env: Env = {
      ...createEnv(kv),
      QUEUE: { send: async (b: unknown) => void sent.push(b) } as unknown as Queue,
    };
    const stuck = async (...args: unknown[]): Promise<DispatchSummary> => {
      const options = args[4] as DispatchOptions;
      await new Promise((r) => setTimeout(r, 60));
      await options.beforeTarget!();
      return { attempts: 1, failures: [{ key: "k", target: "t", error: "timeout" }] };
    };
    const msg = makeMessage(body());
    await handleQueueBatch(makeBatch("webhooker-delivery", [msg]), env, stuck, 30);
    expect(sent).toHaveLength(0);
    expect(msg.retried).not.toBeNull();
  });

  it("reads a pre-upgrade custom delivery id as sent, prefix-like text included", async () => {
    invalidateConfigCache();
    invalidateGroupsCache();
    const { db } = createSqliteD1();
    const { kv } = createMemoryKV();
    const env: Env = { GITHUB_WEBHOOK_SECRET: "s", KV: kv, DB: db };
    // The delivery "42" finished before the upgrade; "d:42" is another one.
    const { setDeliveryState } = await import("../server/lib/queue/delivery");
    await setDeliveryState(env, "delivery-state:custom:global:42", "delivered");
    const msg = makeMessage(body({ provider: "custom", deliveryId: "d:42" }));
    dispatchCalls = 0;
    summary = { attempts: 0, failures: [] };
    await handleQueueBatch(makeBatch("webhooker-delivery", [msg]), env, fakeDispatch);
    expect(dispatchCalls).toBe(1);
  });
});

describe("consumer send budget", () => {
  it("stops a batch after its send limit and continues the rest in a new message", async () => {
    invalidateConfigCache();
    invalidateGroupsCache();
    const { kv } = createMockKV();
    const sent: unknown[] = [];
    const env: Env = {
      ...createEnv(kv),
      QUEUE: { send: async (b: unknown) => void sent.push(b) } as unknown as Queue,
    };
    let allowed = 0;
    const wide = async (...args: unknown[]): Promise<DispatchSummary> => {
      const options = args[4] as DispatchOptions;
      for (let i = 0; i < 40; i++) if (await options.beforeTarget!()) allowed++;
      return {
        attempts: 40,
        succeeded: Array.from({ length: allowed }, (_, i) => `k${i}`),
        failures: [{ key: "rest", target: "t", error: "paused" }],
      };
    };
    const msg = makeMessage(body());
    await handleQueueBatch(makeBatch("webhooker-delivery", [msg]), env, wide);
    expect(allowed).toBe(20);
    expect(sent).toHaveLength(1);
    expect(msg.acked).toBe(true);
  });
});
