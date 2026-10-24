import { describe, it, expect, beforeEach } from "bun:test";
import {
  isAdminUser,
  isDebugMode,
  createAdminSession,
  getAdminSession,
  destroyAdminSession,
  adminCookie,
  clearAdminCookie,
} from "../server/lib/web/session";
import {
  groupAcceptsProvider,
  groupAcceptsInstallation,
  ensureInstallationGroup,
  loadGroups,
  saveGroups,
  invalidateGroupsCache,
} from "../server/lib/web/groups";
import { validateGroups } from "../server/lib/web/admin";
import {
  getTenantSecret,
  setTenantSecret,
  deleteTenantSecret,
  generateTenantSecret,
} from "../server/lib/web/tenants";
import { loadRoutes, saveRoutes, loadConfig } from "../server/lib/config";
import type { Env, Route, Group } from "../server/lib/types";

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

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_WEBHOOK_SECRET: "secret",
    KV: createMockKV(),
    ...overrides,
  };
}

const sampleRoutes: Route[] = [
  {
    id: "backend-prs",
    name: "Backend PRs",
    enabled: true,
    filters: [{ type: "event", match: "pull_request" }],
    targets: [{ channelId: "111" }],
  },
];

describe("isAdminUser", () => {
  it("enables the bypass only for the exact true value", () => {
    expect(isDebugMode(createEnv({ DEBUG_MODE: "true" }))).toBe(true);
    expect(isDebugMode(createEnv({ DEBUG_MODE: "TRUE" }))).toBe(false);
    expect(isAdminUser(createEnv({ DEBUG_MODE: "true" }), "99999", "someone")).toBe(true);
  });

  it("allows matching user id", () => {
    const env = createEnv({ ADMIN_USER_IDS: "12345,67890" });
    expect(isAdminUser(env, "12345", "other")).toBe(true);
  });

  it("allows matching login case-insensitively", () => {
    const env = createEnv({ ADMIN_USER_IDS: "RhenCloud" });
    expect(isAdminUser(env, "1", "rhencloud")).toBe(true);
  });

  it("rejects non-admin users", () => {
    const env = createEnv({ ADMIN_USER_IDS: "12345" });
    expect(isAdminUser(env, "99999", "someone")).toBe(false);
  });

  it("rejects when whitelist is empty", () => {
    const env = createEnv();
    expect(isAdminUser(env, "12345", "rhencloud")).toBe(false);
  });
});

describe("admin-session", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = createMockKV();
    invalidateGroupsCache();
  });

  it("creates and retrieves a session from cookie", async () => {
    const sessionId = await createAdminSession(kv, "12345", "rhencloud");
    const session = await getAdminSession(kv, adminCookie(sessionId));
    expect(session).toEqual({ userId: "12345", login: "rhencloud" });
  });

  it("returns null without a cookie", async () => {
    expect(await getAdminSession(kv, undefined)).toBeNull();
  });

  it("returns null for unknown session id", async () => {
    expect(await getAdminSession(kv, "wh_admin_session=nope")).toBeNull();
  });

  it("destroys a session", async () => {
    const sessionId = await createAdminSession(kv, "12345", "rhencloud");
    await destroyAdminSession(kv, adminCookie(sessionId));
    expect(await getAdminSession(kv, adminCookie(sessionId))).toBeNull();
  });

  it("clear cookie is an expired cookie", () => {
    expect(clearAdminCookie()).toContain("wh_admin_session=;");
    expect(clearAdminCookie()).toContain("Max-Age=0");
  });
});

describe("groupAcceptsProvider", () => {
  const base: Group = { id: "g", name: "G", adminIds: [] };

  it("accepts every provider when none are configured", () => {
    expect(groupAcceptsProvider(base, "github")).toBe(true);
    expect(groupAcceptsProvider(base, "gitea")).toBe(true);
    expect(groupAcceptsProvider(base, undefined)).toBe(true);
  });

  it("restricts to the configured providers", () => {
    expect(groupAcceptsProvider({ ...base, providers: ["gitea"] }, "gitea")).toBe(true);
    expect(groupAcceptsProvider({ ...base, providers: ["gitea"] }, "github")).toBe(false);
    expect(groupAcceptsProvider({ ...base, providers: ["gitea"] }, undefined)).toBe(false);
  });

  it("matches case-insensitively and trims whitespace", () => {
    expect(groupAcceptsProvider({ ...base, providers: [" Gitea "] }, "gitea")).toBe(true);
  });
});

describe("validateGroups logTarget", () => {
  const baseGroup = {
    id: "g",
    name: "G",
    members: [{ login: "boss", role: "owner" }],
  };

  it("accepts and normalizes a discord log target", () => {
    const res = validateGroups([
      {
        ...baseGroup,
        logTarget: { platform: "discord", channelId: "111", threadId: "222" },
      },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.groups[0]!.logTarget).toEqual({
        platform: "discord",
        channelId: "111",
        threadId: "222",
        chatId: undefined,
        topicId: undefined,
      });
    }
  });

  it("accepts a telegram log target", () => {
    const res = validateGroups([
      {
        ...baseGroup,
        logTarget: { platform: "telegram", chatId: "-100123", topicId: "999" },
      },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.groups[0]!.logTarget).toEqual({
        platform: "telegram",
        channelId: undefined,
        threadId: undefined,
        chatId: "-100123",
        topicId: "999",
      });
    }
  });

  it("rejects a log target without a channel id", () => {
    const res = validateGroups([
      { ...baseGroup, logTarget: { platform: "discord", channelId: "" } },
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("logTarget.channelId");
  });

  it("rejects a log target with an unknown platform", () => {
    const res = validateGroups([{ ...baseGroup, logTarget: { platform: "slack" } }]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("logTarget.platform");
  });

  it("drops a null log target", () => {
    const res = validateGroups([{ ...baseGroup, logTarget: null }]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.groups[0]!.logTarget).toBeUndefined();
  });
});

describe("validateGroups installationId", () => {
  const baseGroup = {
    id: "g",
    name: "G",
    members: [{ login: "boss", role: "owner" }],
  };

  it("accepts a positive integer installation id", () => {
    const res = validateGroups([{ ...baseGroup, installationId: 42 }]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.groups[0]!.installationId).toBe(42);
  });

  it("rejects non-integer installation ids", () => {
    expect(validateGroups([{ ...baseGroup, installationId: "42" }]).ok).toBe(false);
    expect(validateGroups([{ ...baseGroup, installationId: 42.5 }]).ok).toBe(false);
  });

  it("drops a null installation id", () => {
    const res = validateGroups([{ ...baseGroup, installationId: null }]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.groups[0]!.installationId).toBeUndefined();
  });
});

describe("groupAcceptsInstallation", () => {
  const base: Group = { id: "g", name: "G", adminIds: [] };

  it("accepts everything when the group is not bound to an installation", () => {
    expect(groupAcceptsInstallation(base, 101)).toBe(true);
    expect(groupAcceptsInstallation(base, undefined)).toBe(true);
  });

  it("only accepts events from the bound installation", () => {
    const bound = { ...base, installationId: 101 };
    expect(groupAcceptsInstallation(bound, 101)).toBe(true);
    expect(groupAcceptsInstallation(bound, 202)).toBe(false);
    expect(groupAcceptsInstallation(bound, undefined)).toBe(false);
  });
});

describe("ensureInstallationGroup", () => {
  it("creates an inst-{id} group when nothing is bound", async () => {
    const kv = createMockKV();
    const group = await ensureInstallationGroup(kv, 555, "myorg");
    expect(group?.id).toBe("inst-555");
    expect(group?.installationId).toBe(555);
    expect(group?.name).toBe("myorg");
    const groups = await loadGroups(kv);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.installationId).toBe(555);
  });

  it("binds existing groups whose owners match the installing account", async () => {
    const kv = createMockKV();
    await saveGroups(kv, [
      { id: "backend", name: "Backend", adminIds: [], owners: ["myorg"], members: [] },
      { id: "other", name: "Other", adminIds: [], owners: ["another-org"], members: [] },
    ]);
    await ensureInstallationGroup(kv, 555, "MyOrg");
    const groups = await loadGroups(kv);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.id === "backend")?.installationId).toBe(555);
    expect(groups.find((g) => g.id === "other")?.installationId).toBeUndefined();
    expect(groups.some((g) => g.id.startsWith("inst-"))).toBe(false);
  });

  it("is idempotent when a group is already bound", async () => {
    const kv = createMockKV();
    await ensureInstallationGroup(kv, 555, "myorg");
    await ensureInstallationGroup(kv, 555, "myorg");
    expect((await loadGroups(kv)).filter((g) => g.installationId === 555)).toHaveLength(1);
  });
});

describe("tenant webhook secrets", () => {
  const G1 = { id: "g1", instance: "inst-g1" };

  it("never lets a group created later adopt a secret left under its id", async () => {
    const kv = createMockKV();
    await kv.put("tenant:g1", "old-secret");
    expect(await getTenantSecret(kv, G1)).toBeNull();
    // The group that had the id before instances still uses its old secret,
    // under whatever id it has now — and without copying it anywhere.
    expect(await getTenantSecret(kv, { ...G1, id: "moved", legacyId: "g1" })).toBe("old-secret");
    // A pre-instance group renamed to the id later never adopts it.
    expect(await getTenantSecret(kv, { ...G1, legacyId: "other" })).toBeNull();
    expect(await kv.get("tenant:i:" + G1.instance)).toBeNull();
  });

  it("generates 64-char hex secrets", () => {
    const s = generateTenantSecret();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
  });

  it("creates, reads, and deletes a tenant secret", async () => {
    const kv = createMockKV();
    expect(await getTenantSecret(kv, G1)).toBeNull();
    const secret = await setTenantSecret(kv, G1);
    expect(await getTenantSecret(kv, G1)).toBe(secret);
    await deleteTenantSecret(kv, G1);
    expect(await getTenantSecret(kv, G1)).toBeNull();
  });

  it("regenerating replaces the previous secret", async () => {
    const kv = createMockKV();
    const a = await setTenantSecret(kv, G1);
    const b = await setTenantSecret(kv, G1);
    expect(a).not.toBe(b);
    expect(await getTenantSecret(kv, G1)).toBe(b);
  });
});

describe("config routes persistence", () => {
  it("saves and loads routes from KV", async () => {
    const kv = createMockKV();
    await saveRoutes(kv, sampleRoutes);
    expect(await loadRoutes(kv)).toEqual(sampleRoutes);
  });

  it("returns empty routes when KV is empty", async () => {
    const kv = createMockKV();
    const routes = await loadRoutes(kv);
    expect(routes).toHaveLength(0);
  });

  it("loadConfig picks up saved routes after cache invalidation", async () => {
    const env = createEnv();
    const first = await loadConfig(env);
    expect(first.routes).toHaveLength(0);

    await saveRoutes(env.KV, sampleRoutes);
    const second = await loadConfig(env);
    expect(second.routes).toHaveLength(1);
    expect(second.routes[0]!.id).toBe("backend-prs");
    expect(second.routes[0]!.targets[0]!.channelId).toBe("111");
  });
});
