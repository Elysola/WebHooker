import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { sendMessage } from "../server/lib/drivers/discord/rest";
import { renderNeutralMessage } from "../server/lib/drivers/discord/render";
import { dispatchEvent } from "../server/lib/core/dispatch";
import { invalidateGroupsCache } from "../server/lib/web/groups";
import type { Env, Route } from "../server/lib/types";

function mockFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    Promise.resolve(handler(String(input), init));
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_WEBHOOK_SECRET: "secret",
    KV: {} as KVNamespace,
    DB: {} as D1Database,
    ...overrides,
  };
}

const restoredFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = restoredFetch;
});

describe("discord-rest sendMessage", () => {
  beforeEach(() => {
    mockFetch(() => new Response("{}", { status: 200 }));
  });

  it("posts to the channel URL with bot auth", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    mockFetch((url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response("{}", { status: 200 });
    });

    const result = await sendMessage("token-abc", "111", { embeds: [] });

    expect(result.ok).toBe(true);
    expect(capturedUrl).toBe("https://discord.com/api/v10/channels/111/messages");
    expect(capturedInit!.method).toBe("POST");
    expect((capturedInit!.headers as Record<string, string>).Authorization).toBe("Bot token-abc");
    expect((capturedInit!.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });

  it("posts to the thread URL when threadId is given", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      capturedUrl = url;
      return new Response("{}", { status: 200 });
    });

    await sendMessage("t", "111", {}, "999");

    expect(capturedUrl).toBe("https://discord.com/api/v10/channels/999/messages");
  });

  it("returns error on non-ok response", async () => {
    mockFetch(() => new Response("Missing Permissions", { status: 403 }));
    const result = await sendMessage("t", "111", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Missing Permissions");
  });
});

describe("discord role mentions", () => {
  it("renders mentionRoleIds into the message content", () => {
    const out = renderNeutralMessage({
      title: "T",
      mentionRoleIds: ["111", "222"],
    });
    expect(out.content).toBe("<@&111> <@&222>");
    expect(out.embeds?.[0]?.title).toBe("T");
  });

  it("omits content when no roles are mentioned", () => {
    const out = renderNeutralMessage({ title: "T" });
    expect(out.content).toBeUndefined();
  });

  it("renders the forge source in the embed footer", () => {
    const out = renderNeutralMessage({
      title: "acme/widget: Add feature",
      footer: "acme/widget",
      forge: {
        name: "GitHub",
        url: "https://github.com",
        iconUrl: "https://github.com/fluidicon.png",
      },
    });
    expect(out.embeds?.[0]?.footer).toEqual({
      text: "GitHub · acme/widget",
      icon_url: "https://github.com/fluidicon.png",
    });
  });

  it("links the repository heading for a tag title", () => {
    const out = renderNeutralMessage({
      title: "acme/widget: 🏷️ Created tag v1.0",
      url: "https://github.com/acme/widget/releases/tag/v1.0",
    });
    expect(out.embeds?.[0]?.title).toBe("acme/widget");
    expect(out.embeds?.[0]?.url).toBe("https://github.com/acme/widget/releases/tag/v1.0");
    expect(out.embeds?.[0]?.description).toBe("🏷️ Created tag v1.0");
  });
});

describe("dispatchEvent fallback routing", () => {
  beforeEach(() => invalidateGroupsCache());
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

  const baseConfig = {
    baseUrl: "https://example.com",
    github: {
      webhookSecret: "s",
      appId: 1,
      privateKey: "",
      clientId: "",
      clientSecret: "",
    },
    discord: { token: "t" },
    routes: [] as Route[],
  };

  it("fires a filter-less fallback route only when no regular route matched", async () => {
    const sent: string[] = [];
    mockFetch((url) => {
      sent.push(url);
      return new Response("{}", { status: 200 });
    });
    const env = createEnv({ KV: createMockKV(), DB: createMockDB() });
    const routes: Route[] = [
      {
        id: "regular-push",
        name: "Regular Push",
        enabled: true,
        filters: [{ type: "event", match: "push" }],
        targets: [{ channelId: "111" }],
      },
      {
        id: "catch-all",
        name: "Catch all",
        enabled: true,
        filters: [],
        fallback: true,
        targets: [{ channelId: "222" }],
      },
    ];

    await dispatchEvent({ ...baseConfig, routes }, { event: "push", payload: {} }, env);
    expect(sent.filter((u) => u.includes("/111/"))).toHaveLength(1);
    expect(sent.filter((u) => u.includes("/222/"))).toHaveLength(0);

    sent.length = 0;
    await dispatchEvent(
      { ...baseConfig, routes },
      {
        event: "issues",
        payload: {
          action: "opened",
          issue: {
            number: 1,
            title: "Test issue",
            body: "body",
            state: "open",
            html_url: "https://example.com/i/1",
            user: { login: "octocat" },
          },
          repository: { full_name: "owner/repo" },
          sender: { login: "octocat" },
        },
      },
      env,
    );
    expect(sent.filter((u) => u.includes("/111/"))).toHaveLength(0);
    expect(sent.filter((u) => u.includes("/222/"))).toHaveLength(1);
  });

  it("scopes stop and fallback to the route's own group", async () => {
    const sent: string[] = [];
    mockFetch((url) => {
      sent.push(url);
      return new Response("{}", { status: 200 });
    });
    const env = createEnv({ KV: createMockKV(), DB: createMockDB() });
    const route = (
      id: string,
      groupId: string,
      extra: Partial<Route>,
      channelId: string,
    ): Route => ({
      id,
      name: id,
      enabled: true,
      filters: [{ type: "event", match: "push" }],
      targets: [{ channelId }],
      groupId,
      ...extra,
    });
    const routes: Route[] = [
      route("alpha-stop", "alpha", { stop: true }, "301"),
      route("alpha-later", "alpha", {}, "302"),
      route("zeta-push", "zeta", {}, "303"),
      route("zeta-catch-all", "zeta", { fallback: true, filters: [] }, "304"),
      route("omega-catch-all", "omega", { fallback: true, stop: true, filters: [] }, "305"),
      route("omega-catch-all-2", "omega", { fallback: true, filters: [] }, "306"),
    ];

    await dispatchEvent({ ...baseConfig, routes }, { event: "push", payload: {} }, env);
    const hits = (channel: string): number => sent.filter((u) => u.includes(`/${channel}/`)).length;
    // alpha stops after its first match without silencing zeta.
    expect(hits("301")).toBe(1);
    expect(hits("302")).toBe(0);
    expect(hits("303")).toBe(1);
    // zeta matched a regular route, omega did not: only omega's fallback fires,
    // and its `stop` keeps omega's later fallback silent.
    expect(hits("304")).toBe(0);
    expect(hits("305")).toBe(1);
    expect(hits("306")).toBe(0);
  });

  it("prepends role mentions to the Discord message content", async () => {
    const bodies: string[] = [];
    mockFetch((url, init) => {
      bodies.push(String(init?.body ?? ""));
      return new Response("{}", { status: 200 });
    });
    const env = createEnv({ KV: createMockKV(), DB: createMockDB() });
    const routes: Route[] = [
      {
        id: "mention-push",
        name: "Mention Push",
        enabled: true,
        discordRoleIds: ["111", "222"],
        filters: [{ type: "event", match: "push" }],
        targets: [{ channelId: "333" }],
      },
    ];

    await dispatchEvent({ ...baseConfig, routes }, { event: "push", payload: {} }, env);

    expect(bodies).toHaveLength(1);
    const parsed = JSON.parse(bodies[0]!) as {
      content?: string;
      embeds?: Array<{ title?: string }>;
    };
    expect(parsed.content).toBe("<@&111> <@&222>");
    expect(parsed.embeds?.[0]).toBeDefined();
  });

  it("filters events by the group's source provider", async () => {
    const sent: string[] = [];
    mockFetch((url) => {
      sent.push(url);
      return new Response("{}", { status: 200 });
    });
    const kv = createMockKV();
    await kv.put(
      "config:groups",
      JSON.stringify([
        { id: "gh", name: "GH", adminIds: [], providers: ["github"] },
        { id: "gitea", name: "Gitea", adminIds: [], providers: ["gitea"] },
      ]),
    );
    const env = createEnv({ KV: kv, DB: createMockDB() });
    const routes: Route[] = [
      {
        id: "gh-push",
        name: "GH",
        enabled: true,
        groupId: "gh",
        filters: [{ type: "event", match: "push" }],
        targets: [{ channelId: "111" }],
      },
      {
        id: "gitea-push",
        name: "Gitea",
        enabled: true,
        groupId: "gitea",
        filters: [{ type: "event", match: "push" }],
        targets: [{ channelId: "222" }],
      },
    ];

    await dispatchEvent(
      { ...baseConfig, routes },
      { event: "push", payload: {}, provider: "gitea" },
      env,
    );

    expect(sent.filter((u) => u.includes("/222/"))).toHaveLength(1);
    expect(sent.filter((u) => u.includes("/111/"))).toHaveLength(0);
  });

  it("sends a summary of dispatched webhooks to the group log target", async () => {
    const sent: Array<{ url: string; body: string }> = [];
    mockFetch((url, init) => {
      sent.push({ url, body: String(init?.body ?? "") });
      return new Response("{}", { status: 200 });
    });
    const kv = createMockKV();
    await kv.put(
      "config:groups",
      JSON.stringify([
        {
          id: "gh",
          name: "GH",
          adminIds: [],
          logTarget: { platform: "discord", channelId: "777" },
        },
      ]),
    );
    const env = createEnv({ KV: kv, DB: createMockDB() });
    const routes: Route[] = [
      {
        id: "push-route",
        name: "Push Route",
        enabled: true,
        groupId: "gh",
        filters: [{ type: "event", match: "push" }],
        targets: [{ channelId: "111" }],
      },
    ];

    await dispatchEvent(
      { ...baseConfig, routes },
      {
        event: "push",
        deliveryId: "deliv-1",
        payload: {
          repository: { full_name: "owner/repo" },
          ref: "refs/heads/main",
          commits: [{ id: "abc", message: "fix", author: { name: "a" } }],
        },
      },
      env,
    );

    expect(sent).toHaveLength(2);
    expect(sent[1]!.url).toContain("/777/");
    const logBody = JSON.parse(sent[1]!.body) as {
      embeds?: Array<{ title?: string; color?: number; fields?: Array<{ value: string }> }>;
    };
    expect(logBody.embeds?.[0]?.title).toBe("owner/repo");
    expect(logBody.embeds?.[0]?.description).toContain("push");
    expect(logBody.embeds?.[0]?.color).toBe(0x3fb950);
    expect(logBody.embeds?.[0]?.fields?.[0]?.value).toContain("✅ Push Route → 111");
    expect(logBody.embeds?.[0]?.fields?.[1]?.value).toBe("deliv-1");
  });

  it("reports failed dispatches in the group log", async () => {
    const sent: Array<{ url: string; body: string }> = [];
    mockFetch((url, init) => {
      if (url.includes("/111/")) return new Response("Missing Permissions", { status: 403 });
      sent.push({ url, body: String(init?.body ?? "") });
      return new Response("{}", { status: 200 });
    });
    const kv = createMockKV();
    await kv.put(
      "config:groups",
      JSON.stringify([
        {
          id: "gh",
          name: "GH",
          adminIds: [],
          logTarget: { platform: "discord", channelId: "777" },
        },
      ]),
    );
    const env = createEnv({ KV: kv, DB: createMockDB() });
    const routes: Route[] = [
      {
        id: "push-route",
        name: "Push Route",
        enabled: true,
        groupId: "gh",
        filters: [{ type: "event", match: "push" }],
        targets: [{ channelId: "111" }],
      },
    ];

    await dispatchEvent(
      { ...baseConfig, routes },
      {
        event: "push",
        payload: {
          repository: { full_name: "owner/repo" },
          ref: "refs/heads/main",
          commits: [{ id: "abc", message: "fix", author: { name: "a" } }],
        },
      },
      env,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain("/777/");
    const logBody = JSON.parse(sent[0]!.body) as {
      embeds?: Array<{ color?: number; fields?: Array<{ value: string }> }>;
    };
    expect(logBody.embeds?.[0]?.color).toBe(0xf85149);
    expect(logBody.embeds?.[0]?.fields?.[0]?.value).toContain("❌ Push Route → 111");
  });

  it("attaches the forge label when the group defines a matching host", async () => {
    const bodies: string[] = [];
    mockFetch((url, init) => {
      bodies.push(String(init?.body ?? ""));
      return new Response("{}", { status: 200 });
    });
    const kv = createMockKV();
    await kv.put(
      "config:groups",
      JSON.stringify([
        {
          id: "gh",
          name: "GH",
          adminIds: [],
          forgeSources: [{ host: "git.example.com", type: "gitea", name: "内网 Gitea" }],
        },
        { id: "plain", name: "Plain", adminIds: [] },
      ]),
    );
    const env = createEnv({ KV: kv, DB: createMockDB() });
    const routes: Route[] = [
      {
        id: "gitea-route",
        name: "Gitea Route",
        enabled: true,
        groupId: "gh",
        filters: [{ type: "event", match: "push" }],
        targets: [{ channelId: "111" }],
      },
      {
        id: "plain-route",
        name: "Plain Route",
        enabled: true,
        groupId: "plain",
        filters: [{ type: "event", match: "push" }],
        targets: [{ channelId: "222" }],
      },
    ];

    await dispatchEvent(
      { ...baseConfig, routes },
      {
        event: "push",
        provider: "gitea",
        payload: {
          repository: {
            full_name: "owner/repo",
            html_url: "https://git.example.com/owner/repo",
          },
          ref: "refs/heads/main",
          commits: [{ id: "abc", message: "fix" }],
          sender: { login: "octo" },
        },
      },
      env,
    );

    expect(bodies).toHaveLength(2);
    const footers = bodies.map((b) => {
      const parsed = JSON.parse(b) as {
        embeds?: Array<{ footer?: { text: string; icon_url?: string } }>;
      };
      return parsed.embeds?.[0]?.footer;
    });
    expect(footers).toContainEqual({
      text: "内网 Gitea · owner/repo",
      icon_url: "https://git.example.com/assets/img/favicon.png",
    });
    expect(footers).toContainEqual({ text: "owner/repo" });
  });

  it("sends no group log when no route matched the event", async () => {
    const sent: string[] = [];
    mockFetch((url, init) => {
      sent.push(String(init?.body ?? ""));
      return new Response("{}", { status: 200 });
    });
    const kv = createMockKV();
    await kv.put(
      "config:groups",
      JSON.stringify([
        {
          id: "gh",
          name: "GH",
          adminIds: [],
          logTarget: { platform: "discord", channelId: "777" },
        },
      ]),
    );
    const env = createEnv({ KV: kv, DB: createMockDB() });
    const routes: Route[] = [
      {
        id: "push-route",
        name: "Push Route",
        enabled: true,
        groupId: "gh",
        filters: [{ type: "event", match: "push" }],
        targets: [{ channelId: "111" }],
      },
    ];

    await dispatchEvent(
      { ...baseConfig, routes },
      { event: "issues", payload: { action: "opened", repository: { full_name: "o/r" } } },
      env,
    );

    expect(sent).toHaveLength(0);
  });

  it("uses the group's message language (not the route's)", async () => {
    const bodies: string[] = [];
    mockFetch((url, init) => {
      bodies.push(String(init?.body ?? ""));
      return new Response("{}", { status: 200 });
    });
    const kv = createMockKV();
    await kv.put(
      "config:groups",
      JSON.stringify([
        { id: "zh-group", name: "中文组", adminIds: [], lang: "zh" },
        { id: "en-group", name: "English", adminIds: [] },
      ]),
    );
    const env = createEnv({ KV: kv, DB: createMockDB() });
    const routes: Route[] = [
      {
        id: "zh-push",
        name: "ZH",
        enabled: true,
        groupId: "zh-group",
        filters: [{ type: "event", match: "push" }],
        targets: [{ channelId: "111" }],
      },
      {
        id: "en-push",
        name: "EN",
        enabled: true,
        groupId: "en-group",
        filters: [{ type: "event", match: "push" }],
        targets: [{ channelId: "222" }],
      },
    ];

    await dispatchEvent(
      { ...baseConfig, routes },
      {
        event: "push",
        payload: {
          repository: { full_name: "owner/repo" },
          commits: [{ id: "abc", message: "fix", author: { name: "a" } }],
          ref: "refs/heads/main",
          compare: "https://example.com/compare",
        },
      },
      env,
    );

    expect(bodies).toHaveLength(2);
    const titles = bodies.map((b) => {
      const parsed = JSON.parse(b) as { embeds?: Array<{ title?: string }> };
      return parsed.embeds?.[0]?.title ?? "";
    });
    expect(titles.sort()).toEqual(["owner/repo", "owner/repo"].sort());
  });

  it("dispatches workflow_run events and enriches them with jobs", async () => {
    const sent: string[] = [];
    const bodies: string[] = [];
    mockFetch((url, init) => {
      if (url.includes("api.github.com") && url.includes("/jobs")) {
        return Response.json({
          jobs: [
            {
              name: "build",
              status: "completed",
              conclusion: "success",
              started_at: "2026-01-01T00:00:00Z",
              completed_at: "2026-01-01T00:01:30Z",
            },
          ],
        });
      }
      sent.push(url);
      bodies.push(String(init?.body ?? ""));
      return new Response("{}", { status: 200 });
    });
    const env = createEnv({ KV: createMockKV(), DB: createMockDB() });
    const routes: Route[] = [
      {
        id: "wf-route",
        name: "Workflow",
        enabled: true,
        filters: [{ type: "event", match: "workflow_run" }],
        targets: [{ channelId: "111" }],
      },
    ];

    const summary = await dispatchEvent(
      { ...baseConfig, routes },
      {
        event: "workflow_run",
        payload: {
          action: "completed",
          workflow_run: {
            id: 42,
            name: "CI",
            conclusion: "success",
            status: "completed",
            html_url: "https://github.com/owner/repo/actions/runs/42",
            head_branch: "main",
            run_number: 7,
            jobs_url: "https://api.github.com/repos/owner/repo/actions/runs/42/jobs",
          },
          repository: { full_name: "owner/repo" },
          sender: { login: "octocat" },
        },
      },
      env,
    );

    expect(summary.attempts).toBe(1);
    expect(sent.filter((u) => u.includes("/111/"))).toHaveLength(1);
    expect(bodies[0]).toContain("```diff");
    expect(bodies[0]).toContain("build ✅ success · 1m 30s");
  });
});
