import { describe, it, expect, beforeEach } from "bun:test";
import { recordAudit, getAuditLog, pruneAuditLogs } from "../server/lib/lib/audit";
import { createSqliteD1 } from "./d1-sqlite";

describe("audit log", () => {
  let db: D1Database;

  beforeEach(async () => {
    db = createSqliteD1().db;
    for (const id of ["g1", "g2", "g3"]) {
      await db
        .prepare(
          "INSERT INTO d1_groups (id, name, data, version, created_at, updated_at) VALUES (?, ?, ?, 1, 0, 0)",
        )
        .bind(id, id, JSON.stringify({ id, name: id, instance: `inst-${id}` }))
        .run();
    }
  });

  it("files a late entry under the group's current id, never a deleted one", async () => {
    // The group was renamed (same instance) before the entry was written.
    await db.prepare("UPDATE d1_groups SET id = 'g9' WHERE id = 'g1'").run();
    await recordAudit(db, { ts: 1, action: "renamed", groupId: "g1", groupInstance: "inst-g1" });
    // An entry for a group deleted meanwhile belongs to no group.
    await db.prepare("DELETE FROM d1_groups WHERE id = 'g2'").run();
    await recordAudit(db, { ts: 2, action: "deleted", groupId: "g2" });
    expect((await getAuditLog(db, { groupId: "g9" })).map((e) => e.action)).toEqual(["renamed"]);
    expect(await getAuditLog(db, { groupId: "g1" })).toEqual([]);
    expect(await getAuditLog(db, { groupId: "g2" })).toEqual([]);
    expect((await getAuditLog(db)).map((e) => e.groupId ?? null)).toEqual([null, "g9"]);
  });

  it("records and loads entries newest-first", async () => {
    await recordAudit(db, {
      ts: 1000,
      actorId: "1",
      actorLogin: "a",
      action: "group.create",
      targetType: "group",
      targetId: "g1",
      groupId: "g1",
    });
    await recordAudit(db, {
      ts: 2000,
      actorId: "2",
      actorLogin: "b",
      action: "invite.create",
      groupId: "g2",
      detail: { role: "viewer" },
    });
    const entries = await getAuditLog(db, { limit: 10 });
    expect(entries).toHaveLength(2);
    expect(entries[0]!.action).toBe("invite.create");
    expect(entries[0]!.detail).toEqual({ role: "viewer" });
    expect(entries[1]!.actorLogin).toBe("a");
  });

  it("filters by group", async () => {
    await recordAudit(db, { ts: 1, actorLogin: "a", action: "x", groupId: "g1" });
    await recordAudit(db, { ts: 2, actorLogin: "b", action: "y", groupId: "g2" });
    const entries = await getAuditLog(db, { groupId: "g2" });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("y");
  });

  it("filters by a set of groups before applying the limit", async () => {
    await recordAudit(db, { ts: 1, actorLogin: "a", action: "mine", groupId: "g1" });
    for (let i = 0; i < 5; i++) {
      await recordAudit(db, { ts: 10 + i, actorLogin: "b", action: "other", groupId: "g2" });
    }
    const entries = await getAuditLog(db, { groupId: ["g1", "g3"], limit: 2 });
    expect(entries.map((e) => e.action)).toEqual(["mine"]);
    expect(await getAuditLog(db, { groupId: [] })).toEqual([]);
  });

  it("prunes entries older than the retention window", async () => {
    const now = Date.now();
    await recordAudit(db, { ts: now - 100 * 86400_000, actorLogin: "a", action: "old" });
    await recordAudit(db, { ts: now, actorLogin: "b", action: "new" });
    const removed = await pruneAuditLogs(db, 90);
    expect(removed).toBe(1);
    expect(await getAuditLog(db)).toHaveLength(1);
  });

  it("never throws on write failures", async () => {
    const broken = {
      prepare: (): { bind: () => { run: () => Promise<unknown> } } => ({
        bind: () => ({
          run: async (): Promise<never> => {
            throw new Error("boom");
          },
        }),
      }),
    } as unknown as D1Database;
    await expect(recordAudit(broken, { ts: 1, action: "x" })).resolves.toBeUndefined();
  });
});
