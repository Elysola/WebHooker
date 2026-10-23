import { describe, it, expect, beforeEach } from "bun:test";
import {
  adminGroupRename,
  adminGroupRoutesGet,
  adminApiGroupsPut,
  adminApiMe,
} from "../server/lib/web/admin";
import { createAdminSession, adminCookie } from "../server/lib/web/session";
import { loadGroups, invalidateGroupsCache } from "../server/lib/web/groups";
import { loadRoutes } from "../server/lib/config";
import { createInvite, listInvites } from "../server/lib/web/invites";
import { getTenantSecret } from "../server/lib/web/tenants";
import { makeEvent, responseStatus } from "./helpers";
import type { Env, Route } from "../server/lib/types";

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

function createMockDB(): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        run: async () => ({ success: true }),
        all: async () => ({ results: [] }),
      }),
    }),
  } as unknown as D1Database;
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_WEBHOOK_SECRET: "secret",
    KV: createMockKV(),
    DB: createMockDB(),
    ...overrides,
  };
}

describe("admin handlers (h3)", () => {
  beforeEach(() => invalidateGroupsCache());

  it("renames an owned group and follows routes, secret and invites", async () => {
    const kv = createMockKV();
    await kv.put(
      "config:groups",
      JSON.stringify([
        {
          id: "old-team",
          name: "Old Team",
          adminIds: [],
          members: [{ login: "alice", role: "owner" }],
        },
      ]),
    );
    await kv.put(
      "config:routes",
      JSON.stringify([
        {
          id: "r1",
          name: "R1",
          enabled: true,
          groupId: "old-team",
          filters: [{ type: "event", match: "push" }],
          targets: [{ channelId: "111" }],
        },
      ] as Route[]),
    );
    // A secret stored before group instances existed (keyed by group id).
    const originalSecret = "legacy-secret";
    await kv.put("tenant:old-team", originalSecret);
    await createInvite(kv, {
      groupId: "old-team",
      role: "viewer",
      expiresAt: Date.now() + 86400_000,
      createdBy: "alice",
    });
    const env = createEnv({ KV: kv });
    const sessionId = await createAdminSession(kv, "1001", "alice");

    const event = makeEvent("/api/groups/old-team/rename", {
      method: "PUT",
      headers: { cookie: adminCookie(sessionId), "content-type": "application/json" },
      body: JSON.stringify({ newId: "new-team" }),
      env,
    });
    const result = (await adminGroupRename(event, "old-team")) as { ok?: boolean };
    expect(responseStatus(event)).toBe(200);
    expect(result.ok).toBe(true);

    const groups = await loadGroups(kv);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.id).toBe("new-team");
    expect(groups[0]!.name).toBe("Old Team");

    const routes = await loadRoutes(kv);
    expect(routes[0]!.groupId).toBe("new-team");

    // The secret follows the group (it is keyed by the group's instance).
    expect(await getTenantSecret(kv, groups[0]!)).toBe(originalSecret);

    const invites = await listInvites(kv, "new-team");
    expect(invites).toHaveLength(1);
    expect(invites[0]!.groupId).toBe("new-team");
    expect(await listInvites(kv, "old-team")).toHaveLength(0);
  });

  it("accepts a groups PUT without the application/json content-type", async () => {
    const kv = createMockKV();
    await kv.put(
      "config:groups",
      JSON.stringify([
        { id: "team", name: "Team", adminIds: [], members: [{ login: "alice", role: "owner" }] },
      ]),
    );
    const env = createEnv({ KV: kv });
    const sessionId = await createAdminSession(kv, "1001", "alice");

    // The console's fetch helper always declares application/json, but curl
    // and older clients may omit it — h3's readBody then returns the raw
    // string, which used to fail validation with "groups must be an array".
    const event = makeEvent("/api/groups", {
      method: "PUT",
      headers: { cookie: adminCookie(sessionId) },
      body: JSON.stringify({
        groups: [
          {
            id: "team",
            name: "Team",
            adminIds: [],
            members: [{ login: "alice", role: "owner" }],
            forgeSources: [{ host: "git.example.com", type: "gitea", name: "内网 Gitea" }],
          },
        ],
      }),
      env,
    });
    const result = (await adminApiGroupsPut(event)) as { ok?: boolean };
    expect(responseStatus(event)).toBe(200);
    expect(result.ok).toBe(true);
    const groups = await loadGroups(kv);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.forgeSources).toEqual([
      { host: "git.example.com", type: "gitea", name: "内网 Gitea" },
    ]);
  });

  it("forbids non-owner members from renaming", async () => {
    const kv = createMockKV();
    await kv.put(
      "config:groups",
      JSON.stringify([
        { id: "team", name: "Team", adminIds: [], members: [{ login: "bob", role: "admin" }] },
      ]),
    );
    const env = createEnv({ KV: kv });
    const sessionId = await createAdminSession(kv, "2002", "bob");

    const event = makeEvent("/api/groups/team/rename", {
      method: "PUT",
      headers: { cookie: adminCookie(sessionId), "content-type": "application/json" },
      body: JSON.stringify({ newId: "new-team" }),
      env,
    });
    await adminGroupRename(event, "team");
    expect(responseStatus(event)).toBe(403);
  });

  it("rejects invalid, duplicate or unchanged ids", async () => {
    const kv = createMockKV();
    await kv.put(
      "config:groups",
      JSON.stringify([
        { id: "team", name: "Team", adminIds: [], members: [{ login: "alice", role: "owner" }] },
        { id: "other", name: "Other", adminIds: [] },
      ]),
    );
    const env = createEnv({ KV: kv });
    const sessionId = await createAdminSession(kv, "1001", "alice");

    const make = (newId: string) => {
      const event = makeEvent("/api/groups/team/rename", {
        method: "PUT",
        headers: { cookie: adminCookie(sessionId), "content-type": "application/json" },
        body: JSON.stringify({ newId }),
        env,
      });
      return adminGroupRename(event, "team").then(() => responseStatus(event));
    };

    expect(await make("Bad ID!")).toBe(400);
    expect(await make("team")).toBe(400);
    expect(await make("other")).toBe(400);
  });

  it("returns 401 without a session", async () => {
    const env = createEnv();
    const event = makeEvent("/api/groups/team/rename", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newId: "new-team" }),
      env,
    });
    await expect(adminGroupRename(event, "team")).rejects.toMatchObject({ statusCode: 401 });
  });

  it("returns 404 for an unknown group", async () => {
    const kv = createMockKV();
    await kv.put(
      "config:groups",
      JSON.stringify([
        { id: "mine", name: "Mine", adminIds: [], members: [{ login: "alice", role: "owner" }] },
      ]),
    );
    const env = createEnv({ KV: kv });
    const sessionId = await createAdminSession(kv, "1001", "alice");

    const event = makeEvent("/api/groups/nope/rename", {
      method: "PUT",
      headers: { cookie: adminCookie(sessionId), "content-type": "application/json" },
      body: JSON.stringify({ newId: "new-team" }),
      env,
    });
    const result = (await adminGroupRename(event, "nope")) as { error?: string };
    expect(responseStatus(event)).toBe(404);
    expect(result.error).toBe("Group not found");
  });

  it("me and group routes scoping work", async () => {
    const kv = createMockKV();
    await kv.put(
      "config:groups",
      JSON.stringify([
        { id: "mine", name: "Mine", adminIds: [], members: [{ login: "alice", role: "owner" }] },
        { id: "theirs", name: "Theirs", adminIds: [], members: [{ login: "bob", role: "owner" }] },
      ]),
    );
    await kv.put(
      "config:routes",
      JSON.stringify([
        {
          id: "mine-r",
          name: "Mine R",
          enabled: true,
          groupId: "mine",
          filters: [{ type: "event", match: "push" }],
          targets: [{ channelId: "111" }],
        },
      ] as Route[]),
    );
    const env = createEnv({ KV: kv });
    const sessionId = await createAdminSession(kv, "1001", "alice");

    const meEvent = makeEvent("/api/me", { headers: { cookie: adminCookie(sessionId) }, env });
    const me = (await adminApiMe(meEvent)) as { groups?: Array<{ id: string }>; isSuper?: boolean };
    expect(me.groups?.map((g) => g.id)).toEqual(["mine"]);
    expect(me.isSuper).toBe(false);

    const routesEvent = makeEvent("/api/groups/mine/routes", {
      headers: { cookie: adminCookie(sessionId) },
      env,
    });
    const groupRoutes = (await adminGroupRoutesGet(routesEvent, "mine")) as {
      routes?: Array<{ id: string }>;
    };
    expect(groupRoutes.routes?.map((r) => r.id)).toEqual(["mine-r"]);
  });
});
