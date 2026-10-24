import { describe, it, expect } from "bun:test";
import {
  d1IdempotencyStore,
  idempotencyStore,
  kvIdempotencyStore,
} from "../server/lib/lib/idempotency";
import {
  d1MessageTracker,
  kvMessageTracker,
  messageTracker,
} from "../server/lib/lib/message-tracker";
import {
  acquireDelivery,
  finishLease,
  getDeliveryState,
  renewLease,
  setDeliveryState,
} from "../server/lib/queue/delivery";
import { createMemoryKV, createSqliteD1 } from "./d1-sqlite";
import { chainLock } from "../server/lib/lib/message-tracker";
import { recordSendBatch } from "../server/lib/lib/send-log-batch";
import { canUseD1 } from "../server/lib/storage/d1";
import type { Env } from "../server/lib/types";

interface Row {
  message_id?: string;
  status?: string;
  hit?: number;
}

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

function createMockD1(): {
  db: D1Database;
  dedupKeys: Map<string, { claimedAt: number; expiresAt: number }>;
  messageRows: Map<string, { messageId: string; updatedAt: number }>;
  deliveryRows: Map<string, { status: string; updatedAt: number }>;
} {
  const dedupKeys = new Map<string, { claimedAt: number; expiresAt: number }>();
  const messageRows = new Map<string, { messageId: string; updatedAt: number }>();
  const deliveryRows = new Map<string, { status: string; updatedAt: number }>();

  const run = (sql: string, args: unknown[]): { success: boolean; meta: { changes: number } } => {
    if (sql.includes("INSERT INTO dedup_keys")) {
      const [key, claimedAt, expiresAt] = args as [string, number, number];
      const existing = dedupKeys.get(key);
      if (!existing) {
        dedupKeys.set(key, { claimedAt, expiresAt });
        return { success: true, meta: { changes: 1 } };
      }
      if (existing.expiresAt < claimedAt) {
        dedupKeys.set(key, { claimedAt, expiresAt });
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    }
    if (sql.includes("INSERT INTO message_tracking")) {
      const [eventId, targetId, messageId, updatedAt] = args as [string, string, string, number];
      messageRows.set(`${eventId}\u0000${targetId}`, { messageId, updatedAt });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO delivery_state")) {
      const [key, status, updatedAt] = args as [string, string, number];
      deliveryRows.set(key, { status, updatedAt });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("DELETE FROM message_tracking")) {
      const [eventId, targetId] = args as [string, string];
      const existed = messageRows.delete(`${eventId}\u0000${targetId}`);
      return { success: true, meta: { changes: existed ? 1 : 0 } };
    }
    return { success: true, meta: { changes: 0 } };
  };

  const first = (sql: string, args: unknown[]): Row | null => {
    if (sql.includes("SELECT 1 AS hit FROM dedup_keys")) {
      const [key, now] = args as [string, number];
      const row = dedupKeys.get(key);
      if (row && row.expiresAt > now) return { hit: 1 };
      return null;
    }
    if (sql.includes("SELECT message_id FROM message_tracking")) {
      const [eventId, targetId] = args as [string, string];
      const row = messageRows.get(`${eventId}\u0000${targetId}`);
      return row ? { message_id: row.messageId } : null;
    }
    if (sql.includes("SELECT status FROM delivery_state")) {
      const [key] = args as [string];
      const row = deliveryRows.get(key);
      return row ? { status: row.status } : null;
    }
    return null;
  };

  const db = {
    prepare: (
      sql: string,
    ): {
      bind: (...args: unknown[]) => {
        run: () => Promise<{ success: boolean; meta: { changes: number } }>;
        all: () => Promise<{ results: unknown[] }>;
        first: () => Promise<Row | null>;
      };
    } => ({
      bind: (
        ...args: unknown[]
      ): {
        run: () => Promise<{ success: boolean; meta: { changes: number } }>;
        all: () => Promise<{ results: unknown[] }>;
        first: () => Promise<Row | null>;
      } => ({
        run: async () => run(sql, args),
        all: async () => ({ results: [] }),
        first: async () => first(sql, args),
      }),
    }),
    batch: async (): Promise<unknown[]> => [],
  } as unknown as D1Database;

  return { db, dedupKeys, messageRows, deliveryRows };
}

function envWith(db: D1Database, kv: KVNamespace): Env {
  return { KV: kv, DB: db } as Env;
}

describe("d1IdempotencyStore", () => {
  it("claims a key exactly once", async () => {
    const { db } = createMockD1();
    const store = d1IdempotencyStore(db);
    const key = "delivery:github:g1:e1";
    await expect(store.claim(key, 120)).resolves.toBe(true);
    await expect(store.claim(key, 120)).resolves.toBe(false);
    await expect(store.has(key)).resolves.toBe(true);
  });

  it("treats an expired dedup key as absent", async () => {
    const { db, dedupKeys } = createMockD1();
    const store = d1IdempotencyStore(db);
    const key = "delivery:gitea:global:e2";
    await store.claim(key, 120);
    dedupKeys.set(key, { claimedAt: Date.now(), expiresAt: Date.now() - 1000 });
    await expect(store.has(key)).resolves.toBe(false);
    await expect(store.claim(key, 120)).resolves.toBe(true);
  });

  it("does not collide across different keys", async () => {
    const { db } = createMockD1();
    const store = d1IdempotencyStore(db);
    await store.claim("delivery:github:g1:e1", 120);
    await expect(store.claim("delivery:github:g1:e2", 120)).resolves.toBe(true);
    await expect(store.has("delivery:github:g1:e2")).resolves.toBe(true);
  });
});

describe("d1MessageTracker", () => {
  it("round-trips a message id", async () => {
    const { db } = createMockD1();
    const tracker = d1MessageTracker(db);
    await tracker.set("evt-1", "discord:123", { messageId: "message-42", version: 7 });
    await expect(tracker.get("evt-1", "discord:123")).resolves.toEqual({
      messageId: "message-42",
      version: 7,
    });
    await expect(tracker.get("evt-1", "discord:999")).resolves.toBeNull();
  });

  it("updates on re-set and deletes on delete", async () => {
    const { db } = createMockD1();
    const tracker = d1MessageTracker(db);
    await tracker.set("evt-1", "tg:9", { messageId: "old", version: 1 });
    await tracker.set("evt-1", "tg:9", { messageId: "new", version: 2 });
    await expect(tracker.get("evt-1", "tg:9")).resolves.toEqual({ messageId: "new", version: 2 });
    await tracker.delete("evt-1", "tg:9");
    await expect(tracker.get("evt-1", "tg:9")).resolves.toBeNull();
  });
});

describe("delivery state backed by D1", () => {
  it("round-trips status through the delivery_state table", async () => {
    const { db } = createMockD1();
    const env = envWith(db, createMockKV());
    const key = "delivery-state:github:global:d1";
    await setDeliveryState(env, key, "processing");
    await expect(getDeliveryState(env, key)).resolves.toBe("processing");
    await setDeliveryState(env, key, "delivered");
    await expect(getDeliveryState(env, key)).resolves.toBe("delivered");
  });

  it("returns null when no state exists", async () => {
    const { db } = createMockD1();
    const env = envWith(db, createMockKV());
    await expect(getDeliveryState(env, "delivery-state:github:g9:nope")).resolves.toBeNull();
  });
});

describe("factory fallback decision", () => {
  it("canUseD1 is false for a db without batch", () => {
    const empty = {} as D1Database;
    expect(canUseD1(empty)).toBe(false);
    expect(canUseD1(undefined)).toBe(false);
  });

  it("idempotencyStore falls back to KV semantics without batch", async () => {
    const db = {
      prepare: (): {
        bind: () => {
          run: () => Promise<{ success: boolean }>;
          all: () => Promise<{ results: unknown[] }>;
        };
      } => ({
        bind: (): {
          run: () => Promise<{ success: boolean }>;
          all: () => Promise<{ results: unknown[] }>;
        } => ({
          run: async () => ({ success: true }),
          all: async () => ({ results: [] }),
        }),
      }),
    } as unknown as D1Database;
    const kv = createMockKV();
    const store = idempotencyStore(db, kv);
    await store.claim("delivery:github:g1:e1", 120);
    await expect(store.claim("delivery:github:g1:e1", 120)).resolves.toBe(false);
  });

  it("messageTracker falls back to KV semantics without batch", async () => {
    const db = {} as D1Database;
    const kv = createMockKV();
    const tracker = messageTracker(db, kv);
    await tracker.set("evt-1", "discord:1", { messageId: "m1", version: 0 });
    await expect(tracker.get("evt-1", "discord:1")).resolves.toEqual({
      messageId: "m1",
      version: 0,
    });
    await tracker.delete("evt-1", "discord:1");
    await expect(tracker.get("evt-1", "discord:1")).resolves.toBeNull();
  });

  it("kv stores still work on their own", async () => {
    const kv = createMockKV();
    const idem = kvIdempotencyStore(kv);
    await idem.claim("delivery:github:g1:e1", 120);
    await expect(idem.has("delivery:github:g1:e1")).resolves.toBe(true);

    const msg = kvMessageTracker(kv);
    await msg.set("evt-1", "discord:1", { messageId: "m1", version: 3 });
    await expect(msg.get("evt-1", "discord:1")).resolves.toEqual({ messageId: "m1", version: 3 });
  });

  it("reads message ids stored before versions existed", async () => {
    const kv = createMockKV();
    await kv.put("msg:evt-1:discord:1", "legacy-id");
    await expect(kvMessageTracker(kv).get("evt-1", "discord:1")).resolves.toEqual({
      messageId: "legacy-id",
      version: 0,
    });
  });
});

describe("D1 failures degrade to KV", () => {
  it("idempotency claims fall back to KV when the D1 table is missing", async () => {
    const { db } = createSqliteD1({
      migrations: (f) => !f.startsWith("0008") && !f.startsWith("0013"),
    });
    const { kv } = createMemoryKV();
    const store = idempotencyStore(db, kv);
    await expect(store.claim("k", 120)).resolves.toBe(true);
    await expect(store.claim("k", 120)).resolves.toBe(false);
    await store.release("k");
    await expect(store.claim("k", 120)).resolves.toBe(true);
  });

  it("message tracking falls back to KV when the D1 table is missing", async () => {
    const { db } = createSqliteD1({
      migrations: (f) => !f.startsWith("0008") && !f.startsWith("0013"),
    });
    const { kv } = createMemoryKV();
    const tracker = messageTracker(db, kv);
    await tracker.set("e", "t", { messageId: "m", version: 1 });
    await expect(tracker.get("e", "t")).resolves.toEqual({ messageId: "m", version: 1 });
  });
});

describe("acquireDelivery", () => {
  function env(): Env {
    return { KV: createMemoryKV().kv, DB: createSqliteD1().db } as Env;
  }

  it("lets exactly one consumer take a delivery", async () => {
    const e = env();
    expect((await acquireDelivery(e, "k")).status).toBe("acquired");
    expect((await acquireDelivery(e, "k")).status).toBe("busy");
  });

  it("hands a waiting retry to the next consumer", async () => {
    const e = env();
    await acquireDelivery(e, "k");
    await setDeliveryState(e, "k", "retrying");
    expect((await acquireDelivery(e, "k")).status).toBe("acquired");
  });

  it("reports finished deliveries", async () => {
    const e = env();
    for (const status of ["delivered", "failed", "dead"] as const) {
      await setDeliveryState(e, `k-${status}`, status);
      expect((await acquireDelivery(e, `k-${status}`)).status).toBe("finished");
    }
  });

  it("fences a holder whose lease was taken over", async () => {
    const { db, sqlite } = createSqliteD1();
    const e = { KV: createMemoryKV().kv, DB: db } as Env;
    const first = await acquireDelivery(e, "k");
    sqlite.exec("UPDATE delivery_state SET updated_at = 0");
    // A takeover happens minutes later in practice; never in the same ms.
    await Bun.sleep(2);
    const second = await acquireDelivery(e, "k");
    expect(second.status).toBe("acquired");
    // The old holder can neither renew nor overwrite the new holder's outcome.
    expect(await renewLease(e, "k", first.token)).toBeNull();
    expect(await finishLease(e, "k", first.token, "delivered")).toBe(false);
    expect(await finishLease(e, "k", second.token, "delivered")).toBe(true);
    expect(await getDeliveryState(e, "k")).toBe("delivered");
  });

  it("takes over a lease whose holder went silent", async () => {
    const { db, sqlite } = createSqliteD1();
    const e = { KV: createMemoryKV().kv, DB: db } as Env;
    await acquireDelivery(e, "k");
    sqlite.exec("UPDATE delivery_state SET updated_at = 0");
    expect((await acquireDelivery(e, "k")).status).toBe("acquired");
  });
});

describe("delivery state falls back to KV without batch", () => {
  it("stores JSON status in KV", async () => {
    const db = {} as D1Database;
    const kv = createMockKV();
    const env = envWith(db, kv);
    const key = "delivery-state:github:global:d2";
    await setDeliveryState(env, key, "delivered");
    const raw = await kv.get(key);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toMatchObject({ status: "delivered" });
    await expect(getDeliveryState(env, key)).resolves.toBe("delivered");
    await expect(getDeliveryState(env, "delivery-state:github:global:nope")).resolves.toBeNull();
  });
});

describe("KV fallback transition", () => {
  it("keeps honoring and releasing claims made in KV before the table existed", async () => {
    const { db: noTable } = createSqliteD1({
      migrations: (f) => !f.startsWith("0008") && !f.startsWith("0013"),
    });
    const { kv } = createMemoryKV();
    await idempotencyStore(noTable, kv).claim("k", 600);
    // The migration is applied afterwards (same KV, a database with the table).
    const { db } = createSqliteD1();
    const store = idempotencyStore(db, kv);
    expect(await store.has("k")).toBe(true);
    expect(await store.claim("k", 600)).toBe(false);
    await store.release("k");
    expect(await store.claim("k", 600)).toBe(true);
  });
});

describe("chainLock", () => {
  it("admits one holder at a time and only the holder can release", async () => {
    const { db } = createSqliteD1();
    const lock = chainLock(db, createMemoryKV().kv);
    const token = await lock.acquire("chain", 60);
    expect(token).not.toBeNull();
    expect(await lock.acquire("chain", 60)).toBeNull();
    await lock.release("chain", "999");
    expect(await lock.acquire("chain", 60)).toBeNull();
    await lock.release("chain", token!);
    expect(await lock.acquire("chain", 60)).not.toBeNull();
  });
});

describe("send log group attribution", () => {
  it("files rows under the id the group instance has at insert time", async () => {
    const { db, sqlite } = createSqliteD1();
    sqlite.exec(
      `INSERT INTO d1_groups (id, name, data, version, created_at, updated_at) VALUES ('renamed', 'R', '{"id":"renamed","name":"R","adminIds":[],"instance":"abc"}', 1, 0, 0)`,
    );
    const base = { ts: 1, routeId: "r", event: "push", target: "t", ok: true };
    await recordSendBatch(db, [
      { ...base, groupId: "old-id", groupInstance: "abc" },
      { ...base, groupId: "deleted", groupInstance: "gone" },
    ]);
    expect(sqlite.query("SELECT group_id FROM send_logs ORDER BY id").all()).toEqual([
      { group_id: "renamed" },
      { group_id: null },
    ]);
  });
});
