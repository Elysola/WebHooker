import { describe, it, expect, beforeEach } from "bun:test";
import { getDeliveryMetrics } from "../server/lib/observability/metrics";
import {
  getSendLogByDelivery,
  getFailedSendLog,
  type SendRecord,
} from "../server/lib/lib/send-log";
import { adminApiMetrics, adminApiDelivery, adminApiLogs } from "../server/lib/web/admin";
import { createSqliteD1 } from "./d1-sqlite";
import { createAdminSession, adminCookie } from "../server/lib/web/session";
import { invalidateGroupsCache } from "../server/lib/web/groups";
import { makeEvent, responseStatus } from "./helpers";
import type { Env } from "../server/lib/types";

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string, type?: string) => {
      const v = store.get(key);
      if (v == null) return null;
      if (type === "json") return JSON.parse(v);
      return v;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({
      keys: [...store.keys()].map((k) => ({ name: k })),
      list_complete: true,
      cacheStatus: null,
    }),
  } as unknown as KVNamespace;
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_WEBHOOK_SECRET: "secret",
    KV: createMockKV(),
    DB: createMetricsDB({}),
    ...overrides,
  };
}

function createMetricsDB(rowsBySql: Record<string, unknown[]>): D1Database {
  const all = (sql: string) => async (): Promise<{ results: unknown[] }> => {
    for (const [key, rows] of Object.entries(rowsBySql)) {
      if (sql.includes(key)) return { results: rows };
    }
    return { results: [] };
  };
  let batches = 0;
  return {
    prepare: (sql: string) => ({
      all: all(sql),
      bind: (..._args: unknown[]) => ({
        all: all(sql),
        run: async () => ({ success: true }),
      }),
    }),
    batch: async (statements: Array<{ all: () => Promise<unknown> }>) => {
      batches++;
      return Promise.all(statements.map((s) => s.all()));
    },
    get batches(): number {
      return batches;
    },
  } as unknown as D1Database;
}

const logRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 1,
  ts: 1700000000000,
  route_id: "r1",
  group_id: "mine",
  event: "push",
  repo: "acme/widget",
  target: "discord:111",
  ok: 1,
  error: null,
  status: 200,
  message_id: "m1",
  delivery_id: "d1",
  platform: "discord",
  actor: "alice",
  action: null,
  duration_ms: 100,
  error_code: null,
  attempts: 1,
  detail: null,
  ...overrides,
});

describe("delivery metrics", () => {
  it("aggregates send_logs into metrics", async () => {
    const db = createMetricsDB({
      // Totals, average duration and attempts come from one scan.
      attempts_total: [{ total: 10, ok: 8, avg: 120.5, attempts_total: 12, attempts_avg: 1.2 }],
      "platform AS key": [
        { key: "discord", total: 7, ok: 6 },
        { key: "telegram", total: 3, ok: 2 },
      ],
      "event AS key": [{ key: "push", total: 10, ok: 8 }],
      "GROUP BY status": [
        { status: "200", count: 8 },
        { status: "500", count: 2 },
      ],
      "ok = 0": [logRow({ ok: 0, status: 500, error_code: "DISCORD_5XX" })],
    });
    const m = await getDeliveryMetrics(db);
    // Every query goes out in a single batch (one D1 round trip).
    expect((db as unknown as { batches: number }).batches).toBe(1);
    expect(m.total).toBe(10);
    expect(m.ok).toBe(8);
    expect(m.failed).toBe(2);
    expect(m.failureRate).toBeCloseTo(0.2);
    expect(m.byPlatform).toEqual([
      { platform: "discord", total: 7, ok: 6, failed: 1 },
      { platform: "telegram", total: 3, ok: 2, failed: 1 },
    ]);
    expect(m.byEvent).toEqual([{ event: "push", total: 10, ok: 8, failed: 2 }]);
    expect(m.byStatus).toEqual([
      { status: "200", count: 8 },
      { status: "500", count: 2 },
    ]);
    expect(m.avgDurationMs).toBeCloseTo(120.5);
    expect(m.totalAttempts).toBe(12);
    expect(m.avgAttempts).toBeCloseTo(1.2);
    expect(m.recentFailures).toHaveLength(1);
    expect(m.recentFailures[0]!.errorCode).toBe("DISCORD_5XX");
  });

  it("returns zeroed metrics on empty database", async () => {
    const m = await getDeliveryMetrics(createMetricsDB({}));
    expect(m.total).toBe(0);
    expect(m.ok).toBe(0);
    expect(m.failed).toBe(0);
    expect(m.failureRate).toBe(0);
    expect(m.byPlatform).toEqual([]);
    expect(m.recentFailures).toEqual([]);
  });

  it("correlates send_logs by delivery id", async () => {
    const db = createMetricsDB({
      delivery_id: [
        logRow({ id: 1, ok: 1, delivery_id: "d1" }),
        logRow({ id: 2, ok: 0, delivery_id: "d1", platform: "telegram", status: 500 }),
      ],
    });
    const rows = await getSendLogByDelivery(db, "d1");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.deliveryId).toBe("d1");
    expect(rows[1]!.ok).toBe(false);
  });

  it("lists failed sends", async () => {
    const db = createMetricsDB({
      "ok = 0": [logRow({ ok: 0, error_code: "NETWORK" })],
    });
    const rows: SendRecord[] = await getFailedSendLog(db, 5);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ok).toBe(false);
    expect(rows[0]!.errorCode).toBe("NETWORK");
  });
});

describe("delivery metrics (SQLite)", () => {
  it("averages duration and attempts over the rows that have them, in one scan", async () => {
    const { db, sqlite } = createSqliteD1();
    const insert = sqlite.prepare(
      "INSERT INTO send_logs (ts, route_id, group_id, event, target, ok, duration_ms, attempts) VALUES (?, 'r', 'g', 'push', 't', ?, ?, ?)",
    );
    insert.run(1, 1, 100, 1);
    insert.run(2, 0, 300, 3);
    insert.run(3, 1, null, null);
    const m = await getDeliveryMetrics(db);
    expect(m.total).toBe(3);
    expect(m.ok).toBe(2);
    expect(m.avgDurationMs).toBe(200);
    expect(m.totalAttempts).toBe(4);
    expect(m.avgAttempts).toBe(2);
  });
});

describe("admin metrics/delivery handlers", () => {
  beforeEach(() => invalidateGroupsCache());

  /** A real (SQLite) D1 with two groups and send logs in both. */
  function seeded(): { env: Env; kv: KVNamespace } {
    const { db, sqlite } = createSqliteD1();
    const kv = createMockKV();
    const insert = sqlite.prepare(
      "INSERT INTO send_logs (ts, route_id, group_id, event, target, ok, delivery_id, error_code) VALUES (?, 'r', ?, 'push', 't', ?, ?, ?)",
    );
    insert.run(1, "mine", 1, "d1", null);
    insert.run(2, "mine", 0, "d1", "NETWORK");
    insert.run(3, "theirs", 0, "d1", "NETWORK");
    insert.run(4, "theirs", 1, "d2", null);
    insert.run(5, "theirs", 1, "d3", null);
    const groups = [
      { id: "mine", name: "Mine", adminIds: [], members: [{ login: "bob", role: "owner" }] },
      { id: "theirs", name: "Theirs", adminIds: [], members: [{ login: "eve", role: "owner" }] },
    ];
    for (const g of groups) {
      sqlite
        .prepare(
          "INSERT INTO d1_groups (id, name, data, version, created_at, updated_at) VALUES (?, ?, ?, 1, 0, 0)",
        )
        .run(g.id, g.name, JSON.stringify(g));
    }
    return { env: createEnv({ KV: kv, DB: db, ADMIN_USER_IDS: "1001" }), kv };
  }

  async function as(kv: KVNamespace, userId: string, login: string): Promise<string> {
    return adminCookie(await createAdminSession(kv, userId, login));
  }

  it("returns global metrics for super admins", async () => {
    const { env, kv } = seeded();
    const cookie = await as(kv, "1001", "alice");
    const event = makeEvent("/api/metrics", { headers: { cookie }, env });
    const res = (await adminApiMetrics(event)) as { metrics: { total: number } };
    expect(responseStatus(event)).toBe(200);
    expect(res.metrics.total).toBe(5);
  });

  it("scopes every aggregate to the reader's groups", async () => {
    const { env, kv } = seeded();
    const cookie = await as(kv, "2002", "bob");
    const event = makeEvent("/api/metrics", { headers: { cookie }, env });
    const res = (await adminApiMetrics(event)) as {
      metrics: { total: number; failed: number; recentFailures: Array<{ groupId?: string }> };
    };
    expect(res.metrics.total).toBe(2);
    expect(res.metrics.failed).toBe(1);
    expect(res.metrics.recentFailures.map((f) => f.groupId)).toEqual(["mine"]);
  });

  it("returns 404 for an unknown delivery", async () => {
    const { env, kv } = seeded();
    const cookie = await as(kv, "1001", "alice");
    const event = makeEvent("/api/delivery/nope", { headers: { cookie }, env });
    const res = (await adminApiDelivery(event, "nope")) as { error?: string };
    expect(responseStatus(event)).toBe(404);
    expect(res.error).toBe("Delivery not found");
  });

  it("shows a reader only their groups' attempts of a shared delivery", async () => {
    const { env, kv } = seeded();
    const cookie = await as(kv, "2002", "bob");
    const event = makeEvent("/api/delivery/d1", { headers: { cookie }, env });
    const res = (await adminApiDelivery(event, "d1")) as {
      attempts?: Array<{ groupId?: string }>;
    };
    expect(responseStatus(event)).toBe(200);
    expect(res.attempts!.map((a) => a.groupId)).toEqual(["mine", "mine"]);
    const other = makeEvent("/api/delivery/d2", { headers: { cookie }, env });
    await adminApiDelivery(other, "d2");
    expect(responseStatus(other)).toBe(404);
  });

  it("lists logs of the reader's groups even when others are newer", async () => {
    const { env, kv } = seeded();
    const cookie = await as(kv, "2002", "bob");
    const event = makeEvent("/api/logs?limit=2", { headers: { cookie }, env });
    const res = (await adminApiLogs(event)) as { logs: Array<{ groupId?: string }> };
    expect(res.logs.map((l) => l.groupId)).toEqual(["mine", "mine"]);
  });
});
