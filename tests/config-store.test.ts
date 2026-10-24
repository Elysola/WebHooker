import { describe, it, expect } from "bun:test";
import {
  d1ConfigStore,
  kvConfigStore,
  ConfigConflictError,
  UNGROUPED_ID,
} from "../server/lib/storage/config-store";
import type { Route, Group } from "../server/lib/types";
import { createMemoryKV, createSqliteD1 } from "./d1-sqlite";

function route(id: string, groupId: string, overrides: Partial<Route> = {}): Route {
  return {
    id,
    name: `route-${id}`,
    enabled: true,
    filters: [{ type: "event", match: "push" }],
    targets: [{ platform: "discord", channelId: "c1" }],
    groupId,
    stop: false,
    fallback: false,
    ...overrides,
  };
}

function group(id: string, overrides: Partial<Group> = {}): Group {
  return { id, name: `group-${id}`, adminIds: [], ...overrides };
}

function setup(options: { position?: boolean } = {}): {
  db: D1Database;
  sqlite: ReturnType<typeof createSqliteD1>["sqlite"];
  kv: KVNamespace;
  kvStore: Map<string, string>;
  cfg: ReturnType<typeof d1ConfigStore>;
} {
  const { db, sqlite } = createSqliteD1({
    migrations: (name) => options.position !== false || !name.startsWith("0012"),
  });
  const { kv, store } = createMemoryKV();
  return { db, sqlite, kv, kvStore: store, cfg: d1ConfigStore(db, kv) };
}

describe("d1ConfigStore", () => {
  it("loads empty when D1 and KV are empty", async () => {
    const { cfg } = setup();
    expect(await cfg.loadRoutes()).toEqual([]);
    expect(await cfg.loadGroups()).toEqual([]);
  });

  it("seeds D1 once from the legacy KV configuration", async () => {
    const { cfg, kvStore, sqlite } = setup();
    kvStore.set("config:groups", JSON.stringify([group("g1")]));
    kvStore.set(
      "config:routes",
      JSON.stringify([
        route("r1", "g1"),
        // Legacy shape: a single `target` and no group.
        { ...route("r2", ""), groupId: undefined, targets: undefined, target: { channelId: "x" } },
      ]),
    );
    const loaded = await cfg.loadRoutes();
    expect(loaded.map((r) => [r.id, r.groupId])).toEqual([
      ["r1", "g1"],
      ["r2", UNGROUPED_ID],
    ]);
    // The legacy single target was migrated before it reached D1.
    expect(loaded[1]!.targets).toEqual([{ channelId: "x" }]);
    expect((await cfg.loadGroups()).map((g) => g.id)).toEqual(["g1", UNGROUPED_ID]);
    expect(kvStore.get("config:d1-seeded")).toBe("1");
    expect(sqlite.query("SELECT COUNT(*) AS n FROM d1_routes").get()).toEqual({ n: 2 });
  });

  it("never resurrects a configuration that was emptied on purpose", async () => {
    const { cfg, kvStore } = setup();
    await cfg.createGroup(group("g1"));
    await cfg.saveGroupRoutes("g1", [route("r1", "g1")]);
    // A stale legacy copy is still in KV.
    kvStore.set("config:routes", JSON.stringify([route("old", "g1")]));
    await cfg.saveGroupRoutes("g1", []);
    await cfg.deleteGroup("g1");
    expect(await cfg.loadRoutes({ fresh: true })).toEqual([]);
    expect(await cfg.loadGroups({ fresh: true })).toEqual([]);
  });

  it("saving one group's routes leaves every other group untouched", async () => {
    const { cfg } = setup();
    await cfg.createGroup(group("a"));
    await cfg.createGroup(group("b"));
    await cfg.saveGroupRoutes("a", [route("a1", "a")]);
    await cfg.saveGroupRoutes("b", [route("b1", "b"), route("b2", "b")]);
    // An admin of "a" saves from a snapshot taken before "b" changed.
    await cfg.saveGroupRoutes("a", [route("a1", "a", { name: "renamed" })]);
    const all = await cfg.loadRoutes({ fresh: true });
    expect(all.map((r) => `${r.groupId}/${r.id}/${r.name}`)).toEqual([
      "a/a1/renamed",
      "b/b1/route-b1",
      "b/b2/route-b2",
    ]);
  });

  it("saveRoutes rewrites only the groups whose list changed", async () => {
    const { cfg, sqlite } = setup();
    await cfg.createGroup(group("a"));
    await cfg.createGroup(group("b"));
    await cfg.saveGroupRoutes("a", [route("a1", "a")]);
    await cfg.saveGroupRoutes("b", [route("b1", "b")]);
    sqlite.exec("UPDATE d1_routes SET updated_at = 1 WHERE group_id = 'b'");
    await cfg.saveRoutes([route("a1", "a", { enabled: false }), route("b1", "b")]);
    expect(sqlite.query("SELECT updated_at FROM d1_routes WHERE group_id = 'b'").get()).toEqual({
      updated_at: 1,
    });
    const a = (await cfg.loadRoutes({ fresh: true })).find((r) => r.id === "a1");
    expect(a!.enabled).toBe(false);
  });

  it("persists and loads the per-group route order", async () => {
    const { cfg } = setup();
    await cfg.createGroup(group("g1"));
    await cfg.saveGroupRoutes("g1", [route("b", "g1"), route("c", "g1"), route("a", "g1")]);
    expect((await cfg.loadRoutes({ fresh: true })).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("works on a database without the position column", async () => {
    const { cfg } = setup({ position: false });
    await cfg.createGroup(group("g1"));
    await cfg.saveGroupRoutes("g1", [route("b", "g1"), route("a", "g1")]);
    expect((await cfg.loadRoutes({ fresh: true })).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("serves cached routes until invalidated, fresh reads bypass the cache", async () => {
    const { cfg, sqlite } = setup();
    await cfg.createGroup(group("g1"));
    await cfg.saveGroupRoutes("g1", [route("r1", "g1")]);
    expect(await cfg.loadRoutes()).toHaveLength(1);
    sqlite.exec("DELETE FROM d1_routes");
    expect(await cfg.loadRoutes()).toHaveLength(1);
    expect(await cfg.loadRoutes({ fresh: true })).toHaveLength(0);
    cfg.invalidateCache();
    expect(await cfg.loadRoutes()).toHaveLength(0);
  });

  it("refuses to create or rename onto an id retired after the caller checked it", async () => {
    const { cfg, sqlite } = setup();
    await cfg.createGroup(group("a"));
    // A concurrent delete/rename retired "x" between the check and the write.
    sqlite.exec(
      `INSERT INTO dedup_keys (key, claimed_at, expires_at) VALUES ('group-retired:x', 0, ${Date.now() + 60_000})`,
    );
    expect(await cfg.createGroup(group("x"))).toBe(false);
    await expect(cfg.renameGroup("a", "x")).rejects.toBeInstanceOf(ConfigConflictError);
    expect((await cfg.loadGroups({ fresh: true })).map((g) => g.id)).toEqual(["a"]);
  });

  it("counts a group whose own row is unreadable — and has routes — as unreadable", async () => {
    const { cfg, sqlite } = setup();
    await cfg.createGroup(group("g1"));
    await cfg.createGroup(group("g2"));
    await cfg.saveGroupRoutes("g1", [route("r1", "g1")]);
    sqlite.exec("UPDATE d1_groups SET data = 'null' WHERE id IN ('g1', 'g2')");
    const snapshot = await cfg.loadSnapshot({ fresh: true });
    expect(snapshot.unreadable).toEqual(["g1"]);
  });

  it("counts a stored regex the engine cannot run as unreadable", async () => {
    const { cfg, sqlite } = setup();
    await cfg.createGroup(group("g1"));
    await cfg.saveGroupRoutes("g1", [route("r1", "g1")]);
    // Valid before the switch to RE2: lookahead now fails to compile.
    sqlite.exec(
      `UPDATE d1_routes SET filters = '[{"type":"repo","match":"/^secret(?=/)/","exclude":true}]' WHERE id = 'r1'`,
    );
    const snapshot = await cfg.loadSnapshot({ fresh: true });
    expect(snapshot.unreadable).toEqual(["g1"]);
  });

  it("keeps consulting KV state written before D1 when seeding from it", async () => {
    const { cfg, kvStore } = setup();
    kvStore.set("config:groups", JSON.stringify([group("g1")]));
    await cfg.loadGroups({ fresh: true });
    expect(kvStore.has("storage:kv-fallback")).toBe(true);
  });

  it("counts a route with a filter of the wrong shape as unreadable", async () => {
    const { cfg, sqlite } = setup();
    await cfg.createGroup(group("g1"));
    await cfg.saveGroupRoutes("g1", [route("r1", "g1")]);
    sqlite.exec(`UPDATE d1_routes SET filters = '[{"type":"event","match":{}}]' WHERE id = 'r1'`);
    const snapshot = await cfg.loadSnapshot({ fresh: true });
    expect(snapshot.routes).toEqual([]);
    expect(snapshot.unreadable).toEqual(["g1"]);
  });

  it("refuses to replace a group's routes while one of its rows is unreadable", async () => {
    const { cfg, sqlite } = setup();
    await cfg.createGroup(group("g1"));
    await cfg.saveGroupRoutes("g1", [route("r1", "g1"), route("r2", "g1")]);
    sqlite.exec("UPDATE d1_routes SET targets = '{broken' WHERE id = 'r2'");
    // Reads skip it, but a save would silently delete it: refused instead.
    expect((await cfg.loadRoutes({ fresh: true })).map((r) => r.id)).toEqual(["r1"]);
    await expect(cfg.saveGroupRoutes("g1", [route("r1", "g1")])).rejects.toThrow(/unreadable/);
    await expect(cfg.saveRoutes([route("r1", "g1", { name: "renamed" })])).rejects.toThrow(
      /unreadable/,
    );
    expect(sqlite.query("SELECT COUNT(*) AS n FROM d1_routes").get()).toEqual({ n: 2 });
  });

  it("renames a group with its routes and fragments in one transaction", async () => {
    const { cfg, sqlite } = setup();
    await cfg.createGroup(group("old", { name: "Team" }));
    await cfg.saveGroupRoutes("old", [route("r1", "old"), route("r2", "old")]);
    sqlite.exec(
      "INSERT INTO d1_fragments (id, group_id, name, node, created_at, updated_at) VALUES ('f1', 'old', 'F', '{}', 1, 1)",
    );
    await cfg.renameGroup("old", "new");
    expect((await cfg.loadGroups({ fresh: true })).map((g) => [g.id, g.name])).toEqual([
      ["new", "Team"],
    ]);
    expect((await cfg.loadRoutes({ fresh: true })).map((r) => `${r.groupId}/${r.id}`)).toEqual([
      "new/r1",
      "new/r2",
    ]);
    expect(sqlite.query("SELECT group_id FROM d1_fragments").all()).toEqual([{ group_id: "new" }]);
  });

  it("a failed rename changes nothing", async () => {
    const { cfg } = setup();
    await cfg.createGroup(group("a"));
    await cfg.createGroup(group("b"));
    await cfg.saveGroupRoutes("a", [route("r1", "a")]);
    await expect(cfg.renameGroup("a", "b")).rejects.toThrow();
    expect((await cfg.loadRoutes({ fresh: true })).map((r) => r.groupId)).toEqual(["a"]);
    expect((await cfg.loadGroups({ fresh: true })).map((g) => g.id)).toEqual(["a", "b"]);
  });

  it("deleting a group removes its routes and fragments only", async () => {
    const { cfg, sqlite } = setup();
    await cfg.createGroup(group("a"));
    await cfg.createGroup(group("b"));
    await cfg.saveGroupRoutes("a", [route("r1", "a")]);
    await cfg.saveGroupRoutes("b", [route("r1", "b")]);
    sqlite.exec(
      "INSERT INTO d1_fragments (id, group_id, name, node, created_at, updated_at) VALUES ('f1', 'a', 'F', '{}', 1, 1)",
    );
    await cfg.deleteGroup("a");
    expect((await cfg.loadRoutes({ fresh: true })).map((r) => r.groupId)).toEqual(["b"]);
    expect(sqlite.query("SELECT COUNT(*) AS n FROM d1_fragments").get()).toEqual({ n: 0 });
  });

  it("saveGroups writes only changed groups and deletes the missing ones", async () => {
    const { cfg, sqlite } = setup();
    await cfg.createGroup(group("a"));
    await cfg.createGroup(group("b"));
    await cfg.saveGroupRoutes("a", [route("r1", "a")]);
    sqlite.exec("UPDATE d1_groups SET updated_at = 1");
    await cfg.saveGroups([group("a"), group("c")]);
    expect((await cfg.loadGroups({ fresh: true })).map((g) => g.id)).toEqual(["a", "c"]);
    expect(sqlite.query("SELECT updated_at FROM d1_groups WHERE id = 'a'").get()).toEqual({
      updated_at: 1,
    });
    // Updating a group never touches its routes.
    expect(await cfg.loadRoutes({ fresh: true })).toHaveLength(1);
  });

  it("createGroup never overwrites an existing group", async () => {
    const { cfg } = setup();
    expect(await cfg.createGroup(group("g", { name: "first" }))).toBe(true);
    expect(await cfg.createGroup(group("g", { name: "second" }))).toBe(false);
    expect((await cfg.loadGroups({ fresh: true }))[0]!.name).toBe("first");
  });

  it("updateGroup is a compare-and-swap that retries on contention", async () => {
    const { cfg, sqlite } = setup();
    await cfg.createGroup(group("g", { name: "v0" }));
    let calls = 0;
    const updated = await cfg.updateGroup("g", (g) => {
      calls++;
      // A concurrent writer bumps the row between our read and our write once.
      if (calls === 1)
        sqlite.exec(
          "UPDATE d1_groups SET version = version + 1, data = json_set(data, '$.name', 'other')",
        );
      return { ...g, name: `${g.name}+mine` };
    });
    expect(calls).toBe(2);
    expect(updated!.name).toBe("other+mine");
    expect((await cfg.loadGroups({ fresh: true }))[0]!.name).toBe("other+mine");
  });

  it("updateGroup gives up with a conflict when contention never settles", async () => {
    const { cfg, sqlite } = setup();
    await cfg.createGroup(group("g"));
    await expect(
      cfg.updateGroup("g", (g) => {
        sqlite.exec("UPDATE d1_groups SET version = version + 1");
        return { ...g, name: "x" };
      }),
    ).rejects.toBeInstanceOf(ConfigConflictError);
  });

  it("updateGroup returns null for a missing group and keeps a group on null", async () => {
    const { cfg } = setup();
    expect(await cfg.updateGroup("missing", (g) => g)).toBeNull();
    await cfg.createGroup(group("g"));
    expect((await cfg.updateGroup("g", () => null))!.id).toBe("g");
  });

  it("never stores a client revision", async () => {
    const { cfg, sqlite } = setup();
    await cfg.createGroup({ ...group("g"), revision: "abc" });
    const row = sqlite.query("SELECT data FROM d1_groups").get() as { data: string };
    expect(JSON.parse(row.data).revision).toBeUndefined();
  });

  it("propagates D1 write failures instead of pretending to save", async () => {
    const { cfg, sqlite } = setup();
    await cfg.createGroup(group("g"));
    sqlite.exec("DROP TABLE d1_routes");
    await expect(cfg.saveGroupRoutes("g", [route("r1", "g")])).rejects.toThrow();
  });

  it("propagates D1 read failures instead of serving any stale copy", async () => {
    const { cfg, sqlite } = setup();
    await cfg.createGroup(group("g"));
    await cfg.saveGroupRoutes("g", [route("r1", "g")]);
    sqlite.exec("DROP TABLE d1_routes");
    cfg.invalidateCache();
    await expect(cfg.loadRoutes()).rejects.toThrow();
    await expect(cfg.loadGroups()).rejects.toThrow();
  });

  it("gives every group an immutable instance id that survives renames", async () => {
    const { cfg, sqlite } = setup();
    sqlite.exec(
      'INSERT INTO d1_groups (id, name, data, version, created_at, updated_at) VALUES (\'legacy\', \'L\', \'{"id":"legacy","name":"L","adminIds":[]}\', 1, 0, 0)',
    );
    await cfg.createGroup({ ...group("fresh"), instance: "client-chosen" });
    const loaded = await cfg.loadGroups({ fresh: true });
    const legacy = loaded.find((g) => g.id === "legacy");
    const fresh = loaded.find((g) => g.id === "fresh");
    expect(legacy!.instance).toMatch(/^[0-9a-f]{32}$/);
    expect(fresh!.instance).not.toBe("client-chosen");
    await cfg.updateGroup("fresh", (g) => ({ ...g, instance: "tampered" }));
    const renamed = await cfg.renameGroup("fresh", "moved");
    expect(renamed.instance).toBe(fresh!.instance);
    await cfg.deleteGroup("moved");
    await cfg.createGroup(group("moved"));
    const again = (await cfg.loadGroups({ fresh: true })).find((g) => g.id === "moved")!;
    expect(again.instance).not.toBe(fresh!.instance);
  });

  it("refuses a delete when the group changed after it was checked", async () => {
    const { cfg } = setup();
    await cfg.createGroup(group("g"));
    await expect(
      cfg.deleteGroup("g", {
        expect: async () => {
          await cfg.updateGroup("g", (x) => ({ ...x, name: "changed" }));
        },
      }),
    ).rejects.toBeInstanceOf(ConfigConflictError);
    expect((await cfg.loadGroups({ fresh: true })).map((g) => g.name)).toEqual(["changed"]);
  });

  it("refuses routes for a group that does not exist", async () => {
    const { cfg } = setup();
    await expect(cfg.saveGroupRoutes("ghost", [route("r1", "ghost")])).rejects.toThrow();
  });
});

describe("kvConfigStore", () => {
  it("keeps groups and routes in permanent KV keys", async () => {
    const { kv, store } = createMemoryKV();
    const cfg = kvConfigStore(kv);
    await cfg.createGroup(group("a"));
    await cfg.saveGroupRoutes("a", [route("r1", "a")]);
    await cfg.renameGroup("a", "b");
    expect((await cfg.loadGroups()).map((g) => g.id)).toEqual(["b"]);
    expect((await cfg.loadRoutes()).map((r) => r.groupId)).toEqual(["b"]);
    await cfg.deleteGroup("b");
    expect(JSON.parse(store.get("config:routes")!)).toEqual([]);
  });

  it("repairs orphaned routes before a reused group id can inherit them", async () => {
    const { kv, store } = createMemoryKV();
    store.set("config:groups", JSON.stringify([group("current")]));
    store.set(
      "config:routes",
      JSON.stringify([route("orphan", "reused"), route("live", "current")]),
    );
    const cfg = kvConfigStore(kv);

    expect((await cfg.loadRoutes()).map((r) => r.id)).toEqual(["live"]);
    expect(JSON.parse(store.get("config:routes")!)).toEqual([route("live", "current")]);

    await expect(cfg.createGroup(group("reused"))).resolves.toBe(true);
    expect((await cfg.loadRoutes()).map((r) => r.id)).toEqual(["live"]);
  });

  it("backfills the same instance whichever cold start wins the race", async () => {
    const { kv, store } = createMemoryKV();
    store.set("config:groups", JSON.stringify([group("legacy")]));
    // Two isolates read the legacy list before either wrote it back.
    const [a, b] = await Promise.all([
      kvConfigStore(kv).loadGroups(),
      kvConfigStore(kv).loadGroups(),
    ]);
    expect(a[0]!.instance).toBeTruthy();
    expect(a[0]!.instance).toBe(b[0]!.instance);
    expect(a[0]!.instanceBackfilled).toBe(true);
    // A rename keeps the identity.
    const cfg = kvConfigStore(kv);
    const moved = await cfg.renameGroup("legacy", "renamed", { transform: (g) => ({ ...g }) });
    expect(moved.instance).toBe(a[0]!.instance);
    expect(moved.instanceBackfilled).toBe(true);
  });
});

describe("d1ConfigStore guarded writes", () => {
  it("lets only one of two writes from the same base commit", async () => {
    const { cfg } = setup();
    await cfg.createGroup(group("g"));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = cfg.saveGroupRoutes("g", [route("a", "g")], { expect: () => gate });
    // A second write sneaks in while the first waits between check and write.
    await cfg.saveGroupRoutes("g", [route("b", "g")]);
    release();
    await expect(slow).rejects.toBeInstanceOf(ConfigConflictError);
    expect((await cfg.loadRoutes({ fresh: true })).map((r) => r.id)).toEqual(["b"]);
  });

  it("refuses a rename whose source changed after it was read", async () => {
    const { cfg } = setup();
    await cfg.createGroup(group("old", { name: "v1" }));
    await expect(
      cfg.renameGroup("old", "new", {
        expect: async () => {
          await cfg.updateGroup("old", (g) => ({ ...g, name: "v2" }));
        },
      }),
    ).rejects.toBeInstanceOf(ConfigConflictError);
    expect((await cfg.loadGroups({ fresh: true })).map((g) => [g.id, g.name])).toEqual([
      ["old", "v2"],
    ]);
  });

  it("does not seed (nor mark seeded) when the legacy KV read fails", async () => {
    const { db } = createSqliteD1();
    const { kv, store } = createMemoryKV();
    store.set("config:routes", JSON.stringify([route("r1", "g1")]));
    const failing = {
      ...kv,
      get: async (key: string, type?: string) => {
        if (key === "config:groups") throw new Error("KV down");
        return kv.get(key, type as never);
      },
    } as unknown as KVNamespace;
    const cfg = d1ConfigStore(db, failing);
    await expect(cfg.loadRoutes({ fresh: true })).rejects.toThrow("KV down");
    expect(store.get("config:d1-seeded")).toBeUndefined();
  });

  it("fails instead of serving an empty configuration when D1 and the copy are missing", async () => {
    const { db, sqlite } = createSqliteD1();
    const { kv } = createMemoryKV();
    const cfg = d1ConfigStore(db, kv);
    await cfg.loadRoutes();
    sqlite.exec("DROP TABLE d1_routes");
    cfg.invalidateCache();
    await kv.delete("config:cache:routes");
    await expect(cfg.loadRoutes()).rejects.toThrow();
  });
});
