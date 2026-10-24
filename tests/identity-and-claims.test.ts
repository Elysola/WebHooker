import { describe, it, expect } from "bun:test";
import { isAdminUser } from "../server/lib/web/session";
import { createAdminSession, adminCookie } from "../server/lib/web/session";
import {
  bindMemberIds,
  carryMemberIds,
  loadGroups,
  memberRole,
  saveGroups,
} from "../server/lib/web/groups";
import { adminApiGroupsGet, adminGroupDelete, adminGroupRoutesGet } from "../server/lib/web/admin";
import { saveGroupRoutes, resetConfigStore } from "../server/lib/config";
import { createInvite, listInvites } from "../server/lib/web/invites";
import {
  claimOnce,
  confirmClaim,
  deliveryKey,
  idempotencyStore,
} from "../server/lib/lib/idempotency";
import { handleTelegramUpdate } from "../server/lib/drivers/telegram/commands";
import { kvFallbackActive, noteKvFallback } from "../server/lib/storage/d1";
import { d1ConfigStore } from "../server/lib/storage/config-store";
import { makeEvent, responseStatus } from "./helpers";
import { createMemoryKV, createSqliteD1 } from "./d1-sqlite";
import type { Env, Group, Route } from "../server/lib/types";

const route = (id: string, groupId: string): Route => ({
  id,
  name: id,
  enabled: true,
  filters: [{ type: "event", match: "push" }],
  targets: [{ platform: "discord", channelId: "c1" }],
  groupId,
});

describe("member identity", () => {
  it("never matches one configured string both as a user id and as a login", () => {
    const env = { ADMIN_USER_IDS: "123, alice" } as Env;
    // User id 123 is the admin; a different account whose login is "123" is not.
    expect(isAdminUser(env, "123", "someone")).toBe(true);
    expect(isAdminUser(env, "999", "123")).toBe(false);
    expect(isAdminUser(env, "5", "ALICE")).toBe(true);
  });

  it("matches a bound member by user id only, so a reclaimed login inherits nothing", () => {
    const group: Group = {
      id: "g",
      name: "G",
      adminIds: [],
      members: [{ login: "alice", role: "owner", userId: "42" }],
    };
    expect(memberRole(group, "42", "alice-renamed")).toBe("owner");
    // Someone who took over the old login after a rename.
    expect(memberRole(group, "77", "alice")).toBeUndefined();
  });

  it("binds a member's user id on sign-in and keeps it across member edits", async () => {
    const { kv } = createMemoryKV();
    resetConfigStore(kv);
    await saveGroups(kv, [
      {
        id: "g",
        name: "G",
        adminIds: [],
        members: [
          { login: "alice", role: "owner" },
          { login: "bob", role: "viewer" },
        ],
      },
    ]);
    await bindMemberIds(kv, await loadGroups(kv, { fresh: true }), "42", "Alice");
    const stored = (await loadGroups(kv, { fresh: true }))[0]!;
    expect(stored.members).toEqual([
      { login: "alice", role: "owner", userId: "42" },
      { login: "bob", role: "viewer" },
    ]);
    // A client edit (which never carries ids) keeps the binding.
    const edited = carryMemberIds(
      {
        ...stored,
        members: [
          { login: "alice", role: "owner" },
          { login: "bob", role: "admin" },
        ],
      },
      stored,
    );
    expect(edited.members![0]).toEqual({ login: "alice", role: "owner", userId: "42" });
  });
});

describe("group deletion", () => {
  it("refuses to delete a group whose routes changed after the deletion was confirmed", async () => {
    const { kv } = createMemoryKV();
    resetConfigStore(kv);
    await saveGroups(kv, [
      { id: "g", name: "G", adminIds: [], members: [{ login: "alice", role: "owner" }] },
    ]);
    const env = { GITHUB_WEBHOOK_SECRET: "", KV: kv, DB: {} as D1Database } as Env;
    const sessionId = await createAdminSession(kv, "42", "alice");
    const headers = { cookie: adminCookie(sessionId) };
    const view = makeEvent("/admin/api/groups/g/routes", { headers, env });
    const { revision } = (await adminGroupRoutesGet(view, "g")) as { revision: string };
    const listed = (await adminApiGroupsGet(makeEvent("/admin/api/groups", { headers, env }))) as {
      groups: Array<{ revision: string }>;
    };
    const groupRev = listed.groups[0]!.revision;
    // Someone adds a route after the owner saw an empty group.
    await saveGroupRoutes(kv, "g", [route("r1", "g")]);
    const del = makeEvent(`/admin/api/groups/g?revision=${groupRev}&routesRevision=${revision}`, {
      method: "DELETE",
      headers,
      env,
    });
    await adminGroupDelete(del, "g");
    expect(responseStatus(del)).toBe(409);
    expect((await loadGroups(kv, { fresh: true })).map((g) => g.id)).toEqual(["g"]);
  });
});

describe("one-time claims", () => {
  it("tells a confirmed run from one left unconfirmed", async () => {
    const { kv } = createMemoryKV();
    const store = idempotencyStore({} as D1Database, kv);
    expect(await claimOnce(store, "k", 60)).toBe("claimed");
    expect(await claimOnce(store, "k", 60)).toBe("pending");
    await confirmClaim(store, "k", 600);
    expect(await claimOnce(store, "k", 60)).toBe("done");
    // A delivery id crafted to look like a confirmation never passes for one.
    await confirmClaim(store, deliveryKey("custom", "g", "x#accepted"), 600);
    await confirmClaim(store, deliveryKey("custom", "g", "accepted:x"), 600);
    expect(await claimOnce(store, deliveryKey("custom", "g", "x"), 60)).toBe("claimed");
  });

  it("makes Telegram redeliver an update whose earlier run is unconfirmed", async () => {
    const { kv } = createMemoryKV();
    const env = { GITHUB_WEBHOOK_SECRET: "", KV: kv, DB: {} as D1Database } as Env;
    // An earlier run took the update and could neither finish nor give it back.
    await idempotencyStore(env.DB, kv).claim("bot:telegram::7", 300);
    const update = { update_id: 7, message: { text: "/gh", chat: { id: 1 } } };
    expect(handleTelegramUpdate(env, update)).rejects.toThrow();
  });
});

describe("invite listing", () => {
  it("lists both of two invites whose index writes overwrote each other", async () => {
    const { kv } = createMemoryKV();
    const invite = {
      groupId: "team",
      role: "viewer" as const,
      expiresAt: Date.now() + 86400_000,
      createdBy: "boss",
    };
    const a = await createInvite(kv, invite);
    const b = await createInvite(kv, invite);
    // The second creation read the index before the first wrote it.
    await kv.put("invite:group:team", JSON.stringify([b]));
    expect((await listInvites(kv, "team")).map((i) => i.token).sort()).toEqual([a, b].sort());
  });
});

describe("storage fallbacks", () => {
  it("retries the KV fallback marker until it is actually stored", async () => {
    const { kv, store } = createMemoryKV();
    const put = kv.put.bind(kv);
    let failing = true;
    kv.put = async (key: string, value: string, opts?: KVNamespacePutOptions): Promise<void> => {
      if (failing) throw new Error("KV down");
      return put(key, value, opts);
    };
    await expect(noteKvFallback(kv)).rejects.toThrow();
    failing = false;
    await noteKvFallback(kv);
    expect(Number(store.get("storage:kv-fallback"))).toBeGreaterThan(Date.now());
    expect(await kvFallbackActive(kv)).toBe(true);
  });

  it("remembers KV-only state, so a D1 binding added later still honors it", async () => {
    const { kv, store } = createMemoryKV();
    const kvOnly = idempotencyStore({} as D1Database, kv);
    expect(await kvOnly.claim("delivery:github:@global:d9", 600)).toBe(true);
    expect(store.has("storage:kv-fallback")).toBe(true);
    // The deployment gets D1 (tables migrated) in a fresh isolate.
    const { db } = createSqliteD1();
    const { kv: sameKv } = { kv: { ...kv } as KVNamespace };
    expect(await idempotencyStore(db, sameKv).claim("delivery:github:@global:d9", 600)).toBe(false);
  });

  it("never re-seeds a configuration another isolate seeded and an admin emptied", async () => {
    const { db } = createSqliteD1();
    const { kv, store } = createMemoryKV();
    store.set("config:groups", JSON.stringify([{ id: "legacy", name: "L", adminIds: [] }]));
    store.set("config:routes", JSON.stringify([route("r1", "legacy")]));
    const first = d1ConfigStore(db, kv);
    expect((await first.loadGroups({ fresh: true })).map((g) => g.id)).toEqual(["legacy"]);
    await first.deleteGroup("legacy");
    // A second isolate that had already passed the KV marker check.
    store.delete("config:d1-seeded");
    const late = d1ConfigStore(db, kv);
    expect(await late.loadGroups({ fresh: true })).toEqual([]);
  });

  it("keeps listing invites when the index cannot be read, instead of dropping them", async () => {
    const { kv } = createMemoryKV();
    await createInvite(kv, {
      groupId: "team",
      role: "viewer",
      expiresAt: Date.now() + 86400_000,
      createdBy: "boss",
    });
    const get = kv.get.bind(kv);
    kv.get = (async (key: string, type?: never) => {
      if (key === "invite:group:team") throw new Error("KV down");
      return get(key, type);
    }) as typeof kv.get;
    await expect(
      createInvite(kv, {
        groupId: "team",
        role: "viewer",
        expiresAt: Date.now() + 86400_000,
        createdBy: "boss",
      }),
    ).rejects.toThrow();
    kv.get = get;
    // Neither invite is lost from the list: the half-created one is listed
    // through its own marker, so it can still be found and revoked.
    expect(await listInvites(kv, "team")).toHaveLength(2);
  });
});
