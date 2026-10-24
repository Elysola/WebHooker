import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import {
  handleOAuthStart,
  handleInstallPage,
  handleInstallBind,
  handleOAuthCallback,
  handleTokenDelete,
} from "../server/lib/web/oauth";
import { createAdminSession, adminCookie } from "../server/lib/web/session";
import { loadGroups, invalidateGroupsCache } from "../server/lib/web/groups";
import { getInstallationAccount } from "../server/lib/github/oauth";
import { saveToken } from "../server/lib/github/store";
import { makeEvent, responseStatus, responseHeader } from "./helpers";
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

/** App credentials, so the install flow can look the installation's account up. */
let appCredentials: Partial<Env> = {};

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_WEBHOOK_SECRET: "secret",
    KV: createMockKV(),
    DB: createMockDB(),
    ...appCredentials,
    ...overrides,
  };
}

/** The signed-in test user's role in the installation's organization. */
let orgRole = "admin";

/** GitHub API stub: the installation lookup and the user's org membership. */
function githubApiMock(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  const body = url.includes("/user/memberships/orgs/myorg")
    ? { state: "active", role: orgRole }
    : { id: 555, account: { login: "myorg", id: 9, type: "Organization" } };
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

/** A session for alice (GitHub id 1001) with a stored OAuth token. */
async function signIn(kv: KVNamespace): Promise<string> {
  await saveToken(kv, "1001", "gho_alice", 3600);
  return adminCookie(await createAdminSession(kv, "1001", "alice"));
}

function bufToPem(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  const b64 = btoa(s);
  return `-----BEGIN PRIVATE KEY-----\n${b64.replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----`;
}

async function makeAppKeyPair(): Promise<{ appId: string; pem: string }> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  return { appId: "12345", pem: bufToPem(pkcs8) };
}

describe("getInstallationAccount", () => {
  let calledUrls: string[];
  const restoredFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = restoredFetch;
  });

  function mockApi(status: number, body: unknown): void {
    calledUrls = [];
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calledUrls.push(String(input));
      void init;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    };
  }

  it("returns the installation account login using an App JWT", async () => {
    const { appId, pem } = await makeAppKeyPair();
    mockApi(200, { id: 555, account: { login: "myorg" } });
    const login = await getInstallationAccount(appId, pem, 555);
    expect(login).toBe("myorg");
    expect(calledUrls[0]).toContain("/app/installations/555");
  });

  it("returns null when the App credentials are missing", async () => {
    expect(await getInstallationAccount("", "", 555)).toBeNull();
  });

  it("returns null on API errors", async () => {
    const { appId, pem } = await makeAppKeyPair();
    mockApi(404, { message: "not found" });
    expect(await getInstallationAccount(appId, pem, 555)).toBeNull();
  });
});

describe("GET /auth/github/install", () => {
  const restoredFetch = globalThis.fetch;

  beforeAll(async () => {
    const { appId, pem } = await makeAppKeyPair();
    appCredentials = { GITHUB_APP_ID: appId, GITHUB_PRIVATE_KEY: pem };
  });

  beforeEach(() => {
    invalidateGroupsCache();
    orgRole = "admin";
    globalThis.fetch = githubApiMock;
  });

  afterEach(() => {
    globalThis.fetch = restoredFetch;
  });

  it("requires login first and preserves the installation id", async () => {
    const env = createEnv();
    const event = makeEvent("/auth/github/install?installation_id=555", {
      headers: { accept: "text/html" },
      env,
    });
    await handleInstallPage(event);
    expect(responseStatus(event)).toBe(302);
    const location = responseHeader(event, "location") ?? "";
    expect(location).toContain("/auth/github?redirect=");
    expect(decodeURIComponent(location)).toContain("/auth/github/install?installation_id=555");
  });

  it("renders a choice page with the groups the user owns", async () => {
    const kv = createMockKV();
    await kv.put(
      "config:groups",
      JSON.stringify([
        {
          id: "mine",
          name: "My Team",
          adminIds: [],
          members: [{ login: "alice", role: "owner" }],
        },
        {
          id: "theirs",
          name: "Other Team",
          adminIds: [],
          members: [{ login: "bob", role: "owner" }],
        },
      ]),
    );
    const env = createEnv({ KV: kv });
    const cookie = await signIn(kv);

    const event = makeEvent("/auth/github/install?installation_id=555&setup_action=install", {
      headers: { cookie, accept: "text/html" },
      env,
    });
    const html = (await handleInstallPage(event)) as string;
    expect(html).toContain("inst-555");
    expect(html).toContain("My Team");
    expect(html).toContain('value="mine"');
    expect(html).not.toContain('value="theirs"');
  });

  it("refuses an installation the user cannot manage", async () => {
    const kv = createMockKV();
    orgRole = "member";
    const env = createEnv({ KV: kv });
    const cookie = await signIn(kv);
    const event = makeEvent("/auth/github/install?installation_id=555", {
      headers: { cookie, accept: "text/html" },
      env,
    });
    await handleInstallPage(event);
    expect(responseHeader(event, "location")).toBe("/admin?error=install-forbidden");
  });

  it("rejects a missing installation id", async () => {
    const env = createEnv();
    const event = makeEvent("/auth/github/install", { headers: { accept: "text/html" }, env });
    await expect(handleInstallPage(event)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("POST /auth/github/install/bind", () => {
  const restoredFetch = globalThis.fetch;

  beforeEach(() => {
    invalidateGroupsCache();
    orgRole = "admin";
    globalThis.fetch = githubApiMock;
  });

  afterEach(() => {
    globalThis.fetch = restoredFetch;
  });

  function formBody(params: Record<string, string>): string {
    return new URLSearchParams(params).toString();
  }

  function bindEvent(env: Env, cookie: string, params: Record<string, string>) {
    return makeEvent("/auth/github/install/bind", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: formBody(params),
      env,
    });
  }

  it("binds the installation to an existing group the user owns", async () => {
    const kv = createMockKV();
    await kv.put(
      "config:groups",
      JSON.stringify([
        {
          id: "mine",
          name: "My Team",
          adminIds: [],
          members: [{ login: "alice", role: "owner" }],
        },
      ]),
    );
    const env = createEnv({ KV: kv });
    const cookie = await signIn(kv);

    const event = bindEvent(env, cookie, { installation_id: "555", group: "mine" });
    await handleInstallBind(event);
    expect(responseStatus(event)).toBe(302);
    expect(responseHeader(event, "location")).toBe("/admin?install=ok");

    const groups = await loadGroups(kv);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.id).toBe("mine");
    expect(groups[0]!.installationId).toBe(555);
  });

  it("refuses to bind to a group the user does not own", async () => {
    const kv = createMockKV();
    await kv.put(
      "config:groups",
      JSON.stringify([
        {
          id: "theirs",
          name: "Other Team",
          adminIds: [],
          members: [{ login: "bob", role: "owner" }],
        },
      ]),
    );
    const env = createEnv({ KV: kv });
    const cookie = await signIn(kv);

    const event = bindEvent(env, cookie, {
      installation_id: "555",
      group: "theirs",
    });
    await handleInstallBind(event);
    expect(responseStatus(event)).toBe(302);
    expect(responseHeader(event, "location")).toBe("/admin?error=forbidden");

    const groups = await loadGroups(kv);
    expect(groups[0]!.installationId).toBeUndefined();
  });

  it("auto-creates inst-{id} and joins the installer as owner (self-signup)", async () => {
    const kv = createMockKV();
    const { appId, pem } = await makeAppKeyPair();
    const env = createEnv({
      KV: kv,
      ALLOW_SELF_SIGNUP: "1",
      GITHUB_APP_ID: appId,
      GITHUB_PRIVATE_KEY: pem,
    });
    const cookie = await signIn(kv);

    const event = bindEvent(env, cookie, { installation_id: "555", group: "" });
    await handleInstallBind(event);
    expect(responseStatus(event)).toBe(302);
    expect(responseHeader(event, "location")).toBe("/admin?install=ok");

    const groups = await loadGroups(kv);
    const group = groups.find((g) => g.id === "inst-555");
    expect(group).toBeDefined();
    expect(group?.installationId).toBe(555);
    expect(group?.name).toBe("myorg");
    expect(group?.members).toContainEqual({
      login: "alice",
      role: "owner",
      userId: expect.any(String),
    });
  });

  it("refuses to bind an installation the user cannot manage", async () => {
    const kv = createMockKV();
    orgRole = "member";
    await kv.put(
      "config:groups",
      JSON.stringify([
        { id: "mine", name: "Mine", adminIds: [], members: [{ login: "alice", role: "owner" }] },
      ]),
    );
    const env = createEnv({ KV: kv, ALLOW_SELF_SIGNUP: "1" });
    const cookie = await signIn(kv);
    for (const group of ["mine", ""]) {
      const event = bindEvent(env, cookie, { installation_id: "555", group });
      await handleInstallBind(event);
      expect(responseHeader(event, "location")).toBe("/admin?error=install-forbidden");
    }
    const groups = await loadGroups(kv);
    expect(groups.map((g) => [g.id, g.installationId])).toEqual([["mine", undefined]]);
  });

  it("never makes the installer an owner of a group someone already manages", async () => {
    const kv = createMockKV();
    await kv.put(
      "config:groups",
      JSON.stringify([
        {
          id: "inst-555",
          name: "Taken",
          adminIds: [],
          installationId: 555,
          members: [{ login: "bob", role: "owner" }],
        },
      ]),
    );
    const env = createEnv({ KV: kv, ALLOW_SELF_SIGNUP: "1" });
    const cookie = await signIn(kv);
    const event = bindEvent(env, cookie, { installation_id: "555", group: "" });
    await handleInstallBind(event);
    const group = (await loadGroups(kv)).find((g) => g.id === "inst-555");
    expect(group?.members).toEqual([{ login: "bob", role: "owner" }]);
  });

  it("auto-creates inst-{id} without joining members when self-signup is off", async () => {
    const kv = createMockKV();
    const env = createEnv({ KV: kv });
    const cookie = await signIn(kv);

    const event = bindEvent(env, cookie, { installation_id: "555", group: "" });
    await handleInstallBind(event);
    expect(responseStatus(event)).toBe(302);
    const groups = await loadGroups(kv);
    const group = groups.find((g) => g.installationId === 555);
    expect(group).toBeDefined();
    expect(group?.members ?? []).toHaveLength(0);
  });

  it("requires login to bind", async () => {
    const env = createEnv();
    const event = bindEvent(env, "", { installation_id: "555", group: "" });
    await handleInstallBind(event);
    expect(responseStatus(event)).toBe(302);
    expect(responseHeader(event, "location")).toBe("/admin?error=forbidden");
  });
});

describe("oauth misc", () => {
  it("starts the OAuth flow with a state token", async () => {
    const kv = createMockKV();
    const env = createEnv({ KV: kv, GITHUB_CLIENT_ID: "client-1" });
    const event = makeEvent("/auth/github?redirect=/admin", {
      headers: { accept: "text/html" },
      env,
    });
    await handleOAuthStart(event);
    expect(responseStatus(event)).toBe(302);
    const location = responseHeader(event, "location") ?? "";
    expect(location).toContain("https://github.com/login/oauth/authorize?client_id=client-1");
    expect(await kv.list({ prefix: "state:" })).toBeDefined();
  });

  it("rejects the callback without code or state", async () => {
    const env = createEnv();
    const event = makeEvent("/auth/github/callback", { headers: { accept: "text/html" }, env });
    const result = (await handleOAuthCallback(event)) as { error?: string };
    expect(responseStatus(event)).toBe(400);
    expect(result.error).toBe("Missing code or state");
  });

  it("requires a session to delete a token", async () => {
    const env = createEnv();
    const event = makeEvent("/auth/token/123", { method: "DELETE", env });
    const result = (await handleTokenDelete(event, "123")) as { error?: string };
    expect(responseStatus(event)).toBe(401);
    expect(result.error).toBe("Unauthorized");
  });

  it("lets users delete only their own token", async () => {
    const kv = createMockKV();
    const env = createEnv({ KV: kv });
    const cookie = await signIn(kv);
    await saveToken(kv, "2002", "gho_bob", 3600);
    const other = makeEvent("/auth/token/2002", { method: "DELETE", headers: { cookie }, env });
    await handleTokenDelete(other, "2002");
    expect(responseStatus(other)).toBe(403);
    expect(await kv.get("token:2002")).not.toBeNull();
    const own = makeEvent("/auth/token/1001", { method: "DELETE", headers: { cookie }, env });
    await handleTokenDelete(own, "1001");
    expect(responseStatus(own)).toBe(200);
    expect(await kv.get("token:1001")).toBeNull();
  });

  it("rejects a browser callback whose state was started in another browser", async () => {
    const kv = createMockKV();
    const env = createEnv({ KV: kv });
    await kv.put(
      "state:abc",
      JSON.stringify({ redirectTo: "/admin", expiresAt: Date.now() + 60_000 }),
    );
    const event = makeEvent("/auth/github/callback?code=c&state=abc", {
      headers: { accept: "text/html" },
      env,
    });
    const result = (await handleOAuthCallback(event)) as { error?: string };
    expect(responseStatus(event)).toBe(400);
    expect(result.error).toBe("Invalid or expired state");
  });

  it("sets the state cookie when starting the flow", async () => {
    const env = createEnv({ GITHUB_CLIENT_ID: "client-1" });
    const event = makeEvent("/auth/github?redirect=/admin", { env });
    await handleOAuthStart(event);
    expect(String(responseHeader(event, "set-cookie"))).toContain("wh_oauth_state=");
  });
});
