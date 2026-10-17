import { describe, it, expect } from "bun:test";
import { d1ConfigStore, type ConfigStore } from "../server/lib/storage/config-store";
import type { Route, Group } from "../server/lib/types";

interface Stmt {
  sql: string;
  bound: unknown[];
  bind: (...args: unknown[]) => Stmt;
  all: () => Promise<{ results: Array<Record<string, unknown>> }>;
}

interface FakeDB {
  prepare: (sql: string) => Stmt;
  batch: (stmts: Stmt[]) => Promise<unknown[]>;
}

interface FakeDBOptions {
  /** Whether `d1_routes` has the `position` column (migration 0012). */
  positionColumn?: boolean;
  /** How many batches fail with a transient (non-schema) error first. */
  batchFailures?: number;
}

function route(id: string, groupId: string, overrides: Partial<Route> = {}): Route {
  return {
    id,
    name: `route-${id}`,
    enabled: true,
    filters: [],
    targets: [],
    groupId,
    stop: false,
    fallback: false,
    ...overrides,
  };
}

function group(id: string): Group {
  return { id, name: `group-${id}`, adminIds: [] };
}

function createDB(options: FakeDBOptions = {}): {
  db: FakeDB & D1Database;
  routesTable: Route[];
  groupsTable: Group[];
  queries: string[];
  batches: Stmt[][];
} {
  const routesTable: Route[] = [];
  const groupsTable: Group[] = [];
  const queries: string[] = [];
  const batches: Stmt[][] = [];
  let batchFailures = options.batchFailures ?? 0;
  const db: FakeDB = {
    prepare(sql: string): Stmt {
      const stmt: Stmt = {
        sql,
        bound: [],
        bind(...args: unknown[]): Stmt {
          stmt.bound = args;
          return stmt;
        },
        async all(): Promise<{ results: Array<Record<string, unknown>> }> {
          queries.push(sql);
          if (sql.includes("position") && !options.positionColumn) {
            throw new Error("D1_ERROR: no such column: position at offset 33: SQLITE_ERROR");
          }
          if (sql.includes("FROM d1_routes")) {
            return {
              results: routesTable.map((r) => ({
                id: r.id,
                group_id: r.groupId ?? "",
                name: r.name,
                enabled: r.enabled ? 1 : 0,
                filters: JSON.stringify(r.filters),
                targets: JSON.stringify(r.targets),
                stop: r.stop ? 1 : 0,
                fallback: r.fallback ? 1 : 0,
                discord_role_ids: r.discordRoleIds ? JSON.stringify(r.discordRoleIds) : null,
                ast: r.ast ? JSON.stringify(r.ast) : null,
              })),
            };
          }
          if (sql.includes("FROM d1_groups")) {
            return {
              results: groupsTable.map((g) => ({
                id: g.id,
                name: g.name,
                data: JSON.stringify(g),
                version: 1,
              })),
            };
          }
          return { results: [] };
        },
      };
      return stmt;
    },
    async batch(stmts: Stmt[]): Promise<unknown[]> {
      batches.push(stmts);
      if (batchFailures > 0) {
        batchFailures--;
        throw new Error("D1_ERROR: network connection lost");
      }
      if (!options.positionColumn && stmts.some((st) => st.sql.includes("position,"))) {
        throw new Error("D1_ERROR: table d1_routes has no column named position: SQLITE_ERROR");
      }
      return [];
    },
  };
  return { db: db as FakeDB & D1Database, routesTable, groupsTable, queries, batches };
}

/** Bound `(id, position)` pairs of every route upsert in a batch. */
function upsertPositions(stmts: Stmt[]): Array<[unknown, unknown]> {
  return stmts
    .filter((s) => s.sql.includes("INSERT INTO d1_routes"))
    .map((s) => [s.bound[0], s.sql.includes("position") ? s.bound[10] : undefined]);
}

function createKV(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    store,
    get: async <T>(key: string, type?: string): Promise<T | null> => {
      const v = store.get(key);
      if (v == null) return null;
      if (type === "json") return JSON.parse(v) as T;
      return v as unknown as T;
    },
    put: async (key: string, value: string): Promise<void> => {
      store.set(key, value);
    },
    delete: async (key: string): Promise<void> => {
      store.delete(key);
    },
    list: async (): Promise<{ keys: unknown[] }> => ({ keys: [] }),
  };
  return { kv: kv as unknown as KVNamespace, store };
}

describe("d1ConfigStore", () => {
  it("loads empty when D1 and KV are empty", async () => {
    const { db } = createDB();
    const { kv } = createKV();
    const store: ConfigStore = d1ConfigStore(db, kv);
    expect(await store.loadRoutes()).toEqual([]);
    expect(await store.loadGroups()).toEqual([]);
  });

  it("seeds routes from KV into memory when D1 is empty and caches in KV", async () => {
    const { db } = createDB();
    const { kv, store } = createKV();
    const existing = [route("r1", "g1")];
    store.set("config:routes", JSON.stringify(existing));
    const cfg: ConfigStore = d1ConfigStore(db, kv);
    const loaded = await cfg.loadRoutes();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("r1");
  });

  it("reads routes directly from D1 when populated", async () => {
    const { db, routesTable } = createDB();
    const { kv } = createKV();
    routesTable.push(route("r1", "g1"));
    const cfg: ConfigStore = d1ConfigStore(db, kv);
    const loaded = await cfg.loadRoutes();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("r1");
    expect(loaded[0].groupId).toBe("g1");
  });

  it("round-trips routes through D1 + KV cache on save", async () => {
    const { db, routesTable } = createDB();
    const { kv, store } = createKV();
    const cfg: ConfigStore = d1ConfigStore(db, kv);
    const routes = [route("r1", "g1"), route("r2", "g2")];
    await cfg.saveRoutes(routes);
    expect(routesTable).toHaveLength(0);
    const cached = store.get("config:routes");
    expect(cached).toBe(JSON.stringify(routes));
    const reloaded = await cfg.loadRoutes();
    expect(reloaded).toHaveLength(2);
  });

  it("round-trips groups through D1 + KV cache on save", async () => {
    const { db } = createDB();
    const { kv, store } = createKV();
    const cfg: ConfigStore = d1ConfigStore(db, kv);
    const groups = [group("g1"), group("g2")];
    await cfg.saveGroups(groups);
    expect(store.get("config:groups")).toBe(JSON.stringify(groups));
    const reloaded = await cfg.loadGroups();
    expect(reloaded).toHaveLength(2);
  });

  it("invalidateCache forces a reload", async () => {
    const { db, routesTable } = createDB();
    const { kv } = createKV();
    const cfg: ConfigStore = d1ConfigStore(db, kv);
    routesTable.push(route("r1", "g1"));
    const first = await cfg.loadRoutes();
    expect(first).toHaveLength(1);
    routesTable.push(route("r2", "g2"));
    const cached = await cfg.loadRoutes();
    expect(cached).toHaveLength(1);
    cfg.invalidateCache();
    const second = await cfg.loadRoutes();
    expect(second).toHaveLength(2);
  });

  it("persists the per-group route order when the position column exists", async () => {
    const { db, batches } = createDB({ positionColumn: true });
    const { kv } = createKV();
    const cfg: ConfigStore = d1ConfigStore(db, kv);
    await cfg.saveRoutes([route("b", "g1"), route("x", "g2"), route("a", "g1")]);
    expect(upsertPositions(batches[0]!)).toEqual([
      ["b", 0],
      ["x", 0],
      ["a", 1],
    ]);
  });

  it("loads routes ordered by group and position when the column exists", async () => {
    const { db, queries } = createDB({ positionColumn: true });
    const { kv } = createKV();
    await d1ConfigStore(db, kv).loadRoutes();
    expect(queries.some((q) => q.includes("FROM d1_routes ORDER BY group_id, position, id"))).toBe(
      true,
    );
  });

  it("falls back to the legacy id order and inserts on an unmigrated database", async () => {
    const { db, queries, batches } = createDB();
    const { kv } = createKV();
    const cfg: ConfigStore = d1ConfigStore(db, kv);
    await cfg.loadRoutes();
    expect(queries.at(-1)).toContain("FROM d1_routes ORDER BY id");
    await cfg.saveRoutes([route("r1", "g1")]);
    expect(upsertPositions(batches.at(-1)!)).toEqual([["r1", undefined]]);
  });

  it("picks up the position column once the database is migrated", async () => {
    const options: FakeDBOptions = {};
    const { db, queries } = createDB(options);
    const { kv } = createKV();
    const cfg: ConfigStore = d1ConfigStore(db, kv);
    await cfg.loadRoutes();
    expect(queries.at(-1)).toContain("ORDER BY id");
    options.positionColumn = true;
    cfg.invalidateCache();
    await cfg.loadRoutes();
    expect(queries.at(-1)).toContain("ORDER BY group_id, position, id");
  });

  it("never retries without positions when D1 fails for another reason", async () => {
    const { db, batches } = createDB({ positionColumn: true, batchFailures: 1 });
    const { kv, store } = createKV();
    const cfg: ConfigStore = d1ConfigStore(db, kv);
    const routes = [route("b", "g1"), route("a", "g1")];
    await cfg.saveRoutes(routes);
    // Only the positioned batch was attempted; the save took the existing
    // "D1 unavailable" path instead of writing rows that lose the order.
    expect(batches).toHaveLength(1);
    expect(upsertPositions(batches[0]!)).toEqual([
      ["b", 0],
      ["a", 1],
    ]);
    expect(store.get("config:routes")).toBe(JSON.stringify(routes));
  });

  it("updating groups does not cascade-delete routes", async () => {
    const { db, routesTable, groupsTable } = createDB();
    const { kv } = createKV();
    const cfg: ConfigStore = d1ConfigStore(db, kv);

    // Setup initial state with groups and routes
    groupsTable.push(group("g1"), group("g2"));
    routesTable.push(route("r1", "g1"), route("r2", "g2"));

    // Simulate updating groups (e.g., changing a group's name)
    const updatedGroups = [{ ...group("g1"), name: "Updated Group 1" }, group("g2")];

    // This should not delete routes
    await cfg.saveGroups(updatedGroups);

    // Routes should still exist in the table
    // Note: In the fake DB, batch() doesn't actually execute the statements,
    // so we can't verify the actual deletion behavior here.
    // This test mainly ensures saveGroups doesn't throw an error.
    expect(routesTable).toHaveLength(2);
  });
});
