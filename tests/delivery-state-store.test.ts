import { describe, it, expect } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  deliveryClaimStore,
  deliveryStateStore,
  deliveryStateUsesD1,
} from "../server/lib/storage/state-store";
import {
  acquireDelivery,
  deliveryStateKey,
  finishLease,
  getDeliveryState,
  hadPermanentFailure,
  markDeliveryDead,
  markTargetsDone,
  renewLease,
  setDeliveryState,
  targetDoneChecker,
} from "../server/lib/queue/delivery";
import { chainLock, messageTracker } from "../server/lib/lib/message-tracker";
import { createMemoryKV, createSqliteD1 } from "./d1-sqlite";
import type { Env } from "../server/lib/types";

function storeEnv(
  options: { mode?: string; db?: D1Database; kv?: KVNamespace } = {},
): { env: Env; sqlite: Database; store: Map<string, string> } {
  const { db, sqlite } = createSqliteD1();
  const memory = createMemoryKV();
  return {
    env: {
      GITHUB_WEBHOOK_SECRET: "secret",
      DB: options.db ?? db,
      KV: options.kv ?? memory.kv,
      DELIVERY_STATE_STORE: options.mode,
    } as Env,
    sqlite,
    store: memory.store,
  };
}

function rows(sqlite: Database, table: string): number {
  return (sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("deliveryStateStore", () => {
  it("defaults to D1 when the variable is absent or empty", () => {
    expect(deliveryStateStore({})).toBe("d1");
    expect(deliveryStateStore({ DELIVERY_STATE_STORE: "" })).toBe("d1");
    expect(deliveryStateStore({ DELIVERY_STATE_STORE: "   " })).toBe("d1");
  });

  it("reads d1 explicitly", () => {
    expect(deliveryStateStore({ DELIVERY_STATE_STORE: "d1" })).toBe("d1");
    expect(deliveryStateStore({ DELIVERY_STATE_STORE: " D1 " })).toBe("d1");
  });

  it("switches to kv, ignoring case and surrounding spaces", () => {
    expect(deliveryStateStore({ DELIVERY_STATE_STORE: "kv" })).toBe("kv");
    expect(deliveryStateStore({ DELIVERY_STATE_STORE: "KV" })).toBe("kv");
    expect(deliveryStateStore({ DELIVERY_STATE_STORE: " Kv " })).toBe("kv");
  });

  it("treats an unknown value as d1", () => {
    expect(deliveryStateStore({ DELIVERY_STATE_STORE: "d1x" })).toBe("d1");
    expect(deliveryStateStore({ DELIVERY_STATE_STORE: "kv2" })).toBe("d1");
    expect(deliveryStateStore({ DELIVERY_STATE_STORE: "redis" })).toBe("d1");
  });
});

describe("deliveryStateUsesD1", () => {
  it("is true for the default and d1 while D1 is usable", () => {
    const { env } = storeEnv();
    expect(deliveryStateUsesD1(env)).toBe(true);
    expect(deliveryStateUsesD1({ ...env, DELIVERY_STATE_STORE: "d1" })).toBe(true);
    expect(deliveryStateUsesD1({ ...env, DELIVERY_STATE_STORE: "d1x" })).toBe(true);
  });

  it("is false in kv mode even when D1 is usable", () => {
    const { env } = storeEnv({ mode: "kv" });
    expect(deliveryStateUsesD1(env)).toBe(false);
  });

  it("is false without a usable D1 binding", () => {
    const { env } = storeEnv({ db: {} as D1Database });
    expect(deliveryStateUsesD1(env)).toBe(false);
    expect(deliveryStateUsesD1({ ...env, DELIVERY_STATE_STORE: "kv" })).toBe(false);
  });
});

describe("delivery state in d1 mode", () => {
  it("writes the delivery_state row and nothing to KV", async () => {
    const { env, sqlite, store } = storeEnv();
    const key = deliveryStateKey("github", "g1", "d1");
    await setDeliveryState(env, key, "processing");
    expect(rows(sqlite, "delivery_state")).toBe(1);
    expect(store.has(key)).toBe(false);
    expect(store.has("storage:kv-fallback")).toBe(false);
    expect(await getDeliveryState(env, key)).toBe("processing");
  });

  it("writes claims and the target ledger to dedup_keys", async () => {
    const { env, sqlite, store } = storeEnv();
    const claims = deliveryClaimStore(env);
    expect(await claims.claim("delivery:github:g1:d1", 600)).toBe(true);
    expect(rows(sqlite, "dedup_keys")).toBe(1);
    expect(store.has("delivery:github:g1:d1")).toBe(false);
    expect(store.has("storage:kv-fallback")).toBe(false);
  });
});

describe("delivery state in kv mode", () => {
  it("writes only the KV state key while D1 stays empty", async () => {
    const { env, sqlite, store } = storeEnv({ mode: "kv" });
    const key = deliveryStateKey("github", "g1", "d1");
    await setDeliveryState(env, key, "processing");
    expect(store.has(key)).toBe(true);
    expect(JSON.parse(store.get(key) as string)).toMatchObject({ status: "processing" });
    expect(rows(sqlite, "delivery_state")).toBe(0);
    expect(await getDeliveryState(env, key)).toBe("processing");
  });

  it("acquires without a fencing token and holds the delivery for one lease", async () => {
    const { env, sqlite, store } = storeEnv({ mode: "kv" });
    const key = deliveryStateKey("github", "g1", "d1");
    const first = await acquireDelivery(env, key);
    expect(first).toEqual({ status: "acquired", token: null });
    expect(JSON.parse(store.get(key) as string)).toMatchObject({ status: "processing" });
    // The stamp keeps a second consumer off a delivery that is still sending.
    expect(await acquireDelivery(env, key)).toEqual({ status: "busy", token: null });
    // Once the holder vanished (stamp older than the lease), it is taken over.
    store.set(key, JSON.stringify({ status: "processing", at: Date.now() - 6 * 60_000 }));
    expect(await acquireDelivery(env, key)).toEqual({ status: "acquired", token: null });
    expect(rows(sqlite, "delivery_state")).toBe(0);
  });

  it("refreshes the lease stamp on renewal", async () => {
    const { env, store } = storeEnv({ mode: "kv" });
    const key = deliveryStateKey("github", "g1", "d1");
    await acquireDelivery(env, key);
    store.set(key, JSON.stringify({ status: "processing", at: Date.now() - 4 * 60_000 }));
    expect(await renewLease(env, key, null)).toBeNull();
    const refreshed = JSON.parse(store.get(key) as string) as { at: number };
    expect(Date.now() - refreshed.at).toBeLessThan(10_000);
    // A stamp that is still fresh is left alone (no KV write).
    await renewLease(env, key, null);
    expect(JSON.parse(store.get(key) as string)).toMatchObject({ at: refreshed.at });
  });

  it("reports finished deliveries as finished", async () => {
    const { env, sqlite, store } = storeEnv({ mode: "kv" });
    const key = deliveryStateKey("github", "g1", "done");
    await setDeliveryState(env, key, "delivered");
    expect(await acquireDelivery(env, key)).toEqual({ status: "finished", token: null });
    expect(JSON.parse(store.get(key) as string)).toMatchObject({ status: "delivered" });
    expect(rows(sqlite, "delivery_state")).toBe(0);
  });

  it("finishes and renews a lease without a token", async () => {
    const { env, sqlite, store } = storeEnv({ mode: "kv" });
    const key = deliveryStateKey("github", "g1", "d1");
    const lease = await acquireDelivery(env, key);
    expect(await renewLease(env, key, lease.token)).toBeNull();
    expect(await renewLease(env, key, 12345)).toBe(12345);
    expect(await finishLease(env, key, lease.token, "delivered")).toBe(true);
    expect(await getDeliveryState(env, key)).toBe("delivered");
    expect(JSON.parse(store.get(key) as string)).toMatchObject({ status: "delivered" });
    expect(await acquireDelivery(env, key)).toEqual({ status: "finished", token: null });
    expect(rows(sqlite, "delivery_state")).toBe(0);
  });

  it("writes a retrying outcome that the next consumer may take", async () => {
    const { env } = storeEnv({ mode: "kv" });
    const key = deliveryStateKey("github", "g1", "d1");
    await acquireDelivery(env, key);
    expect(await finishLease(env, key, null, "retrying")).toBe(true);
    expect(await getDeliveryState(env, key)).toBe("retrying");
    expect((await acquireDelivery(env, key)).status).toBe("acquired");
  });

  it("marks a delivery dead without touching D1", async () => {
    const { env, sqlite, store } = storeEnv({ mode: "kv" });
    const waiting = deliveryStateKey("github", "g1", "waiting");
    const done = deliveryStateKey("github", "g1", "done");
    const live = deliveryStateKey("github", "g1", "live");
    const stale = deliveryStateKey("github", "g1", "stale");
    await setDeliveryState(env, waiting, "retrying");
    await setDeliveryState(env, done, "delivered");
    await setDeliveryState(env, live, "processing");
    await setDeliveryState(env, stale, "processing");
    store.set(stale, JSON.stringify({ status: "processing", at: Date.now() - 6 * 60_000 }));
    expect(await markDeliveryDead(env, waiting)).toBe("dead");
    expect(await getDeliveryState(env, waiting)).toBe("dead");
    expect(await markDeliveryDead(env, done)).toBe("finished");
    expect(await getDeliveryState(env, done)).toBe("delivered");
    // A live lease is respected: its holder is still sending.
    expect(await markDeliveryDead(env, live)).toBe("busy");
    expect(await getDeliveryState(env, live)).toBe("processing");
    expect(await markDeliveryDead(env, stale)).toBe("dead");
    expect(rows(sqlite, "delivery_state")).toBe(0);
    expect(store.has(waiting)).toBe(true);
  });

  it("records and reads finished targets and permanent failures from KV", async () => {
    const { env, sqlite, store } = storeEnv({ mode: "kv" });
    const stateKey = deliveryStateKey("github", "g1", "d1");
    const done = targetDoneChecker(env, stateKey);
    expect(await done("discord:1")).toBe(false);
    expect(await hadPermanentFailure(env, stateKey)).toBe(false);

    await markTargetsDone(env, stateKey, ["discord:1", "telegram:2"]);
    expect(await done("discord:1")).toBe(true);
    expect(await done("telegram:2")).toBe(true);
    expect(await done("feishu:3")).toBe(false);
    expect(store.has(`delivery-target:${stateKey}:discord:1`)).toBe(true);
    expect(rows(sqlite, "dedup_keys")).toBe(0);
    expect(await hadPermanentFailure(env, stateKey)).toBe(false);

    await markTargetsDone(env, stateKey, ["feishu:3"], { permanentFailure: true });
    expect(await hadPermanentFailure(env, stateKey)).toBe(true);
    expect(await done("feishu:3")).toBe(true);
    expect(store.has(`delivery-failed:${stateKey}`)).toBe(true);
    expect(rows(sqlite, "dedup_keys")).toBe(0);
  });
});

describe("switching back to d1", () => {
  it("still honors a claim written in kv mode", async () => {
    const { env, store, sqlite } = storeEnv({ mode: "kv" });
    const key = "delivery:github:g1:d1";
    expect(await deliveryClaimStore(env).claim(key, 600)).toBe(true);
    expect(store.has("storage:kv-fallback")).toBe(true);
    expect(rows(sqlite, "dedup_keys")).toBe(0);

    const switched = { ...env, DELIVERY_STATE_STORE: "d1" } as Env;
    const claims = deliveryClaimStore(switched);
    expect(await claims.has(key)).toBe(true);
    expect(await claims.claim(key, 600)).toBe(false);
    await claims.release(key);
    expect(await claims.has(key)).toBe(false);
    expect(await claims.claim(key, 600)).toBe(true);
    expect(rows(sqlite, "dedup_keys")).toBe(1);
  });

  it("still honors a delivery state written in kv mode", async () => {
    const { env, sqlite, store } = storeEnv({ mode: "kv" });
    const key = deliveryStateKey("github", "g1", "d1");
    await setDeliveryState(env, key, "delivered");

    const switched = { ...env, DELIVERY_STATE_STORE: "d1" } as Env;
    expect(await getDeliveryState(switched, key)).toBe("delivered");
    expect(await acquireDelivery(switched, key)).toEqual({ status: "finished", token: null });
    expect(rows(sqlite, "delivery_state")).toBe(0);
    expect(store.has(key)).toBe(true);
  });

  it("lets a delivery left retrying in kv mode be acquired again", async () => {
    const { env } = storeEnv({ mode: "kv" });
    const key = deliveryStateKey("github", "g1", "d1");
    await setDeliveryState(env, key, "retrying");

    const switched = { ...env, DELIVERY_STATE_STORE: "d1" } as Env;
    const lease = await acquireDelivery(switched, key);
    expect(lease.status).toBe("acquired");
    expect(lease.token).not.toBeNull();
    expect(await finishLease(switched, key, lease.token, "delivered")).toBe(true);
    expect(await getDeliveryState(switched, key)).toBe("delivered");
  });

  it("still honors the target ledger and permanent failures written in kv mode", async () => {
    const { env } = storeEnv({ mode: "kv" });
    const stateKey = deliveryStateKey("github", "g1", "d1");
    await markTargetsDone(env, stateKey, ["discord:1"], { permanentFailure: true });

    const switched = { ...env, DELIVERY_STATE_STORE: "d1" } as Env;
    expect(await targetDoneChecker(switched, stateKey)("discord:1")).toBe(true);
    expect(await hadPermanentFailure(switched, stateKey)).toBe(true);
  });

  it("keeps a live kv lease off a d1 acquisition", async () => {
    const { env, sqlite, store } = storeEnv();
    const key = deliveryStateKey("github", "g1", "d1");
    store.set("storage:kv-fallback", String(Date.now() + 86_400_000));
    store.set(key, JSON.stringify({ status: "processing", at: Date.now() }));
    expect(await acquireDelivery(env, key)).toEqual({ status: "busy", token: null });
    expect(rows(sqlite, "delivery_state")).toBe(0);

    store.set(key, JSON.stringify({ status: "processing", at: Date.now() - 6 * 60_000 }));
    const lease = await acquireDelivery(env, key);
    expect(lease.status).toBe("acquired");
    expect(lease.token).not.toBeNull();
    expect(rows(sqlite, "delivery_state")).toBe(1);
  });

  it("keeps a live kv lease from being marked dead by the d1 path", async () => {
    const { env, sqlite, store } = storeEnv();
    const key = deliveryStateKey("github", "g1", "d1");
    store.set("storage:kv-fallback", String(Date.now() + 86_400_000));
    store.set(key, JSON.stringify({ status: "processing", at: Date.now() }));
    expect(await markDeliveryDead(env, key)).toBe("busy");
    expect(rows(sqlite, "delivery_state")).toBe(0);

    store.set(key, JSON.stringify({ status: "processing", at: Date.now() - 6 * 60_000 }));
    expect(await markDeliveryDead(env, key)).toBe("dead");
    expect(rows(sqlite, "delivery_state")).toBe(1);
  });
});

describe("deliveryClaimStore", () => {
  it("claims in KV and reads the claim back from KV in kv mode", async () => {
    const { env, sqlite, store } = storeEnv({ mode: "kv" });
    const claims = deliveryClaimStore(env);
    expect(await claims.has("nonce:abc")).toBe(false);
    expect(await claims.claim("nonce:abc", 300)).toBe(true);
    expect(store.has("storage:kv-fallback")).toBe(true);
    expect(await env.KV.get("nonce:abc")).not.toBeNull();
    expect(await claims.claim("nonce:abc", 300)).toBe(false);
    expect(await claims.has("nonce:abc")).toBe(true);
    expect(rows(sqlite, "dedup_keys")).toBe(0);
    await claims.release("nonce:abc");
    expect(await env.KV.get("nonce:abc")).toBeNull();
    expect(await claims.claim("nonce:abc", 300)).toBe(true);
    expect(rows(sqlite, "dedup_keys")).toBe(0);
  });

  it("claims in D1 when the store is d1", async () => {
    const { env, sqlite, store } = storeEnv();
    const claims = deliveryClaimStore(env);
    expect(await claims.claim("nonce:abc", 300)).toBe(true);
    expect(await claims.claim("nonce:abc", 300)).toBe(false);
    expect(rows(sqlite, "dedup_keys")).toBe(1);
    expect(store.has("nonce:abc")).toBe(false);
  });
});

describe("messageTracker with an explicit store", () => {
  it("tracks messages in KV without a D1 row when useD1 is false", async () => {
    const { env, sqlite, store } = storeEnv({ mode: "kv" });
    const tracker = messageTracker(env.DB, env.KV, false);
    await tracker.set("evt-1", "discord:1", { messageId: "m1", version: 3 });
    expect(await tracker.get("evt-1", "discord:1")).toEqual({ messageId: "m1", version: 3 });
    expect(store.has("msg:evt-1:discord:1")).toBe(true);
    expect(store.has("storage:kv-fallback")).toBe(true);
    expect(rows(sqlite, "message_tracking")).toBe(0);

    await tracker.move(
      { eventId: "evt-1", targetId: "discord:1" },
      { eventId: "evt-2", targetId: "discord:1" },
      { messageId: "m1", version: 3 },
    );
    expect(store.has("msg:evt-1:discord:1")).toBe(false);
    expect(await tracker.get("evt-2", "discord:1")).toEqual({ messageId: "m1", version: 3 });

    await tracker.delete("evt-2", "discord:1");
    expect(await tracker.get("evt-2", "discord:1")).toBeNull();
    expect(rows(sqlite, "message_tracking")).toBe(0);
  });

  it("tracks messages in D1 when the store argument is omitted", async () => {
    const { env, sqlite, store } = storeEnv();
    const tracker = messageTracker(env.DB, env.KV);
    await tracker.set("evt-1", "discord:1", { messageId: "m1", version: 3 });
    expect(await tracker.get("evt-1", "discord:1")).toEqual({ messageId: "m1", version: 3 });
    expect(rows(sqlite, "message_tracking")).toBe(1);
    expect(store.has("msg:evt-1:discord:1")).toBe(false);
    expect(store.has("storage:kv-fallback")).toBe(false);
  });

  it("falls back to KV when no D1 binding is given", async () => {
    const { env, store } = storeEnv({ db: {} as D1Database });
    const tracker = messageTracker(env.DB, env.KV);
    await tracker.set("evt-1", "discord:1", { messageId: "m1", version: 1 });
    expect(await tracker.get("evt-1", "discord:1")).toEqual({ messageId: "m1", version: 1 });
    expect(store.has("msg:evt-1:discord:1")).toBe(true);
  });
});

describe("chainLock with an explicit store", () => {
  it("uses a KV marker without a D1 row when useD1 is false", async () => {
    const { env, sqlite, store } = storeEnv({ mode: "kv" });
    const lock = chainLock(env.DB, env.KV, false);
    const token = await lock.acquire("chain:1", 60);
    expect(token).not.toBeNull();
    expect(store.has("chain:1")).toBe(true);
    expect(await lock.acquire("chain:1", 60)).toBeNull();
    await lock.release("chain:1", "not-the-holder");
    expect(await lock.acquire("chain:1", 60)).toBeNull();
    await lock.release("chain:1", token as string);
    expect(store.has("chain:1")).toBe(false);
    expect(await lock.acquire("chain:1", 60)).not.toBeNull();
    expect(rows(sqlite, "dedup_keys")).toBe(0);
  });

  it("uses a dedup_keys row when the store argument is omitted", async () => {
    const { env, sqlite, store } = storeEnv();
    const lock = chainLock(env.DB, env.KV);
    const token = await lock.acquire("chain:1", 60);
    expect(token).not.toBeNull();
    expect(rows(sqlite, "dedup_keys")).toBe(1);
    expect(store.has("chain:1")).toBe(false);
    expect(await lock.acquire("chain:1", 60)).toBeNull();
    await lock.release("chain:1", token as string);
    expect(rows(sqlite, "dedup_keys")).toBe(0);
    expect(await lock.acquire("chain:1", 60)).not.toBeNull();
  });

  it("waits for a lock a kv-mode holder still has, in d1 mode", async () => {
    const { env, sqlite, store } = storeEnv();
    const lock = chainLock(env.DB, env.KV);
    store.set("storage:kv-fallback", String(Date.now() + 86_400_000));
    store.set("chain:1", "held-in-kv");
    expect(await lock.acquire("chain:1", 60)).toBeNull();
    expect(rows(sqlite, "dedup_keys")).toBe(0);

    store.delete("chain:1");
    const token = await lock.acquire("chain:1", 60);
    expect(token).not.toBeNull();
    expect(rows(sqlite, "dedup_keys")).toBe(1);
    await lock.release("chain:1", token as string);
    expect(rows(sqlite, "dedup_keys")).toBe(0);
  });
});
