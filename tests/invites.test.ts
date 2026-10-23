import { describe, it, expect, beforeEach } from "bun:test";
import {
  createInvite,
  getInvite,
  listInvites,
  revokeInvite,
  consumeInvite,
  acceptInvite,
  INVITE_LIFETIME_MS,
} from "../server/lib/web/invites";
import { createSqliteD1, createMemoryKV } from "./d1-sqlite";
import { saveGroups, loadGroups, invalidateGroupsCache } from "../server/lib/web/groups";
import type { Group } from "../server/lib/types";

function createMockKV(): KVNamespace {
  const store = new Map<string, { value: string; expiration?: number }>();
  return {
    get: async (key: string, type?: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiration && Date.now() / 1000 > entry.expiration) {
        store.delete(key);
        return null;
      }
      if (type === "json") return JSON.parse(entry.value);
      return entry.value;
    },
    put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      const expiration = opts?.expirationTtl ? Date.now() / 1000 + opts.expirationTtl : undefined;
      store.set(key, { value, expiration });
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

const group: Group = {
  id: "team",
  name: "Team",
  adminIds: ["boss"],
  members: [{ login: "boss", role: "owner" }],
};

describe("invites", () => {
  let kv: KVNamespace;
  let env: { KV: KVNamespace; DB: D1Database };

  beforeEach(() => {
    kv = createMockKV();
    env = { KV: kv, DB: {} as D1Database };
    invalidateGroupsCache();
  });

  it("creates and reads back an invite", async () => {
    const token = await createInvite(kv, {
      groupId: "team",
      role: "admin",
      expiresAt: Date.now() + 86400_000,
      createdBy: "boss",
    });
    const invite = await getInvite(kv, token);
    expect(invite).toMatchObject({ groupId: "team", role: "admin", createdBy: "boss" });
  });

  it("lists pending invites of a group only", async () => {
    await createInvite(kv, {
      groupId: "team",
      role: "viewer",
      expiresAt: Date.now() + 86400_000,
      createdBy: "boss",
    });
    await createInvite(kv, {
      groupId: "other",
      role: "viewer",
      expiresAt: Date.now() + 86400_000,
      createdBy: "boss",
    });
    const invites = await listInvites(kv, "team");
    expect(invites).toHaveLength(1);
    expect(invites[0]!.groupId).toBe("team");
  });

  it("hides invites an earlier group under the same id left behind, without revoking them", async () => {
    const old = await createInvite(kv, {
      groupId: "team",
      role: "admin",
      expiresAt: Date.now() + 86400_000,
      createdBy: "former",
      groupInstance: "former-instance",
    });
    const legacy = await createInvite(kv, {
      groupId: "team",
      role: "viewer",
      expiresAt: Date.now() + 86400_000,
      createdBy: "former",
    });
    const mine = await createInvite(kv, {
      groupId: "team",
      role: "viewer",
      expiresAt: Date.now() + 86400_000,
      createdBy: "boss",
      groupInstance: "current",
    });
    // A group created after instances existed: neither older invite is its own.
    const listed = await listInvites(kv, "team", { instance: "current" });
    expect(listed.map((i) => i.token)).toEqual([mine]);
    // Their issuer may live on under another id: not this group's to revoke.
    expect(await getInvite(kv, old)).not.toBeNull();
    expect(await getInvite(kv, legacy)).not.toBeNull();
    expect((await listInvites(kv, "team", { instance: "current" })).map((i) => i.token)).toEqual([
      mine,
    ]);
  });

  it("still lists a renamed group's invites whose move to the new id failed", async () => {
    const token = await createInvite(kv, {
      groupId: "old",
      role: "viewer",
      expiresAt: Date.now() + 86400_000,
      createdBy: "boss",
      groupInstance: "inst-1",
    });
    // Renamed to "new"; moving the invite failed, it still names "old".
    const listed = await listInvites(kv, "new", { instance: "inst-1" });
    expect(listed.map((i) => i.token)).toEqual([token]);
  });

  it("revokes an invite", async () => {
    const token = await createInvite(kv, {
      groupId: "team",
      role: "viewer",
      expiresAt: Date.now() + 86400_000,
      createdBy: "boss",
    });
    await revokeInvite(kv, token);
    expect(await getInvite(kv, token)).toBeNull();
  });

  it("accept adds the user as a member and consumes the token", async () => {
    await saveGroups(kv, [group]);
    const token = await createInvite(kv, {
      groupId: "team",
      role: "admin",
      expiresAt: Date.now() + 86400_000,
      createdBy: "boss",
    });
    const result = await acceptInvite(env, token, "777", "newbie");
    expect(result).toEqual({
      ok: true,
      groupId: "team",
      groupInstance: expect.any(String),
      role: "admin",
    });
    expect(await getInvite(kv, token)).toBeNull();
    const groups = await loadGroups(kv);
    expect(groups[0]!.members).toContainEqual({ login: "newbie", role: "admin", userId: "777" });
    // adminIds stays in sync with owners only.
    expect(groups[0]!.adminIds).toEqual(["boss"]);
  });

  it("refuses (and keeps the invite) when the login is on a member bound to another account", async () => {
    await saveGroups(kv, [
      {
        ...group,
        members: [
          { login: "boss", role: "owner" },
          // A member who renamed since; "newbie" now belongs to someone else.
          { login: "newbie", role: "viewer", userId: "42" },
        ],
      },
    ]);
    const token = await createInvite(kv, {
      groupId: "team",
      role: "admin",
      expiresAt: Date.now() + 86400_000,
      createdBy: "boss",
    });
    expect(await acceptInvite(env, token, "777", "newbie")).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(await getInvite(kv, token)).not.toBeNull();
  });

  it("upgrades an existing viewer to admin", async () => {
    await saveGroups(kv, [
      {
        ...group,
        members: [
          { login: "boss", role: "owner" },
          { login: "newbie", role: "viewer" },
        ],
      },
    ]);
    const token = await createInvite(kv, {
      groupId: "team",
      role: "admin",
      expiresAt: Date.now() + 86400_000,
      createdBy: "boss",
    });
    await acceptInvite(env, token, "777", "newbie");
    const groups = await loadGroups(kv);
    expect(groups[0]!.members).toContainEqual({ login: "newbie", role: "admin", userId: "777" });
  });

  it("lets only one of two concurrent accepts use the invite", async () => {
    const { db } = createSqliteD1();
    const shared = { KV: kv, DB: db };
    await saveGroups(kv, [group]);
    const token = await createInvite(kv, {
      groupId: "team",
      role: "admin",
      expiresAt: Date.now() + INVITE_LIFETIME_MS,
      createdBy: "boss",
    });
    const results = await Promise.all([
      acceptInvite(shared, token, "1", "first"),
      acceptInvite(shared, token, "2", "second"),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const members = (await loadGroups(kv))[0]!.members!.map((m) => m.login);
    expect(members.filter((m) => m === "first" || m === "second")).toHaveLength(1);
  });

  it("keeps an invite's KV key for its whole seven-day lifetime", async () => {
    const ttls = new Map<string, number>();
    const put = kv.put.bind(kv);
    (kv as { put: unknown }).put = async (
      key: string,
      value: string,
      opts?: { expirationTtl?: number },
    ): Promise<void> => {
      ttls.set(key, opts?.expirationTtl ?? 0);
      await put(key, value, opts);
    };
    const token = await createInvite(kv, {
      groupId: "team",
      role: "viewer",
      expiresAt: Date.now() + INVITE_LIFETIME_MS,
      createdBy: "boss",
    });
    expect(ttls.get(`invite:${token}`)).toBeGreaterThan(6 * 86400);
    expect(ttls.get("invite:group:team")).toBeGreaterThan(6 * 86400);
  });

  it("rejects expired or unknown invites", async () => {
    await saveGroups(kv, [group]);
    const token = await createInvite(kv, {
      groupId: "team",
      role: "viewer",
      expiresAt: Date.now() - 1000,
      createdBy: "boss",
    });
    expect(await acceptInvite(env, token, "1", "x")).toEqual({ ok: false, reason: "invalid" });
    expect(await acceptInvite(env, "deadbeef", "1", "x")).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects invites for missing groups", async () => {
    await saveGroups(kv, []);
    const token = await createInvite(kv, {
      groupId: "ghost",
      role: "viewer",
      expiresAt: Date.now() + 86400_000,
      createdBy: "boss",
    });
    expect(await acceptInvite(env, token, "1", "x")).toEqual({
      ok: false,
      reason: "group-missing",
    });
    // The failed attempt gave the invite back.
    await saveGroups(kv, [{ ...group, id: "ghost" }]);
    expect(await acceptInvite(env, token, "1", "x")).toMatchObject({ ok: true });
  });
});

describe("invite listing quota", () => {
  it("writes nothing to KV when listing after an invite was used", async () => {
    const { kv } = createMemoryKV();
    const group = { instance: "i1" };
    const token = await createInvite(kv, {
      groupId: "g",
      role: "viewer",
      expiresAt: Date.now() + INVITE_LIFETIME_MS,
      createdBy: "1",
      groupInstance: "i1",
    });
    await consumeInvite(kv, token);
    let writes = 0;
    const put = kv.put.bind(kv);
    const del = kv.delete.bind(kv);
    kv.put = ((...args: Parameters<KVNamespace["put"]>) => {
      writes++;
      return put(...args);
    }) as KVNamespace["put"];
    kv.delete = ((key: string) => {
      writes++;
      return del(key);
    }) as KVNamespace["delete"];
    for (let i = 0; i < 3; i++) expect(await listInvites(kv, "g", group)).toEqual([]);
    expect(writes).toBe(0);
  });
});
