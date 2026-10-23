import { describe, it, expect } from "bun:test";
import { authLogin, claimLogin } from "../server/lib/web/session";
import { BeforeGitHubError, commentAsUser } from "../server/lib/github/oauth";
import { kvConfigStore, d1ConfigStore } from "../server/lib/storage/config-store";
import { createInvite, deleteGroupInvites, getInvite } from "../server/lib/web/invites";
import { loadFragments, saveGroupFragments } from "../server/lib/fragments";
import { handleQueueBatch } from "../server/lib/queue/consumer";
import { dispatchEvent } from "../server/lib/core/dispatch";
import { customProvider } from "../server/lib/providers/custom";
import { renderNeutralMessage as renderTelegram } from "../server/lib/drivers/telegram/render";
import { listInvites } from "../server/lib/web/invites";
import { sendMessage as discordSend } from "../server/lib/drivers/discord/rest";
import type { DeliveryMessage } from "../server/lib/queue/delivery";
import type { Config, Env, Group, Route } from "../server/lib/types";
import { createMemoryKV, createSqliteD1 } from "./d1-sqlite";

const route = (id: string, groupId: string): Route => ({
  id,
  name: id,
  enabled: true,
  filters: [{ type: "event", match: "push" }],
  targets: [{ platform: "discord", channelId: "c1" }],
  groupId,
});

describe("login ownership", () => {
  it("never lets a second account inherit what was granted to a login", async () => {
    const { kv } = createMemoryKV();
    expect(await claimLogin(kv, "42", "alice")).toBe(true);
    expect(await claimLogin(kv, "42", "Alice")).toBe(true);
    // The name was renamed away and registered by someone else.
    expect(await claimLogin(kv, "77", "alice")).toBe(false);
    expect(authLogin({ userId: "77", login: "alice", loginTrusted: false })).toBe("");
    expect(authLogin({ userId: "42", login: "alice" })).toBe("alice");
  });
});

describe("payload shapes", () => {
  it("refuses a top-level JSON array from the custom provider", () => {
    expect(customProvider.parse("[1,2,3]", {})).toBeNull();
    expect(customProvider.parse('{"a":1}', {})?.payload).toEqual({ a: 1 });
  });

  it("never renders a Markdown hard break as the <br> Telegram rejects", () => {
    const html = renderTelegram({ title: "t", description: "first line  \nsecond line" });
    expect(html).not.toContain("<br");
    expect(html).toContain("first line\nsecond line");
  });
});

describe("bot commands", () => {
  it("tells a failure before GitHub was called from a GitHub answer", async () => {
    const { kv } = createMemoryKV();
    kv.get = (async () => {
      throw new Error("KV down");
    }) as typeof kv.get;
    await expect(commentAsUser(kv, "42", "o", "r", 1, "hi")).rejects.toBeInstanceOf(
      BeforeGitHubError,
    );
  });
});

describe("configuration leftovers", () => {
  it("never hands routes left under an id to a new group created with it (KV-only)", async () => {
    const { kv, store } = createMemoryKV();
    store.set("config:groups", JSON.stringify([]));
    // Copies an interrupted rename left behind.
    store.set("config:routes", JSON.stringify([route("leftover", "b")]));
    const cfg = kvConfigStore(kv);
    expect(await cfg.createGroup({ id: "b", name: "B", adminIds: [] })).toBe(true);
    expect((await cfg.loadRoutes()).filter((r) => r.groupId === "b")).toEqual([]);
  });

  it("seeds routes of a missing group into an isolated placeholder, not an open one", async () => {
    const { db } = createSqliteD1();
    const { kv, store } = createMemoryKV();
    store.set("config:groups", JSON.stringify([]));
    store.set(
      "config:routes",
      JSON.stringify([route("r1", "deleted-private"), { ...route("r2", ""), groupId: undefined }]),
    );
    const groups = await d1ConfigStore(db, kv).loadGroups({ fresh: true });
    const placeholder = groups.find((g) => g.id === "deleted-private");
    expect(placeholder?.isolated).toBe(true);
    // A new identity: the deleted group's secret and invites never apply to it.
    expect(placeholder?.instance).toBeTruthy();
    expect(placeholder?.legacyId).toBeUndefined();
    expect(groups.find((g) => g.id !== "deleted-private")?.isolated).toBeUndefined();
  });

  it("refuses to replace a group's fragments while one of them is unreadable", async () => {
    const { db, sqlite } = createSqliteD1();
    const { kv } = createMemoryKV();
    await d1ConfigStore(db, kv).createGroup({ id: "g", name: "G", adminIds: [] });
    sqlite.exec(
      "INSERT INTO d1_fragments (id, group_id, name, node, created_at, updated_at) VALUES ('bad', 'g', 'B', '{oops', 1, 1)",
    );
    expect(await loadFragments(db, "g")).toEqual([]);
    await expect(saveGroupFragments(db, "g", [])).rejects.toThrow(/unreadable/);
    expect(sqlite.query("SELECT COUNT(*) AS n FROM d1_fragments").get()).toEqual({ n: 1 });
  });
});

describe("invites of a former id holder", () => {
  it("lists a pre-instance invite still filed under the group's former id", async () => {
    const { kv } = createMemoryKV();
    const token = await createInvite(kv, {
      groupId: "old",
      role: "viewer",
      expiresAt: Date.now() + 86400_000,
      createdBy: "x",
    });
    // Renamed old -> new; moving the invite failed.
    const listed = await listInvites(kv, "new", { instance: "i1", legacyId: "old" });
    expect(listed.map((i) => i.token)).toEqual([token]);
  });

  it("deleting a group keeps the invites another group issued under the same id", async () => {
    const { kv } = createMemoryKV();
    const foreign = await createInvite(kv, {
      groupId: "a",
      role: "viewer",
      expiresAt: Date.now() + 86400_000,
      createdBy: "x",
      groupInstance: "renamed-away",
    });
    const own = await createInvite(kv, {
      groupId: "a",
      role: "viewer",
      expiresAt: Date.now() + 86400_000,
      createdBy: "y",
      groupInstance: "current",
    });
    await deleteGroupInvites(kv, "a", { instance: "current" });
    expect(await getInvite(kv, own)).toBeNull();
    expect(await getInvite(kv, foreign)).not.toBeNull();
  });
});

describe("queue safety", () => {
  it("leaves a delivery and its payload alone while another copy holds a live lease", async () => {
    const { db, sqlite } = createSqliteD1();
    const { kv, store } = createMemoryKV();
    const env: Env = { GITHUB_WEBHOOK_SECRET: "", KV: kv, DB: db };
    sqlite.exec(
      `INSERT INTO delivery_state (key, status, updated_at) VALUES ('delivery-state:github:@global:d1', 'processing', ${Date.now()})`,
    );
    store.set("queue:payload:x", "{}");
    const body: DeliveryMessage = {
      deliveryId: "d1",
      provider: "github",
      event: "push",
      payloadRef: "queue:payload:x",
      payloadRefType: "kv",
      receivedAt: Date.now(),
    };
    let acked = false;
    let retried: unknown = null;
    const message = {
      body,
      attempts: 1,
      ack: (): void => {
        acked = true;
      },
      retry: (opts: unknown): void => {
        retried = opts;
      },
    };
    await handleQueueBatch(
      {
        queue: "webhooker-delivery-dlq",
        messages: [message],
      } as unknown as MessageBatch<DeliveryMessage>,
      env,
    );
    expect(acked).toBe(false);
    expect(retried).toEqual({ delaySeconds: 310 });
    expect(store.has("queue:payload:x")).toBe(true);
  });

  it("leaves a group with an unreadable route out whole — its fallback included", async () => {
    let sends = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      sends += 1;
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const env: Env = {
        GITHUB_WEBHOOK_SECRET: "",
        KV: createMemoryKV().kv,
        DB: createSqliteD1().db,
      };
      const config: Config = {
        baseUrl: "https://x",
        github: { webhookSecret: "", appId: 0, privateKey: "", clientId: "", clientSecret: "" },
        discord: { token: "t" },
        // The regular route that would have matched is the unreadable one.
        routes: [{ ...route("fb", "g"), fallback: true }],
        unreadableGroups: ["g"],
      };
      const groups: Group[] = [{ id: "g", name: "G", adminIds: [] }];
      const summary = await dispatchEvent(config, { event: "push", payload: {} }, env, groups);
      expect(sends).toBe(0);
      expect(summary.failures).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("matches each regular route once per dispatch", async () => {
    const { matchRoute } = await import("../server/lib/events/match");
    let reads = 0;
    const probed = (): Record<string, unknown> => {
      const payload: Record<string, unknown> = {};
      Object.defineProperty(payload, "probe", {
        enumerable: true,
        get: () => {
          reads++;
          return "no";
        },
      });
      return payload;
    };
    const r: Route = {
      ...route("r", "g"),
      filters: [{ type: "field", path: "probe", op: "eq", match: "yes" }],
    };
    expect(matchRoute(r, { event: "push", payload: probed() })).toBe(false);
    const once = reads;
    reads = 0;
    const env: Env = {
      GITHUB_WEBHOOK_SECRET: "",
      KV: createMemoryKV().kv,
      DB: createSqliteD1().db,
    };
    const config: Config = {
      baseUrl: "https://x",
      github: { webhookSecret: "", appId: 0, privateKey: "", clientId: "", clientSecret: "" },
      discord: { token: "t" },
      routes: [r],
    };
    const groups: Group[] = [{ id: "g", name: "G", adminIds: [] }];
    await dispatchEvent(config, { event: "push", payload: probed() }, env, groups);
    expect(once).toBeGreaterThan(0);
    expect(reads).toBe(once);
  });

  it("reports a group with an unreadable route as a transient failure", async () => {
    const env: Env = {
      GITHUB_WEBHOOK_SECRET: "",
      KV: createMemoryKV().kv,
      DB: createSqliteD1().db,
    };
    const config: Config = {
      baseUrl: "https://x",
      github: { webhookSecret: "", appId: 0, privateKey: "", clientId: "", clientSecret: "" },
      discord: { token: "t" },
      routes: [],
      unreadableGroups: ["g"],
    };
    const groups: Group[] = [{ id: "g", name: "G", adminIds: [] }];
    const summary = await dispatchEvent(config, { event: "push", payload: {} }, env, groups);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]!.errorCode).toBeUndefined();
  });
});

describe("lost send responses", () => {
  it("retries a Discord create with the same enforced nonce", async () => {
    const bodies: Array<{ nonce?: string; enforce_nonce?: boolean }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      // The first create went through, but its response was lost.
      if (bodies.length === 1) throw new Error("connection reset");
      return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const result = await discordSend("t", "123", { content: "hi" });
      expect(result.ok).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.enforce_nonce).toBe(true);
    expect(bodies[1]!.nonce).toBe(bodies[0]!.nonce);
    expect(bodies[0]!.nonce!.length).toBeLessThanOrEqual(25);
  });
});

describe("send keys", () => {
  it("gives every attempt of a delivery to a target the same platform nonce", async () => {
    const nonces: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      nonces.push((JSON.parse(String(init?.body)) as { nonce: string }).nonce);
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const env: Env = {
        GITHUB_WEBHOOK_SECRET: "",
        DISCORD_TOKEN: "t",
        KV: createMemoryKV().kv,
        DB: createSqliteD1().db,
      };
      const config: Config = {
        baseUrl: "https://x",
        github: { webhookSecret: "", appId: 0, privateKey: "", clientId: "", clientSecret: "" },
        discord: { token: "t" },
        routes: [route("r", "g")],
      };
      const groups: Group[] = [{ id: "g", name: "G", adminIds: [], instance: "i" }];
      for (const deliveryId of ["d1", "d1", "d2"]) {
        await dispatchEvent(config, { event: "push", payload: {}, deliveryId }, env, groups);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(nonces).toHaveLength(3);
    expect(nonces[1]).toBe(nonces[0]);
    expect(nonces[2]).not.toBe(nonces[0]);
  });
});

describe("pre-instance message chains", () => {
  it("are adopted only by the group that had the id back then", async () => {
    const event = {
      event: "check_run",
      deliveryId: "d",
      payload: {
        action: "completed",
        check_run: {
          id: 1,
          name: "build",
          head_sha: "abc",
          status: "completed",
          conclusion: "success",
          check_suite: { id: 7 },
        },
        repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
      },
    };
    for (const [legacyId, expected] of [
      [undefined, "POST"],
      ["g", "PATCH"],
    ] as const) {
      const { db, sqlite } = createSqliteD1();
      sqlite.exec(
        `INSERT INTO message_tracking (event_id, target_id, message_id, updated_at)
         VALUES ('g:r:check_run:o/r:build:abc', 'c1', 'old-message', 1)`,
      );
      const methods: string[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        methods.push(String(init?.method));
        return new Response(JSON.stringify({ id: "m" }), { status: 200 });
      }) as unknown as typeof fetch;
      try {
        const env: Env = {
          GITHUB_WEBHOOK_SECRET: "",
          DISCORD_TOKEN: "t",
          KV: createMemoryKV().kv,
          DB: db,
        };
        const config: Config = {
          baseUrl: "https://x",
          github: { webhookSecret: "", appId: 0, privateKey: "", clientId: "", clientSecret: "" },
          discord: { token: "t" },
          routes: [{ ...route("r", "g"), filters: [{ type: "event", match: "check_run" }] }],
        };
        // A group re-created under the id has a fresh instance and no legacyId.
        const groups: Group[] = [{ id: "g", name: "G", adminIds: [], instance: "i", legacyId }];
        await dispatchEvent(config, event, env, groups);
      } finally {
        globalThis.fetch = realFetch;
      }
      expect(methods).toEqual([expected]);
    }
  });
});

describe("one-time identity migration", () => {
  it("trusts no identity field stored before the server assigned them", async () => {
    const { db, sqlite } = createSqliteD1();
    const { kv } = createMemoryKV();
    // Rows as the old API stored them: an owner wrote identity fields freely.
    sqlite.exec(
      `INSERT INTO d1_groups (id, name, data, version, created_at, updated_at) VALUES
        ('victim', 'V', '{"id":"victim","name":"V","adminIds":[]}', 1, 0, 0),
        ('zz-attacker', 'A', '{"id":"zz-attacker","name":"A","adminIds":[],"instance":"same","legacyId":"victim","instanceBackfilled":true}', 1, 0, 0),
        ('zz-other', 'O', '{"id":"zz-other","name":"O","adminIds":[],"instance":"same"}', 1, 0, 0)`,
    );
    const groups = await d1ConfigStore(db, kv).loadGroups({ fresh: true });
    const byId = new Map(groups.map((g) => [g.id, g]));
    expect(byId.get("zz-attacker")!.legacyId).toBe("zz-attacker");
    expect(byId.get("victim")!.legacyId).toBe("victim");
    const instances = groups.map((g) => g.instance);
    expect(new Set(instances).size).toBe(3);
    expect(instances).not.toContain("same");
  });

  it("seeds ungrouped legacy routes into a group of their own, never a tenant's", async () => {
    const { db } = createSqliteD1();
    const { kv, store } = createMemoryKV();
    store.set(
      "config:groups",
      JSON.stringify([{ id: "ungrouped", name: "Tenant", adminIds: ["mallory"] }]),
    );
    store.set("config:routes", JSON.stringify([{ ...route("global", ""), groupId: undefined }]));
    const cfg = d1ConfigStore(db, kv);
    const routes = await cfg.loadRoutes({ fresh: true });
    expect(routes.map((r) => r.groupId)).toEqual(["ungrouped-2"]);
    const placeholder = (await cfg.loadGroups()).find((g) => g.id === "ungrouped-2")!;
    expect(placeholder.adminIds).toEqual([]);
  });
});

describe("update chain versions", () => {
  it("never lets a late in-progress event undo a completion stamped the same time", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls.push(String(init?.method));
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    }) as unknown as typeof fetch;
    const run = (status: string, conclusion: string | null): Record<string, unknown> => ({
      workflow_run: {
        id: 5,
        workflow_id: 9,
        name: "CI",
        status,
        conclusion,
        updated_at: "2026-10-01T00:00:00Z",
        html_url: "https://github.com/o/r/actions/runs/5",
      },
      workflow: { id: 9, name: "CI" },
      repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
    });
    try {
      const env: Env = {
        GITHUB_WEBHOOK_SECRET: "",
        DISCORD_TOKEN: "t",
        KV: createMemoryKV().kv,
        DB: createSqliteD1().db,
      };
      const config: Config = {
        baseUrl: "https://x",
        github: { webhookSecret: "", appId: 0, privateKey: "", clientId: "", clientSecret: "" },
        discord: { token: "t" },
        routes: [{ ...route("r", "g"), filters: [{ type: "event", match: "workflow_run" }] }],
      };
      const groups: Group[] = [{ id: "g", name: "G", adminIds: [], instance: "i" }];
      await dispatchEvent(
        config,
        { event: "workflow_run", payload: run("completed", "failure") },
        env,
        groups,
      );
      await dispatchEvent(
        config,
        { event: "workflow_run", payload: run("in_progress", null) },
        env,
        groups,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    // The completion was posted; the stale in-progress state never edits it.
    expect(calls).toEqual(["POST"]);
  });
});

describe("identity migration edge cases", () => {
  it("keeps identities a KV-only deployment already manages when moving to D1", async () => {
    const { db } = createSqliteD1();
    const { kv, store } = createMemoryKV();
    store.set(
      "config:groups",
      JSON.stringify([
        {
          id: "g",
          name: "G",
          adminIds: [],
          instance: "A",
          legacyId: "g",
          instanceBackfilled: true,
        },
      ]),
    );
    store.set("config:identity-migrated", "1");
    const groups = await d1ConfigStore(db, kv).loadGroups({ fresh: true });
    expect(groups[0]!.instance).toBe("A");
  });

  it("only records the migration once the table exists, after a KV-marked run", async () => {
    const { db, sqlite } = createSqliteD1();
    const { kv, store } = createMemoryKV();
    store.set("config:identity-migrated", "1");
    sqlite.exec(
      `INSERT INTO d1_groups (id, name, data, version, created_at, updated_at) VALUES
        ('new', 'N', '{"id":"new","name":"N","adminIds":[],"instance":"i1","legacyId":"old","instanceBackfilled":true}', 1, 0, 0)`,
    );
    const groups = await d1ConfigStore(db, kv).loadGroups({ fresh: true });
    expect(groups[0]!.legacyId).toBe("old");
    expect(groups[0]!.instance).toBe("i1");
  });

  it("never keeps a stored instance in the KV-only migration", async () => {
    // The instance the migration derives for "victim"...
    const { kv, store } = createMemoryKV();
    store.set("config:groups", JSON.stringify([{ id: "victim", name: "V", adminIds: [] }]));
    const derived = (await kvConfigStore(kv).loadGroups())[0]!.instance!;
    // ...pre-filled by an attacker on their own group before the upgrade.
    const { kv: kv2, store: store2 } = createMemoryKV();
    store2.set(
      "config:groups",
      JSON.stringify([
        { id: "victim", name: "V", adminIds: [] },
        { id: "zz", name: "Z", adminIds: [], instance: derived },
      ]),
    );
    const groups = await kvConfigStore(kv2).loadGroups();
    expect(new Set(groups.map((g) => g.instance)).size).toBe(2);
  });
});

describe("pattern usability", () => {
  it("judges what the matcher runs: AST over flat filters, literals not as regexes", async () => {
    const { db, sqlite } = createSqliteD1();
    const { kv } = createMemoryKV();
    const cfg = d1ConfigStore(db, kv);
    await cfg.createGroup({ id: "g", name: "G", adminIds: [] });
    await cfg.saveGroupRoutes("g", [route("r1", "g"), route("r2", "g"), route("r3", "g")]);
    sqlite.exec(`UPDATE d1_routes SET filters = '[{"type":"repo","match":"/^a(?=b)/"}]',
      ast = '{"type":"event","match":"push"}' WHERE id = 'r1'`);
    sqlite.exec(
      `UPDATE d1_routes SET filters = '[{"type":"repo","op":"contains","match":"/(?=foo)/"}]' WHERE id = 'r2'`,
    );
    expect((await cfg.loadSnapshot({ fresh: true })).unreadable).toEqual([]);
    // A glob longer than the matcher compiles is not usable.
    sqlite.exec(
      `UPDATE d1_routes SET filters = '[{"type":"branch","match":"${"a".repeat(201)}*","exclude":true}]' WHERE id = 'r3'`,
    );
    expect((await cfg.loadSnapshot({ fresh: true })).unreadable).toEqual(["g"]);
  });
});

describe("upgrade compatibility", () => {
  it("never re-sends a tenant delivery finished under the key used before the upgrade", async () => {
    const { kv, store } = createMemoryKV();
    store.set(
      "config:groups",
      JSON.stringify([
        {
          id: "team",
          name: "T",
          adminIds: [],
          instance: "ti",
          legacyId: "team",
          instanceBackfilled: true,
        },
      ]),
    );
    store.set("config:identity-migrated", "1");
    // Finished before the upgrade (state keyed `{provider}:{groupId}:{id}`).
    store.set("delivery-state:github:team:d1", JSON.stringify({ status: "delivered", at: 1 }));
    // The global endpoint's old key: its owner is never certain.
    store.set("delivery-state:github:global:d2", JSON.stringify({ status: "delivered", at: 1 }));
    const run = async (body: Partial<DeliveryMessage>): Promise<number> => {
      let dispatched = 0;
      const message = {
        body: {
          provider: "github",
          event: "push",
          payload: {},
          receivedAt: Date.now(),
          stateVersion: 2,
          ...body,
        } as DeliveryMessage,
        attempts: 1,
        ack: (): void => {},
        retry: (): void => {},
      };
      await handleQueueBatch(
        {
          queue: "webhooker-delivery",
          messages: [message],
        } as unknown as MessageBatch<DeliveryMessage>,
        { GITHUB_WEBHOOK_SECRET: "", KV: kv, DB: {} as D1Database },
        async () => {
          dispatched += 1;
          return { attempts: 0, failures: [] };
        },
      );
      return dispatched;
    };
    expect(await run({ deliveryId: "d1", groupId: "team", groupInstance: "ti" })).toBe(0);
    // Sent again rather than dropped.
    expect(await run({ deliveryId: "d2" })).toBe(1);
  });

  it("refuses to serve configuration while the marker table is missing", async () => {
    const { db, sqlite } = createSqliteD1({
      migrations: (name) => !name.startsWith("0008") && !name.startsWith("0013"),
    });
    sqlite.exec(
      `INSERT INTO d1_groups (id, name, data, version, created_at, updated_at)
       VALUES ('g', 'G', '{"id":"g","name":"G","adminIds":[]}', 1, 0, 0)`,
    );
    // Identities can neither be trusted unmigrated nor migrated safely: fail.
    await expect(
      d1ConfigStore(db, createMemoryKV().kv).loadGroups({ fresh: true }),
    ).rejects.toThrow(/migrations are incomplete/);
  });
});

describe("mixed filter nodes", () => {
  it("counts a stored node mixing condition kinds as one unreadable route", async () => {
    const { db, sqlite } = createSqliteD1();
    const { kv } = createMemoryKV();
    const cfg = d1ConfigStore(db, kv);
    await cfg.createGroup({ id: "g", name: "G", adminIds: [] });
    await cfg.createGroup({ id: "h", name: "H", adminIds: [] });
    await cfg.saveGroupRoutes("g", [route("r1", "g")]);
    await cfg.saveGroupRoutes("h", [route("r2", "h")]);
    sqlite.exec(
      `UPDATE d1_routes SET ast = '{"all":0,"any":[{"type":"event","match":"push"}]}' WHERE id = 'r1'`,
    );
    // The snapshot still loads: only that group is affected.
    const snapshot = await cfg.loadSnapshot({ fresh: true });
    expect(snapshot.unreadable).toEqual(["g"]);
    expect(snapshot.routes.map((r) => r.id)).toEqual(["r2"]);
  });
});

describe("old global-endpoint state", () => {
  it("is never trusted when a tenant named global existed at the upgrade", async () => {
    const { db, sqlite } = createSqliteD1();
    const { kv } = createMemoryKV();
    sqlite.exec(
      `INSERT INTO d1_groups (id, name, data, version, created_at, updated_at)
       VALUES ('global', 'Tenant', '{"id":"global","name":"Tenant","adminIds":[]}', 1, 0, 0)`,
    );
    // Its state, written before the upgrade under the shared key.
    sqlite.exec(
      `INSERT INTO delivery_state (key, status, updated_at) VALUES ('delivery-state:github:global:d1', 'delivered', 1)`,
    );
    let dispatched = 0;
    const message = {
      body: {
        deliveryId: "d1",
        provider: "github",
        event: "push",
        payload: {},
        receivedAt: Date.now(),
        stateVersion: 2,
      } as DeliveryMessage,
      attempts: 1,
      ack: (): void => {},
      retry: (): void => {},
    };
    await handleQueueBatch(
      {
        queue: "webhooker-delivery",
        messages: [message],
      } as unknown as MessageBatch<DeliveryMessage>,
      { GITHUB_WEBHOOK_SECRET: "", KV: kv, DB: db },
      async () => {
        dispatched += 1;
        return { attempts: 0, failures: [] };
      },
    );
    // A global-endpoint event with that id is dispatched, not taken for done.
    expect(dispatched).toBe(1);
  });
});

describe("old tenant state", () => {
  it("is not read for a group created since (no older id of that name)", async () => {
    const { db, sqlite } = createSqliteD1();
    const { kv, store } = createMemoryKV();
    // Identities managed by this server already (the group keeps its instance).
    store.set("config:identity-migrated", "1");
    sqlite.exec(
      `INSERT INTO d1_groups (id, name, data, version, created_at, updated_at)
       VALUES ('team', 'Team', '{"id":"team","name":"Team","adminIds":[],"instance":"ti"}', 1, 0, 0)`,
    );
    // Left by an earlier group of that id.
    sqlite.exec(
      `INSERT INTO delivery_state (key, status, updated_at) VALUES ('delivery-state:github:team:d1', 'delivered', 1)`,
    );
    const legacyReads: unknown[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const stmt = prepare(sql);
      const bind = stmt.bind.bind(stmt);
      stmt.bind = ((...args: unknown[]) => {
        if (args.includes("delivery-state:github:team:d1")) legacyReads.push(sql);
        return bind(...args);
      }) as typeof stmt.bind;
      return stmt;
    }) as typeof db.prepare;
    let dispatched = 0;
    const message = {
      body: {
        deliveryId: "d1",
        provider: "github",
        groupId: "team",
        groupInstance: "ti",
        event: "push",
        payload: {},
        receivedAt: Date.now(),
        stateVersion: 2,
      } as DeliveryMessage,
      attempts: 1,
      ack: (): void => {},
      retry: (): void => {},
    };
    await handleQueueBatch(
      {
        queue: "webhooker-delivery",
        messages: [message],
      } as unknown as MessageBatch<DeliveryMessage>,
      { GITHUB_WEBHOOK_SECRET: "", KV: kv, DB: db },
      async () => {
        dispatched += 1;
        return { attempts: 0, failures: [] };
      },
    );
    expect(dispatched).toBe(1);
    expect(legacyReads).toEqual([]);
  });
});

describe("legacy global tenant", () => {
  it("never takes the shared old state key for its own", async () => {
    const { kv, store } = createMemoryKV();
    store.set(
      "config:groups",
      JSON.stringify([
        {
          id: "global",
          name: "T",
          adminIds: [],
          instance: "gi",
          legacyId: "global",
          instanceBackfilled: true,
        },
      ]),
    );
    store.set("config:identity-migrated", "1");
    // The global endpoint's delivery, finished before the upgrade.
    store.set("delivery-state:custom:global:42", JSON.stringify({ status: "delivered", at: 1 }));
    let dispatched = 0;
    const message = {
      body: {
        deliveryId: "42",
        provider: "custom",
        groupId: "global",
        groupInstance: "gi",
        event: "custom",
        payload: {},
        receivedAt: Date.now(),
        stateVersion: 2,
      } as DeliveryMessage,
      attempts: 1,
      ack: (): void => {},
      retry: (): void => {},
    };
    await handleQueueBatch(
      {
        queue: "webhooker-delivery",
        messages: [message],
      } as unknown as MessageBatch<DeliveryMessage>,
      { GITHUB_WEBHOOK_SECRET: "", KV: kv, DB: {} as D1Database },
      async () => {
        dispatched += 1;
        return { attempts: 0, failures: [] };
      },
    );
    expect(dispatched).toBe(1);
  });
});

describe("revocation reaches every location at once", () => {
  it("stops a signed-out session and a revoked token even where KV still has them", async () => {
    const { createAdminSession, getAdminSession, destroyAdminSession, adminCookie } =
      await import("../server/lib/web/session");
    const { saveToken, removeToken, findUserIdByToken } =
      await import("../server/lib/github/store");
    const { db } = createSqliteD1();
    const { kv } = createMemoryKV();
    const id = await createAdminSession(kv, "42", "alice");
    const cookie = adminCookie(id).split(";")[0]!;
    const stale = await kv.get(`session:${id}`);
    await destroyAdminSession(kv, cookie, db);
    // A location that has not seen the delete yet still holds the session.
    await kv.put(`session:${id}`, stale!);
    expect(await getAdminSession(kv, cookie, db)).toBeNull();

    await saveToken(kv, "42", "tok-1", 3600, db);
    const staleToken = await kv.get("token:42");
    await removeToken(kv, "42", db);
    await kv.put("token:42", staleToken!);
    expect(await findUserIdByToken(kv, "tok-1", db)).toBeNull();
  });

  it("never falls back to an older KV secret once the group's secret was removed", async () => {
    const { getTenantSecret } = await import("../server/lib/web/tenants");
    const { kv } = createMemoryKV();
    await kv.put("tenant:i:inst", "old-secret");
    expect(await getTenantSecret(kv, { id: "g", instance: "inst", webhookSecret: "" })).toBeNull();
    expect(await getTenantSecret(kv, { id: "g", instance: "inst" })).toBe("old-secret");
  });

  it("isolates a group row whose fields have the wrong shape", async () => {
    const { db, sqlite } = createSqliteD1();
    const { kv } = createMemoryKV();
    const cfg = d1ConfigStore(db, kv);
    await cfg.createGroup({ id: "g", name: "G", adminIds: [] });
    await cfg.saveGroupRoutes("g", [route("r1", "g")]);
    sqlite.exec(
      `UPDATE d1_groups SET data = json_set(data, '$.providers', 'github') WHERE id = 'g'`,
    );
    expect((await cfg.loadSnapshot({ fresh: true })).unreadable).toEqual(["g"]);
  });
});

describe("round 23", () => {
  it("never takes a Feishu 200 it could not read for a sent message", async () => {
    const { sendMessage } = await import("../server/lib/drivers/feishu/rest");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("{cut off", { status: 200 })) as unknown as typeof fetch;
    try {
      const result = await sendMessage("t", "oc_1", { a: 1 });
      expect(result.ok).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 15_000);

  it("gives bot actions no token that was revoked, even where KV still has it", async () => {
    const { saveToken, removeToken, getToken } = await import("../server/lib/github/store");
    const { db } = createSqliteD1();
    const { kv } = createMemoryKV();
    await saveToken(kv, "42", "tok-1", 3600, db);
    const stale = await kv.get("token:42");
    await removeToken(kv, "42", db);
    await kv.put("token:42", stale!);
    expect(await getToken({ KV: kv, DB: db }, "42")).toBeNull();
  });

  it("serves the configuration of a fresh isolate despite a malformed group row", async () => {
    const { db, sqlite } = createSqliteD1();
    const { kv } = createMemoryKV();
    await d1ConfigStore(db, kv).createGroup({ id: "ok", name: "OK", adminIds: [] });
    sqlite.exec(
      "INSERT INTO d1_groups (id, name, data, version, created_at, updated_at) VALUES ('bad', 'B', '{', 1, 0, 0)",
    );
    const groups = await d1ConfigStore(db, kv).loadGroups({ fresh: true });
    expect(groups.map((g) => g.id)).toEqual(["ok"]);
  });
});

describe("round 24", () => {
  it("keys platform idempotency by the receiving endpoint too", async () => {
    const nonces: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      nonces.push((JSON.parse(String(init?.body)) as { nonce: string }).nonce);
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const env: Env = {
        GITHUB_WEBHOOK_SECRET: "",
        DISCORD_TOKEN: "t",
        KV: createMemoryKV().kv,
        DB: createSqliteD1().db,
      };
      const config: Config = {
        baseUrl: "https://x",
        github: { webhookSecret: "", appId: 0, privateKey: "", clientId: "", clientSecret: "" },
        discord: { token: "t" },
        routes: [route("r", "g")],
      };
      const groups: Group[] = [{ id: "g", name: "G", adminIds: [], instance: "i" }];
      const event = { event: "push", payload: {}, deliveryId: "42" };
      await dispatchEvent(config, event, env, groups);
      await dispatchEvent(config, event, env, groups, { tenantId: "g" });
    } finally {
      globalThis.fetch = realFetch;
    }
    // Same delivery id on two endpoints: two events, two messages.
    expect(nonces).toHaveLength(2);
    expect(nonces[1]).not.toBe(nonces[0]);
  });

  it("revokes the old token before a rotation overwrites it", async () => {
    const { saveToken } = await import("../server/lib/github/store");
    const { kv } = createMemoryKV();
    const { db } = createSqliteD1();
    await saveToken(kv, "42", "tok-A", 3600, db);
    const broken = {
      ...db,
      batch: db.batch.bind(db),
      prepare: (): never => {
        throw new Error("D1 down");
      },
    } as unknown as D1Database;
    await expect(saveToken(kv, "42", "tok-B", 3600, broken)).rejects.toThrow();
    // Not overwritten: a retry still knows which token to revoke.
    expect(JSON.parse((await kv.get("token:42"))!).accessToken).toBe("tok-A");
  });

  it("never lets a late pending deployment status undo a success stamped the same time", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls.push(String(init?.method));
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    }) as unknown as typeof fetch;
    const status = (state: string): Record<string, unknown> => ({
      deployment_status: { id: 1, state, updated_at: "2026-10-01T00:00:00Z" },
      deployment: { id: 7, environment: "prod", ref: "main", sha: "abc" },
      repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
    });
    try {
      const env: Env = {
        GITHUB_WEBHOOK_SECRET: "",
        DISCORD_TOKEN: "t",
        KV: createMemoryKV().kv,
        DB: createSqliteD1().db,
      };
      const config: Config = {
        baseUrl: "https://x",
        github: { webhookSecret: "", appId: 0, privateKey: "", clientId: "", clientSecret: "" },
        discord: { token: "t" },
        routes: [{ ...route("r", "g"), filters: [{ type: "event", match: "deployment_status" }] }],
      };
      const groups: Group[] = [{ id: "g", name: "G", adminIds: [], instance: "i" }];
      await dispatchEvent(
        config,
        { event: "deployment_status", payload: status("success") },
        env,
        groups,
      );
      await dispatchEvent(
        config,
        { event: "deployment_status", payload: status("pending") },
        env,
        groups,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toEqual(["POST"]);
  });
});

describe("group webhook log", () => {
  it("posts one summary per delivery outcome, not one per retry", async () => {
    const posts: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      posts.push(String(url));
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const env: Env = {
        GITHUB_WEBHOOK_SECRET: "",
        DISCORD_TOKEN: "t",
        KV: createMemoryKV().kv,
        DB: createSqliteD1().db,
      };
      const config: Config = {
        baseUrl: "https://x",
        github: { webhookSecret: "", appId: 0, privateKey: "", clientId: "", clientSecret: "" },
        discord: { token: "t" },
        routes: [route("r", "g")],
      };
      const groups: Group[] = [
        {
          id: "g",
          name: "G",
          adminIds: [],
          instance: "i",
          logTarget: { platform: "discord", channelId: "log" },
        },
      ];
      const event = { event: "push", payload: {}, deliveryId: "d1" };
      await dispatchEvent(config, event, env, groups);
      await dispatchEvent(config, event, env, groups);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(posts.filter((u) => u.includes("/channels/log/"))).toHaveLength(1);
  });
});

describe("round 26", () => {
  it("stops a newer token even when the removal read an older one from KV", async () => {
    const { saveToken, removeToken, getToken, findUserIdByToken } =
      await import("../server/lib/github/store");
    const { db } = createSqliteD1();
    const { kv } = createMemoryKV();
    await saveToken(kv, "42", "tok-0", 3600, db);
    const older = await kv.get("token:42");
    await saveToken(kv, "42", "tok-1", 3600, db);
    const newer = await kv.get("token:42");
    const newerReverse = await kv.get("token-reverse:" + (await sha256("tok-1")));
    // The removing location still sees tok-0.
    await kv.put("token:42", older!);
    await removeToken(kv, "42", db);
    // Another location still sees tok-1.
    await kv.put("token:42", newer!);
    await kv.put("token-reverse:" + (await sha256("tok-1")), newerReverse!);
    expect(await getToken({ KV: kv, DB: db }, "42")).toBeNull();
    expect(await findUserIdByToken(kv, "tok-1", db)).toBeNull();
    // A later sign-in works again.
    await saveToken(kv, "42", "tok-2", 3600, db);
    expect(await getToken({ KV: kv, DB: db }, "42")).toBe("tok-2");
    expect(await findUserIdByToken(kv, "tok-2", db)).toBe("42");
  });

  it("keeps a rotation's older token out even where KV still shows it", async () => {
    const { saveToken, getToken } = await import("../server/lib/github/store");
    const { db } = createSqliteD1();
    const { kv } = createMemoryKV();
    await saveToken(kv, "42", "tok-0", 3600, db);
    await saveToken(kv, "42", "tok-1", 3600, db);
    const newer = await kv.get("token:42");
    // A rotation working from a stale copy (tok-0) still retires tok-1.
    await kv.put("token:42", JSON.stringify({ ...JSON.parse(newer!), accessToken: "tok-0" }));
    await saveToken(kv, "42", "tok-2", 3600, db);
    await kv.put("token:42", newer!);
    expect(await getToken({ KV: kv, DB: db }, "42")).toBeNull();
  });

  it("filters deployments by the deployed ref", async () => {
    const { matchRoute } = await import("../server/lib/events/match");
    const r: Route = { ...route("r", "g"), filters: [{ type: "branch", match: "main" }] };
    for (const name of ["deployment", "deployment_status"]) {
      expect(matchRoute(r, { event: name, payload: { deployment: { ref: "main" } } })).toBe(true);
      expect(matchRoute(r, { event: name, payload: { deployment: { ref: "dev" } } })).toBe(false);
    }
  });

  it("deduplicates group summaries whatever order the targets finished in", async () => {
    const posts: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      posts.push(String(url));
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const env: Env = {
        GITHUB_WEBHOOK_SECRET: "",
        DISCORD_TOKEN: "t",
        KV: createMemoryKV().kv,
        DB: createSqliteD1().db,
      };
      const base: Config = {
        baseUrl: "https://x",
        github: { webhookSecret: "", appId: 0, privateKey: "", clientId: "", clientSecret: "" },
        discord: { token: "t" },
        routes: [],
      };
      const a = {
        ...route("a", "g"),
        targets: [{ platform: "discord" as const, channelId: "c1" }],
      };
      const b = {
        ...route("b", "g"),
        targets: [{ platform: "discord" as const, channelId: "c2" }],
      };
      const groups: Group[] = [
        {
          id: "g",
          name: "G",
          adminIds: [],
          instance: "i",
          logTarget: { platform: "discord", channelId: "log" },
        },
      ];
      const event = { event: "push", payload: {}, deliveryId: "d1" };
      await dispatchEvent({ ...base, routes: [a, b] }, event, env, groups);
      await dispatchEvent({ ...base, routes: [b, a] }, event, env, groups);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(posts.filter((u) => u.includes("/channels/log/"))).toHaveLength(1);
  });
});

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

describe("round 27", () => {
  it("never lets a late creation bring back a deleted comment's message", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls.push(String(init?.method));
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    }) as unknown as typeof fetch;
    const payload = (action: string): Record<string, unknown> => ({
      action,
      issue: { number: 7, title: "Bug", html_url: "https://github.com/o/r/issues/7" },
      comment: {
        id: 99,
        body: "hi",
        updated_at: "2026-10-01T00:00:00Z",
        html_url: "https://github.com/o/r/issues/7#issuecomment-99",
        user: { login: "a" },
      },
      repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
    });
    try {
      const env: Env = {
        GITHUB_WEBHOOK_SECRET: "",
        DISCORD_TOKEN: "t",
        KV: createMemoryKV().kv,
        DB: createSqliteD1().db,
      };
      const config: Config = {
        baseUrl: "https://x",
        github: { webhookSecret: "", appId: 0, privateKey: "", clientId: "", clientSecret: "" },
        discord: { token: "t" },
        routes: [{ ...route("r", "g"), filters: [{ type: "event", match: "issue_comment" }] }],
      };
      const groups: Group[] = [{ id: "g", name: "G", adminIds: [], instance: "i" }];
      await dispatchEvent(
        config,
        { event: "issue_comment", payload: payload("deleted") },
        env,
        groups,
      );
      await dispatchEvent(
        config,
        { event: "issue_comment", payload: payload("created") },
        env,
        groups,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    // The deletion was posted; the creation retried late never edits it back.
    expect(calls).toEqual(["POST"]);
  });

  it("filters check runs and code scanning alerts by branch name", async () => {
    const { matchRoute } = await import("../server/lib/events/match");
    const r: Route = { ...route("r", "g"), filters: [{ type: "branch", match: "main" }] };
    expect(
      matchRoute(r, {
        event: "check_run",
        payload: { check_run: { check_suite: { head_branch: "main" } } },
      }),
    ).toBe(true);
    expect(
      matchRoute(r, { event: "code_scanning_alert", payload: { ref: "refs/heads/main" } }),
    ).toBe(true);
    expect(
      matchRoute(r, { event: "code_scanning_alert", payload: { ref: "refs/heads/dev" } }),
    ).toBe(false);
  });

  it("keeps what a delivery finished as long as its state (7 days)", async () => {
    const { markTargetsDone } = await import("../server/lib/queue/delivery");
    const { db, sqlite } = createSqliteD1();
    const env: Env = { GITHUB_WEBHOOK_SECRET: "", KV: createMemoryKV().kv, DB: db };
    await markTargetsDone(env, "k", ["t"], { permanentFailure: true });
    const rows = sqlite.query("SELECT expires_at FROM dedup_keys").all() as Array<{
      expires_at: number;
    }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.expires_at).toBeGreaterThan(Date.now() + 6.9 * 86400_000);
  });

  it("scopes logs for many groups with one bound parameter", async () => {
    const { groupScopeClause } = await import("../server/lib/lib/send-log");
    const ids = Array.from({ length: 150 }, (_, i) => `g${i}`);
    const clause = groupScopeClause(ids)!;
    expect(clause.args).toHaveLength(1);
    const { db } = createSqliteD1();
    const { getSendLog } = await import("../server/lib/lib/send-log");
    await expect(getSendLog(db, 10, ids)).resolves.toEqual([]);
  });

  it("summarizes a retry that skips finished targets as nothing new", async () => {
    const posts: string[] = [];
    const realFetch = globalThis.fetch;
    let failC2 = true;
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      posts.push(u);
      if (u.includes("/channels/c2/") && failC2) return new Response("{}", { status: 502 });
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const env: Env = {
        GITHUB_WEBHOOK_SECRET: "",
        DISCORD_TOKEN: "t",
        KV: createMemoryKV().kv,
        DB: createSqliteD1().db,
      };
      const config: Config = {
        baseUrl: "https://x",
        github: { webhookSecret: "", appId: 0, privateKey: "", clientId: "", clientSecret: "" },
        discord: { token: "t" },
        routes: [
          { ...route("a", "g"), targets: [{ platform: "discord", channelId: "c1" }] },
          { ...route("b", "g"), targets: [{ platform: "discord", channelId: "c2" }] },
        ],
      };
      const groups: Group[] = [
        {
          id: "g",
          name: "G",
          adminIds: [],
          instance: "i",
          logTarget: { platform: "discord", channelId: "log" },
        },
      ];
      const done = new Set<string>();
      const options = {
        skipTarget: async (key: string): Promise<boolean> => done.has(key),
        afterTarget: async (key: string): Promise<void> => {
          done.add(key);
        },
      };
      const event = { event: "push", payload: {}, deliveryId: "d1" };
      await dispatchEvent(config, event, env, groups, options);
      // The retry skips c1 and fails c2 again: nothing new to report.
      await dispatchEvent(config, event, env, groups, options);
      expect(posts.filter((u) => u.includes("/channels/log/"))).toHaveLength(1);
      // c2 recovers: a new summary.
      failC2 = false;
      await dispatchEvent(config, event, env, groups, options);
      expect(posts.filter((u) => u.includes("/channels/log/"))).toHaveLength(2);
      // The same id from another forge is another delivery, with its own summary.
      done.clear();
      await dispatchEvent(config, { ...event, provider: "gitea" }, env, groups, options);
      expect(posts.filter((u) => u.includes("/channels/log/"))).toHaveLength(3);
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 30_000);
});

describe("round 28", () => {
  async function runChain(
    payloads: Array<{ event: string; payload: Record<string, unknown> }>,
    groups: Group[] = [{ id: "g", name: "G", adminIds: [], instance: "i" }],
    seed?: (sqlite: import("bun:sqlite").Database) => void,
  ): Promise<string[]> {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls.push(String(init?.method));
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const { db, sqlite } = createSqliteD1();
      seed?.(sqlite);
      const env: Env = {
        GITHUB_WEBHOOK_SECRET: "",
        DISCORD_TOKEN: "t",
        KV: createMemoryKV().kv,
        DB: db,
      };
      const config: Config = {
        baseUrl: "https://x",
        github: { webhookSecret: "", appId: 0, privateKey: "", clientId: "", clientSecret: "" },
        discord: { token: "t" },
        routes: [{ ...route("r", "g"), filters: [] }],
      };
      for (const p of payloads) await dispatchEvent(config, p, env, groups);
    } finally {
      globalThis.fetch = realFetch;
    }
    return calls;
  }

  it("never lets an untimed queued run undo a completion", async () => {
    const run = (status: string, updated?: string): Record<string, unknown> => ({
      workflow_run: {
        id: 5,
        workflow_id: 9,
        name: "CI",
        status,
        conclusion: status === "completed" ? "success" : null,
        ...(updated ? { updated_at: updated } : {}),
        html_url: "https://github.com/o/r/actions/runs/5",
      },
      workflow: { id: 9, name: "CI" },
      repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
    });
    const calls = await runChain([
      { event: "workflow_run", payload: run("completed", "2026-10-01T00:00:00Z") },
      { event: "workflow_run", payload: run("queued") },
    ]);
    expect(calls).toEqual(["POST"]);
  });

  it("never lets a late submission undo a dismissed review", async () => {
    const review = (action: string, state: string): Record<string, unknown> => ({
      action,
      review: {
        id: 3,
        state,
        submitted_at: "2026-10-01T00:00:00Z",
        html_url: "https://github.com/o/r/pull/1#pullrequestreview-3",
        user: { login: "a" },
      },
      pull_request: { number: 1, title: "PR", html_url: "https://github.com/o/r/pull/1" },
      repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
    });
    const calls = await runChain([
      { event: "pull_request_review", payload: review("dismissed", "dismissed") },
      { event: "pull_request_review", payload: review("submitted", "approved") },
    ]);
    expect(calls).toEqual(["POST"]);
  });

  it("lets exactly one new chain adopt an old message", async () => {
    const checkRun = (suite: number): Record<string, unknown> => ({
      action: "completed",
      check_run: {
        id: suite,
        name: "build",
        head_sha: "abc",
        status: "completed",
        conclusion: "success",
        check_suite: { id: suite },
      },
      repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
    });
    const calls = await runChain(
      [
        { event: "check_run", payload: checkRun(1) },
        { event: "check_run", payload: checkRun(2) },
      ],
      [{ id: "g", name: "G", adminIds: [], instance: "i", legacyId: "g" }],
      (sqlite) =>
        sqlite.exec(
          `INSERT INTO message_tracking (event_id, target_id, message_id, updated_at)
           VALUES ('g:r:check_run:o/r:build:abc', 'c1', 'old-message', 1)`,
        ),
    );
    expect(calls).toEqual(["PATCH", "POST"]);
  });

  it("takes no old-key lock when there is no old entry to adopt", async () => {
    const run = {
      workflow_run: {
        id: 5,
        workflow_id: 9,
        name: "CI",
        status: "queued",
        conclusion: null,
        html_url: "https://github.com/o/r/actions/runs/5",
      },
      workflow: { id: 9, name: "CI" },
      repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
    };
    let db: import("bun:sqlite").Database | undefined;
    const calls = await runChain(
      [{ event: "workflow_run", payload: run }],
      [{ id: "g", name: "G", adminIds: [], instance: "i", legacyId: "g" }],
      (sqlite) => {
        sqlite.exec("CREATE TABLE lock_log (key TEXT)");
        sqlite.exec(
          `CREATE TRIGGER log_legacy_lock AFTER INSERT ON dedup_keys
           WHEN NEW.key LIKE 'msg:lock:legacy:%'
           BEGIN INSERT INTO lock_log VALUES (NEW.key); END`,
        );
        db = sqlite;
      },
    );
    expect(calls).toEqual(["POST"]);
    expect(db!.prepare("SELECT COUNT(*) AS n FROM lock_log").get()).toEqual({ n: 0 });
  });

  it("lets routes that had no group adopt their unprefixed chains", async () => {
    const calls = await runChain(
      [
        {
          event: "check_run",
          payload: {
            action: "completed",
            check_run: {
              id: 1,
              name: "build",
              head_sha: "abc",
              status: "completed",
              conclusion: "success",
              check_suite: { id: 7 },
            },
            repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
          },
        },
      ],
      [{ id: "g", name: "G", adminIds: [], instance: "i", legacyId: "" }],
      (sqlite) =>
        sqlite.exec(
          `INSERT INTO message_tracking (event_id, target_id, message_id, updated_at)
           VALUES ('r:check_run:o/r:build:abc', 'c1', 'old-message', 1)`,
        ),
    );
    expect(calls).toEqual(["PATCH"]);
  });

  it("drops a Feishu token the reply was refused with", async () => {
    const { forgetRejectedToken, tokenKey } = await import("../server/lib/drivers/feishu/rest");
    const { kv } = createMemoryKV();
    const env: Env = {
      GITHUB_WEBHOOK_SECRET: "",
      KV: kv,
      DB: createSqliteD1().db,
      FEISHU_APP_ID: "cli_a",
    };
    await kv.put(tokenKey(env), "stale");
    await forgetRejectedToken({ ok: false, errorCode: "FEISHU_TOKEN" }, env, "stale");
    expect(await kv.get(tokenKey(env))).toBeNull();
  });
});

describe("round 29", () => {
  it("keeps the stage an untimed completion reached over a timed queued state", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls.push(String(init?.method));
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    }) as unknown as typeof fetch;
    const run = (status: string, updated?: string): Record<string, unknown> => ({
      workflow_run: {
        id: 5,
        workflow_id: 9,
        name: "CI",
        status,
        conclusion: status === "completed" ? "success" : null,
        ...(updated ? { updated_at: updated } : {}),
        html_url: "https://github.com/o/r/actions/runs/5",
      },
      workflow: { id: 9, name: "CI" },
      repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
    });
    try {
      const env: Env = {
        GITHUB_WEBHOOK_SECRET: "",
        DISCORD_TOKEN: "t",
        KV: createMemoryKV().kv,
        DB: createSqliteD1().db,
      };
      const config: Config = {
        baseUrl: "https://x",
        github: { webhookSecret: "", appId: 0, privateKey: "", clientId: "", clientSecret: "" },
        discord: { token: "t" },
        routes: [{ ...route("r", "g"), filters: [] }],
      };
      const groups: Group[] = [{ id: "g", name: "G", adminIds: [], instance: "i" }];
      for (const payload of [
        run("queued", "2026-10-01T00:00:00Z"),
        run("completed"),
        run("queued"),
      ]) {
        await dispatchEvent(config, { event: "workflow_run", payload }, env, groups);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toEqual(["POST", "PATCH"]);
  });

  it("moves an adopted chain entry in one step, leaving nothing behind", async () => {
    const { messageTracker } = await import("../server/lib/lib/message-tracker");
    const { db, sqlite } = createSqliteD1();
    const tracker = messageTracker(db, createMemoryKV().kv);
    await tracker.set("old", "c1", { messageId: "m", version: 1 });
    await tracker.move(
      { eventId: "old", targetId: "c1" },
      { eventId: "new", targetId: "d:c1" },
      { messageId: "m", version: 1 },
    );
    expect(await tracker.get("old", "c1")).toBeNull();
    expect((await tracker.get("new", "d:c1"))?.messageId).toBe("m");
    // A failing move leaves the old entry where it was (one transaction).
    await tracker.set("old2", "c1", { messageId: "m2", version: 1 });
    sqlite.exec(
      "CREATE TRIGGER no_new BEFORE INSERT ON message_tracking WHEN NEW.event_id = 'new2' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    await expect(
      tracker.move(
        { eventId: "old2", targetId: "c1" },
        { eventId: "new2", targetId: "d:c1" },
        { messageId: "m2", version: 1 },
      ),
    ).rejects.toThrow();
    expect((await tracker.get("old2", "c1"))?.messageId).toBe("m2");
  });

  it("rejects keyword conditions with an operator the matcher would ignore", async () => {
    const { validateRoutes } = await import("../server/lib/web/admin");
    const result = validateRoutes([
      {
        id: "r",
        name: "r",
        enabled: true,
        groupId: "g",
        filters: [{ type: "keyword", op: "ne", match: "secret" }],
        targets: [{ platform: "discord", channelId: "1" }],
      },
    ]);
    expect(result.ok).toBe(false);
  });

  it("caps Discord role mentions", async () => {
    const { validateRoutes } = await import("../server/lib/web/admin");
    const ids = Array.from({ length: 60 }, (_, i) => String(1000000000000000000n + BigInt(i)));
    const result = validateRoutes([
      {
        id: "r",
        name: "r",
        enabled: true,
        groupId: "g",
        filters: [],
        discordRoleIds: ids,
        targets: [{ platform: "discord", channelId: "1" }],
      },
    ]);
    expect(result.ok).toBe(false);
    const { renderNeutralMessage } = await import("../server/lib/drivers/discord/render");
    const rendered = renderNeutralMessage({ title: "t", mentionRoleIds: [...ids, ...ids] });
    expect((rendered.content ?? "").length).toBeLessThanOrEqual(2000);
    expect(rendered.allowed_mentions?.roles?.length).toBeLessThanOrEqual(100);
  });
});

describe("round 30", () => {
  it("never lets a forge title mention everyone in a Feishu chat", async () => {
    const { renderNeutralMessage } = await import("../server/lib/drivers/feishu/render");
    const card = JSON.stringify(
      renderNeutralMessage({
        title: "o/r#1: <at id=all></at> hi",
        url: "https://github.com/o/r/issues/1",
        description: "<AT id=all></AT>",
        fields: [{ name: "x", value: '<at user_id="ou_1">a</at>' }],
      }),
    );
    expect(/<\/?at\b/i.test(card)).toBe(false);
  });

  it("reads a delivery's finished targets in one query", async () => {
    const { markTargetsDone, targetDoneChecker } = await import("../server/lib/queue/delivery");
    const { db } = createSqliteD1();
    let queries = 0;
    const counted = new Proxy(db, {
      get(target, prop, receiver): unknown {
        if (prop === "prepare") {
          return (sql: string): D1PreparedStatement => {
            queries++;
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as D1Database;
    const env: Env = { GITHUB_WEBHOOK_SECRET: "", KV: createMemoryKV().kv, DB: counted };
    await markTargetsDone(env, "k", ["a", "b"]);
    queries = 0;
    const done = targetDoneChecker(env, "k");
    const results = await Promise.all(["a", "b", "c", "d", "e"].map((t) => done(t)));
    expect(results).toEqual([true, true, false, false, false]);
    expect(queries).toBe(1);
  });

  it("refuses a route listing the same destination twice, and sends a stored one once", async () => {
    const { validateRoutes } = await import("../server/lib/web/admin");
    const result = validateRoutes([
      {
        id: "r",
        name: "r",
        enabled: true,
        groupId: "g",
        filters: [{ type: "event", match: "push" }],
        targets: [
          { platform: "telegram", chatId: "-100123" },
          { platform: "telegram", chatId: "-100123" },
        ],
      },
    ]);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("repeats") });
    const posts: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      posts.push(String(url));
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const env: Env = {
        GITHUB_WEBHOOK_SECRET: "",
        DISCORD_TOKEN: "t",
        KV: createMemoryKV().kv,
        DB: createSqliteD1().db,
      };
      const config: Config = {
        baseUrl: "https://x",
        github: { webhookSecret: "", appId: 0, privateKey: "", clientId: "", clientSecret: "" },
        discord: { token: "t" },
        routes: [
          {
            ...route("r", "g"),
            targets: [
              { platform: "discord", channelId: "c1" },
              { platform: "discord", channelId: "c1" },
            ],
          },
        ],
      };
      await dispatchEvent(config, { event: "push", payload: {} }, env, [
        { id: "g", name: "G", adminIds: [], instance: "i" },
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(posts).toHaveLength(1);
  });

  it("keeps sign-in redirects on this site", async () => {
    const { safeRedirectPath } = await import("../server/lib/web/oauth");
    expect(safeRedirectPath("/\t/evil.example")).toBe("/");
    expect(safeRedirectPath("/%09/evil.example")).toBe("/%09/evil.example");
    expect(safeRedirectPath("/admin/groups?x=1#y")).toBe("/admin/groups?x=1#y");
    expect(safeRedirectPath("//evil.example")).toBe("/");
  });

  it("resolves the Discord application per bot token", async () => {
    const { getApplicationId } = await import("../server/lib/drivers/discord/commands");
    const { kv } = createMemoryKV();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({ id: auth.endsWith("one") ? "app-1" : "app-2" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    try {
      const base = { GITHUB_WEBHOOK_SECRET: "", KV: kv, DB: createSqliteD1().db };
      expect(await getApplicationId({ ...base, DISCORD_TOKEN: "one" })).toBe("app-1");
      expect(await getApplicationId({ ...base, DISCORD_TOKEN: "two" })).toBe("app-2");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("gives an auto-provisioned installation group to its audit with its instance", async () => {
    const { ensureInstallationGroup } = await import("../server/lib/web/groups");
    const { kv } = createMemoryKV();
    const group = await ensureInstallationGroup(kv, 42, "acme");
    expect(group?.instance).toBeTruthy();
  });
});

describe("round 31", () => {
  it("filters mentions out of the Feishu note too", async () => {
    const { renderNeutralMessage } = await import("../server/lib/drivers/feishu/render");
    const card = JSON.stringify(
      renderNeutralMessage({
        title: "t",
        footer: "<at id=all></at>",
        forge: { name: "<at id=all>" },
      }),
    );
    expect(/<\/?at\b/i.test(card)).toBe(false);
  });

  it("caches the Feishu token per app", async () => {
    const { tokenKey } = await import("../server/lib/drivers/feishu/rest");
    const base = { GITHUB_WEBHOOK_SECRET: "", KV: createMemoryKV().kv, DB: createSqliteD1().db };
    expect(tokenKey({ ...base, FEISHU_APP_ID: "cli_a" })).not.toBe(
      tokenKey({ ...base, FEISHU_APP_ID: "cli_b" }),
    );
  });

  it("continues a chain whose message another Discord application sent", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const method = String(init?.method);
      calls.push(method);
      if (method === "PATCH") {
        return new Response(
          JSON.stringify({
            message: "Cannot edit a message authored by another user",
            code: 50005,
          }),
          { status: 403 },
        );
      }
      return new Response(JSON.stringify({ id: "m2" }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const { db } = createSqliteD1();
      const env: Env = {
        GITHUB_WEBHOOK_SECRET: "",
        DISCORD_TOKEN: "t",
        KV: createMemoryKV().kv,
        DB: db,
      };
      const config: Config = {
        baseUrl: "https://x",
        github: { webhookSecret: "", appId: 0, privateKey: "", clientId: "", clientSecret: "" },
        discord: { token: "t" },
        routes: [{ ...route("r", "g"), filters: [{ type: "event", match: "workflow_run" }] }],
      };
      const payload = {
        workflow_run: {
          id: 5,
          workflow_id: 9,
          name: "CI",
          status: "completed",
          conclusion: "success",
          updated_at: "2026-10-01T00:00:00Z",
          html_url: "https://github.com/o/r/actions/runs/5",
        },
        workflow: { id: 9, name: "CI" },
        repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
      };
      const groups: Group[] = [{ id: "g", name: "G", adminIds: [], instance: "i" }];
      // First event posts and tracks a message; then it is "another app's".
      await dispatchEvent(config, { event: "workflow_run", payload }, env, groups);

      calls.length = 0;
      const later = {
        ...payload,
        workflow_run: { ...payload.workflow_run, updated_at: "2026-10-01T00:01:00Z" },
      };
      await dispatchEvent(config, { event: "workflow_run", payload: later }, env, groups);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toEqual(["PATCH", "POST"]);
  });

  it("refuses a redirect that dot segments turn protocol-relative", async () => {
    const { safeRedirectPath } = await import("../server/lib/web/oauth");
    expect(safeRedirectPath("/a/..//evil.example")).toBe("/");
    expect(safeRedirectPath("/a/%2e%2e//evil.example")).toBe("/");
  });

  it("refuses a Discord thread listed alone and with its parent", async () => {
    const { validateRoutes } = await import("../server/lib/web/admin");
    const result = validateRoutes([
      {
        id: "r",
        name: "r",
        enabled: true,
        groupId: "g",
        filters: [{ type: "event", match: "push" }],
        targets: [
          { platform: "discord", channelId: "222" },
          { platform: "discord", channelId: "111", threadId: "222" },
        ],
      },
    ]);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("repeats") });
  });

  it("registers the commands again after a rollback", async () => {
    const { registerGlobalCommands } = await import("../server/lib/drivers/discord/commands");
    const { kv } = createMemoryKV();
    // A marker left by other command definitions (a newer version, rolled back).
    await kv.put("cmd:registered:global:app", "other-definitions");
    let puts = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      puts++;
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await registerGlobalCommands({
        GITHUB_WEBHOOK_SECRET: "",
        KV: kv,
        DB: createSqliteD1().db,
        DISCORD_TOKEN: "t",
        DISCORD_APPLICATION_ID: "app",
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(puts).toBe(1);
  });
});

describe("round 32", () => {
  it("accepts Telegram topic ids written one way only", async () => {
    const { validateRoutes } = await import("../server/lib/web/admin");
    const routeWith = (topicId: string): unknown => ({
      id: "r",
      name: "r",
      enabled: true,
      groupId: "g",
      filters: [{ type: "event", match: "push" }],
      targets: [{ platform: "telegram", chatId: "-100123", topicId }],
    });
    expect(validateRoutes([routeWith("12")]).ok).toBe(true);
    for (const bad of ["01", "1e0", "abc", "-1", "99999999999"]) {
      expect(validateRoutes([routeWith(bad)]).ok).toBe(false);
    }
  });

  it("pages through every guild when syncing commands", async () => {
    const { syncGuildCommands } = await import("../server/lib/drivers/discord/commands");
    const realFetch = globalThis.fetch;
    const registered: string[] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/users/@me/guilds")) {
        const after = Number(url.searchParams.get("after") ?? "0");
        const size = Number(url.searchParams.get("limit"));
        const ids = Array.from({ length: 250 }, (_, i) => i + 1).filter((i) => i > after);
        return new Response(JSON.stringify(ids.slice(0, size).map((id) => ({ id: String(id) }))), {
          status: 200,
        });
      }
      if (init?.method === "PUT") registered.push(url.pathname);
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    const env = {
      GITHUB_WEBHOOK_SECRET: "",
      KV: createMemoryKV().kv,
      DB: createSqliteD1().db,
      DISCORD_TOKEN: "t",
      DISCORD_APPLICATION_ID: "app",
    };
    try {
      // Each run registers a bounded share; the record carries the progress on.
      for (let run = 0; run < 12; run++) await syncGuildCommands(env);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(new Set(registered).size).toBe(250);
    expect(registered).toHaveLength(250);
  });

  it("gives a link confirmation back when the link could not be written", async () => {
    const { handleLinkConfirm } = await import("../server/lib/web/oauth");
    const { makeEvent } = await import("./helpers");
    const { db } = createSqliteD1();
    const { kv } = createMemoryKV();
    const nonce = "a".repeat(32);
    await kv.put(
      `link:${nonce}`,
      JSON.stringify({ platform: "telegram", userId: "5", githubUserId: "7", login: "alice" }),
    );
    let fail = true;
    const flaky = new Proxy(db, {
      get(target, prop, receiver): unknown {
        if (prop === "prepare") {
          return (sql: string): D1PreparedStatement => {
            if (fail && sql.includes("telegram_links")) throw new Error("D1 down");
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as D1Database;
    const env: Env = { GITHUB_WEBHOOK_SECRET: "", KV: kv, DB: flaky };
    const submit = (): ReturnType<typeof makeEvent> =>
      makeEvent("/auth/github/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce }),
        env,
      });
    await expect(handleLinkConfirm(submit())).rejects.toThrow();
    fail = false;
    const page = await handleLinkConfirm(submit());
    expect(page).not.toContain("链接已失效");
    const row = await db
      .prepare("SELECT github_user_id FROM telegram_links WHERE telegram_user_id = '5'")
      .first<{ github_user_id: string }>();
    expect(row?.github_user_id).toBe("7");
  });
});

describe("round 33", () => {
  /** A D1 whose batches commit, then answer with an error (a lost answer). */
  function lostAnswers(db: D1Database): D1Database {
    return new Proxy(db, {
      get(target, prop, receiver): unknown {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]): Promise<never> => {
            await target.batch(statements);
            throw new Error("connection reset");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as D1Database;
  }

  it("never lets a link confirmation whose answer was lost be replayed", async () => {
    const { handleLinkConfirm } = await import("../server/lib/web/oauth");
    const { makeEvent } = await import("./helpers");
    const { db } = createSqliteD1();
    const { kv } = createMemoryKV();
    const nonce = "b".repeat(32);
    await kv.put(
      `link:${nonce}`,
      JSON.stringify({ platform: "telegram", userId: "5", githubUserId: "A", login: "a" }),
    );
    const submit = (DB: D1Database): ReturnType<typeof makeEvent> =>
      makeEvent("/auth/github/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce }),
        env: { GITHUB_WEBHOOK_SECRET: "", KV: kv, DB },
      });
    // Committed, answer lost: still a success.
    expect(await handleLinkConfirm(submit(lostAnswers(db)))).not.toContain("链接已失效");
    // Linked to B since; replaying the old confirmation changes nothing.
    await db
      .prepare(
        "INSERT OR REPLACE INTO telegram_links (telegram_user_id, github_user_id) VALUES ('5', 'B')",
      )
      .run();
    await kv.put(
      `link:${nonce}`,
      JSON.stringify({ platform: "telegram", userId: "5", githubUserId: "A", login: "a" }),
    );
    expect(await handleLinkConfirm(submit(db))).toContain("链接已失效");
    const row = await db
      .prepare("SELECT github_user_id FROM telegram_links WHERE telegram_user_id = '5'")
      .first<{ github_user_id: string }>();
    expect(row?.github_user_id).toBe("B");
  });

  it("treats an unlink whose answer was lost as done", async () => {
    const { unlinkAsCommand } = await import("../server/lib/github/store");
    const { db } = createSqliteD1();
    const { kv } = createMemoryKV();
    await db
      .prepare("INSERT INTO telegram_links (telegram_user_id, github_user_id) VALUES ('5', 'A')")
      .run();
    await unlinkAsCommand({ DB: lostAnswers(db), KV: kv }, "telegram", "5", {
      key: "accepted:bot:telegram:x:1",
      ttl: 600,
    });
    const { idempotencyStore } = await import("../server/lib/lib/idempotency");
    expect(await idempotencyStore(db, kv).has("accepted:bot:telegram:x:1")).toBe(true);
  });

  it("reads no configuration for a request without a session", async () => {
    const { loadAuth } = await import("../server/lib/web/auth");
    const { makeEvent } = await import("./helpers");
    let reads = 0;
    const { db } = createSqliteD1();
    const counted = new Proxy(db, {
      get(target, prop, receiver): unknown {
        if (prop === "prepare") {
          return (sql: string): D1PreparedStatement => {
            if (sql.includes("d1_groups") || sql.includes("d1_routes")) reads++;
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as D1Database;
    const env: Env = { GITHUB_WEBHOOK_SECRET: "", KV: createMemoryKV().kv, DB: counted };
    expect(await loadAuth(makeEvent("/admin/api/groups", { env }))).toBeNull();
    expect(reads).toBe(0);
  });

  it("sends once to one Telegram topic written two ways", async () => {
    const posts: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      posts.push(String(url));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    try {
      const env: Env = {
        GITHUB_WEBHOOK_SECRET: "",
        TELEGRAM_TOKEN: "t",
        KV: createMemoryKV().kv,
        DB: createSqliteD1().db,
      };
      const config: Config = {
        baseUrl: "https://x",
        github: { webhookSecret: "", appId: 0, privateKey: "", clientId: "", clientSecret: "" },
        discord: { token: "" },
        routes: [
          {
            ...route("r", "g"),
            targets: [
              { platform: "telegram", chatId: "-100123", topicId: "1" },
              { platform: "telegram", chatId: "-100123", topicId: "01" },
            ],
          },
        ],
      };
      await dispatchEvent(config, { event: "push", payload: {} }, env, [
        { id: "g", name: "G", adminIds: [], instance: "i" },
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(posts.filter((u) => u.includes("/sendMessage"))).toHaveLength(1);
  });

  it("counts Telegram's limit on the text shown, not the HTML source", async () => {
    const { renderNeutralMessage } = await import("../server/lib/drivers/telegram/render");
    const html = renderNeutralMessage({ title: "t", description: "&".repeat(2000) });
    expect(html).toContain("&amp;".repeat(2000));
    const long = renderNeutralMessage({ title: "t", description: "&".repeat(5000) });
    expect(long.endsWith("…") || long.includes("…<")).toBe(true);
    expect(long).not.toMatch(/&a?m?p?…/);
  });

  it("shows a code scanning alert's security severity", async () => {
    const { formatEvent } = await import("../server/lib/formatters");
    const message = formatEvent(route("r", "g"), {
      event: "code_scanning_alert",
      payload: {
        action: "created",
        alert: {
          rule: { id: "x", severity: "error", security_severity_level: "critical" },
          state: "open",
        },
        repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
      },
    });
    expect(JSON.stringify(message)).toContain("critical");
  });
});

describe("round 34", () => {
  it("never lets a run that outlived its claim unlink a link made since", async () => {
    const { unlinkAsCommand } = await import("../server/lib/github/store");
    const { idempotencyStore } = await import("../server/lib/lib/idempotency");
    const { db } = createSqliteD1();
    const { kv } = createMemoryKV();
    // Another run finished the logout; the user linked again.
    await idempotencyStore(db, kv).claim("accepted:bot:telegram:x:9", 600);
    await db
      .prepare("INSERT INTO telegram_links (telegram_user_id, github_user_id) VALUES ('5', 'new')")
      .run();
    await unlinkAsCommand({ DB: db, KV: kv }, "telegram", "5", {
      key: "accepted:bot:telegram:x:9",
      ttl: 600,
    });
    const row = await db
      .prepare("SELECT github_user_id FROM telegram_links WHERE telegram_user_id = '5'")
      .first<{ github_user_id: string }>();
    expect(row?.github_user_id).toBe("new");
  });

  it("keeps Markdown code that looks like HTML", async () => {
    const { htmlToText } = await import("../server/lib/formatters/helpers");
    expect(htmlToText("Repro: `<MyComponent />` fails.<br>")).toBe(
      "Repro: `<MyComponent />` fails.",
    );
    expect(htmlToText("```\n<T>&amp;\n```")).toBe("```\n<T>&amp;\n```");
  });

  it("links a Gitea commit author on the Gitea host", async () => {
    const { formatEvent } = await import("../server/lib/formatters");
    const message = formatEvent(route("r", "g"), {
      event: "push",
      provider: "gitea",
      payload: {
        ref: "refs/heads/main",
        pusher: { login: "bob", username: "bob" },
        sender: { login: "bob" },
        repository: { full_name: "o/r", html_url: "https://git.example/o/r" },
        commits: [{ id: "abcdef1234567", message: "fix", author: { username: "alice" } }],
      },
    });
    const text = JSON.stringify(message);
    expect(text).toContain("https://git.example/alice");
    expect(text).not.toContain("https://github.com/alice");
  });
});

describe("round 35", () => {
  it("keeps more Markdown code forms and autolinks", async () => {
    const { htmlToText } = await import("../server/lib/formatters/helpers");
    expect(htmlToText("Use ``<Widget />`` here")).toBe("Use ``<Widget />`` here");
    expect(htmlToText('~~~\nconst x = "<tag>";\n~~~')).toBe('~~~\nconst x = "<tag>";\n~~~');
    expect(htmlToText("See <https://example.com/build>")).toBe("See <https://example.com/build>");
    expect(htmlToText("a<br>b <b>c</b>")).toBe("a\nb c");
  });

  it("refuses an exists condition whose match could not be read back", async () => {
    const { validateRoutes } = await import("../server/lib/web/admin");
    const withMatch = (match: unknown): unknown => ({
      id: "r",
      name: "r",
      enabled: true,
      groupId: "g",
      filters: [{ type: "field", path: "action", op: "exists", match }],
      targets: [{ platform: "discord", channelId: "1" }],
    });
    expect(validateRoutes([withMatch(null)]).ok).toBe(false);
    expect(validateRoutes([withMatch({ a: 1 })]).ok).toBe(false);
    const { match: _m, ...noMatch } = (
      withMatch(undefined) as { filters: Array<Record<string, unknown>> }
    ).filters[0]!;
    expect(validateRoutes([{ ...(withMatch(undefined) as object), filters: [noMatch] }]).ok).toBe(
      true,
    );
  });

  it("binds the matching groups an earlier attempt left unbound", async () => {
    const { ensureInstallationGroup } = await import("../server/lib/web/groups");
    const { createGroup, loadGroups } = await import("../server/lib/web/groups");
    const { kv } = createMemoryKV();
    await createGroup(kv, {
      id: "a",
      name: "a",
      adminIds: [],
      owners: ["acme"],
      installationId: 7,
    });
    await createGroup(kv, { id: "b", name: "b", adminIds: [], owners: ["acme"] });
    await ensureInstallationGroup(kv, 7, "acme");
    const b = (await loadGroups(kv, { fresh: true })).find((g) => g.id === "b");
    expect(b?.installationId).toBe(7);
  });
});

describe("round 36", () => {
  it("keeps Markdown code whose delimiters vary in length", async () => {
    const { htmlToText } = await import("../server/lib/formatters/helpers");
    expect(htmlToText("``a ` <T>``")).toBe("``a ` <T>``");
    expect(htmlToText("````\n```\n<a>\n```\n````")).toBe("````\n```\n<a>\n```\n````");
    expect(htmlToText("`multi\n<line>` code")).toBe("`multi\n<line>` code");
    expect(htmlToText("lone ` tick <i>y</i>")).toBe("lone ` tick y");
  });

  it("never lets a stale KV copy of a moved chain entry be adopted again", async () => {
    const { messageTracker } = await import("../server/lib/lib/message-tracker");
    const { noteKvFallback } = await import("../server/lib/storage/d1");
    const { db } = createSqliteD1();
    const { kv } = createMemoryKV();
    await noteKvFallback(kv);
    // The old entry lives in KV (written while the table was missing).
    await kv.put("msg:old:c1", JSON.stringify({ id: "m", v: 1 }));
    const tracker = messageTracker(db, kv);
    await tracker.move(
      { eventId: "old", targetId: "c1" },
      { eventId: "new", targetId: "d:c1" },
      { messageId: "m", version: 1 },
    );
    // Another location still sees the KV copy (its delete not there yet).
    await kv.put("msg:old:c1", JSON.stringify({ id: "m", v: 1 }));
    expect(await tracker.get("old", "c1")).toBeNull();
  });
});

describe("round 37", () => {
  it("keeps progressing through guilds within each run's call budget", async () => {
    const { syncGuildCommands } = await import("../server/lib/drivers/discord/commands");
    const realFetch = globalThis.fetch;
    const registered: string[] = [];
    let callsThisRun = 0;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      callsThisRun++;
      const url = new URL(String(input));
      if (url.pathname.endsWith("/users/@me/guilds")) {
        const after = Number(url.searchParams.get("after") ?? "0");
        const ids = Array.from({ length: 2000 }, (_, i) => i + 1).filter((i) => i > after);
        return new Response(JSON.stringify(ids.slice(0, 200).map((id) => ({ id: String(id) }))), {
          status: 200,
        });
      }
      if (init?.method === "PUT") registered.push(url.pathname);
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    const env = {
      GITHUB_WEBHOOK_SECRET: "",
      KV: createMemoryKV().kv,
      DB: createSqliteD1().db,
      DISCORD_TOKEN: "t",
      DISCORD_APPLICATION_ID: "app",
    };
    try {
      for (let run = 0; run < 3; run++) {
        callsThisRun = 0;
        await syncGuildCommands(env);
        expect(callsThisRun).toBeLessThanOrEqual(30);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    // Each run made progress from where the last one stopped.
    expect(new Set(registered).size).toBe(registered.length);
    expect(registered.length).toBeGreaterThan(80);
  });

  it("never provisions an installation again after its claim lapsed", async () => {
    const { processWebhook } = await import("../server/lib/webhook");
    const { resetConfigStore } = await import("../server/lib/config");
    const { loadGroups, updateGroup } = await import("../server/lib/web/groups");
    const { createHmac } = await import("crypto");
    const { db, sqlite } = createSqliteD1();
    const { kv } = createMemoryKV();
    resetConfigStore(kv);
    const env: Env = {
      GITHUB_WEBHOOK_SECRET: "global",
      KV: kv,
      DB: db,
      QUEUE: { send: async () => undefined } as unknown as Queue,
    };
    const body = JSON.stringify({
      action: "created",
      installation: { id: 321, account: { login: "acme" } },
    });
    const headers = {
      "x-github-event": "installation",
      "x-github-delivery": "inst-late",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "global").update(body).digest("hex")}`,
    };
    expect((await processWebhook(env, body, headers, () => undefined)).status).toBe(200);
    await updateGroup(kv, "inst-321", (g) => ({ ...g, installationId: undefined }));
    // The ingress dedup claim and its confirmation lapse (minutes later).
    sqlite.exec(
      "DELETE FROM dedup_keys WHERE key LIKE 'delivery:%' OR key LIKE 'accepted:delivery:%'",
    );
    expect((await processWebhook(env, body, headers, () => undefined)).status).toBe(200);
    const group = (await loadGroups(kv, { fresh: true })).find((g) => g.id === "inst-321");
    expect(group?.installationId).toBeUndefined();
  });
});

describe("round 37 markdown", () => {
  it("closes fences with their own character, keeps indented code and e-mail links", async () => {
    const { htmlToText } = await import("../server/lib/formatters/helpers");
    expect(htmlToText("~~~~\n<T>\n~~~~`\n<U>\n~~~~")).toBe("~~~~\n<T>\n~~~~`\n<U>\n~~~~");
    expect(htmlToText("text\n\n    <MyComponent />")).toBe("text\n\n    <MyComponent />");
    expect(htmlToText("mail <dev@example.com> now")).toBe("mail <dev@example.com> now");
  });
});

describe("round 38", () => {
  it("looks up a failed check suite's build log once per dispatch", async () => {
    const keys = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString(
      "base64",
    );
    const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
    let githubCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("api.github.com")) {
        githubCalls++;
        if (url.includes("access_tokens")) {
          return new Response(JSON.stringify({ token: "inst" }), { status: 201 });
        }
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const env: Env = {
        GITHUB_WEBHOOK_SECRET: "",
        DISCORD_TOKEN: "t",
        GITHUB_APP_ID: "1",
        GITHUB_PRIVATE_KEY: pem,
        KV: createMemoryKV().kv,
        DB: createSqliteD1().db,
      };
      const config: Config = {
        baseUrl: "https://x",
        github: { webhookSecret: "", appId: 0, privateKey: "", clientId: "", clientSecret: "" },
        discord: { token: "t" },
        routes: ["a", "b", "c"].map((id) => ({
          ...route(id, "g"),
          filters: [{ type: "event" as const, match: "check_suite" }],
          targets: [{ platform: "discord" as const, channelId: id }],
        })),
      };
      await dispatchEvent(
        config,
        {
          event: "check_suite",
          installationId: 5,
          payload: {
            action: "completed",
            check_suite: {
              id: 1,
              conclusion: "failure",
              check_runs_url: "https://api.github.com/repos/o/r/check-suites/1/check-runs",
            },
            repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
          },
        },
        env,
        [{ id: "g", name: "G", adminIds: [], instance: "i" }],
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    // One token and one check list for the three routes.
    expect(githubCalls).toBe(2);
  });

  it("cleans a body full of unclosed brackets in linear time", async () => {
    const { htmlToText } = await import("../server/lib/formatters/helpers");
    const started = performance.now();
    htmlToText(("<" + "x".repeat(30)).repeat(8000));
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("keeps the indent of code that opens the body", async () => {
    const { htmlToText } = await import("../server/lib/formatters/helpers");
    expect(htmlToText("    <T>\n    <U>")).toBe("    <T>\n    <U>");
    expect(htmlToText("  hi <b>x</b>  ")).toBe("hi x");
  });

  it("never binds again a group an earlier provisioning bound", async () => {
    const { ensureInstallationGroup, createGroup, loadGroups, updateGroup } =
      await import("../server/lib/web/groups");
    const { resetConfigStore, initConfigStore } = await import("../server/lib/config");
    const { db } = createSqliteD1();
    const { kv } = createMemoryKV();
    resetConfigStore(kv);
    initConfigStore({ GITHUB_WEBHOOK_SECRET: "", KV: kv, DB: db });
    await createGroup(kv, { id: "team", name: "team", adminIds: [], owners: ["acme"] });
    await ensureInstallationGroup(kv, 77, "acme", db);
    expect(
      (await loadGroups(kv, { fresh: true })).find((g) => g.id === "team")?.installationId,
    ).toBe(77);
    // An admin unbinds it; provisioning runs again (a retry of a failed attempt).
    await updateGroup(kv, "team", (g) => ({ ...g, installationId: undefined }));
    await ensureInstallationGroup(kv, 77, "acme", db);
    expect(
      (await loadGroups(kv, { fresh: true })).find((g) => g.id === "team")?.installationId,
    ).toBeUndefined();
  });
});

describe("round 39", () => {
  it("strips only the leading refs/ prefix of a branch or tag", async () => {
    const { branchLink, refUrl, shortRef } = await import("../server/lib/formatters/helpers");
    expect(shortRef("refs/heads/feature/refs/tags/test")).toBe("feature/refs/tags/test");
    expect(shortRef("refs/tags/v1/refs/tags/x")).toBe("v1/refs/tags/x");
    // Short names are taken as written (a branch may be called `refs/heads/x`).
    expect(refUrl("https://g/o/r", "refs/heads/release", "branch")).toBe(
      "https://g/o/r/tree/refs/heads/release",
    );
    expect(branchLink("https://g/o/r", "feature/refs/heads/test")).toContain(
      "/tree/feature/refs/heads/test",
    );
  });

  it("never binds a group that another attempt bound after this one checked", async () => {
    const { ensureInstallationGroup, createGroup, loadGroups } =
      await import("../server/lib/web/groups");
    const { resetConfigStore, initConfigStore } = await import("../server/lib/config");
    const { db, sqlite } = createSqliteD1();
    const { kv } = createMemoryKV();
    resetConfigStore(kv);
    initConfigStore({ GITHUB_WEBHOOK_SECRET: "", KV: kv, DB: db });
    await createGroup(kv, { id: "team", name: "team", adminIds: [], owners: ["acme"] });
    const team = (await loadGroups(kv, { fresh: true })).find((g) => g.id === "team")!;
    // This attempt's check sees no record; the record lands before its write
    // (another attempt bound the group and an admin unbound it meanwhile).
    const late = new Proxy(db, {
      get(target, prop, receiver): unknown {
        if (prop === "prepare") {
          return (sql: string): D1PreparedStatement => {
            if (sql.includes("SELECT 1 AS hit FROM dedup_keys")) {
              sqlite.exec(
                `INSERT OR REPLACE INTO dedup_keys (key, claimed_at, expires_at) VALUES ('installation-bound:88:${team.instance}', 0, ${Date.now() + 86400_000})`,
              );
              return target.prepare("SELECT 1 AS hit WHERE 0");
            }
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as D1Database;
    await ensureInstallationGroup(kv, 88, "acme", late);
    const after = (await loadGroups(kv, { fresh: true })).find((g) => g.id === "team");
    expect(after?.installationId).toBeUndefined();
  });

  it("cleans one body once for many routes", async () => {
    const { htmlToText } = await import("../server/lib/formatters/helpers");
    const body = Array.from({ length: 140 }, (_, i) => "`".repeat(i + 1) + "x")
      .join(" ")
      .slice(0, 10000);
    const started = performance.now();
    for (let i = 0; i < 50; i++) htmlToText(body);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("round 40", () => {
  it("remembers a missing fallback marker for a while (one KV read, not one per claim)", async () => {
    const { kvFallbackActive } = await import("../server/lib/storage/d1");
    const { kv } = createMemoryKV();
    let reads = 0;
    const get = kv.get.bind(kv);
    kv.get = ((...args: unknown[]) => {
      reads++;
      return (get as (...a: unknown[]) => unknown)(...args);
    }) as KVNamespace["get"];
    for (let i = 0; i < 20; i++) expect(await kvFallbackActive(kv)).toBe(false);
    expect(reads).toBe(1);
  });

  it("checks a seen fallback marker again later, so an expired one stops the KV lookups", async () => {
    const { kvFallbackActive, noteKvFallback } = await import("../server/lib/storage/d1");
    const { kv } = createMemoryKV();
    await noteKvFallback(kv);
    expect(await kvFallbackActive(kv)).toBe(true);
    // The marker expires in KV; an hour on, this isolate reads it again.
    await kv.delete("storage:kv-fallback");
    const realNow = Date.now;
    Date.now = (): number => realNow() + 2 * 3600_000;
    try {
      expect(await kvFallbackActive(kv)).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  it("keeps a refs/heads/ path inside a tag name out of the branch filter", async () => {
    const { matchRoute } = await import("../server/lib/events/match");
    const r: Route = {
      ...route("r", "g"),
      filters: [{ type: "branch", match: "refs/tags/release/main" }],
    };
    expect(
      matchRoute(r, { event: "push", payload: { ref: "refs/tags/release/refs/heads/main" } }),
    ).toBe(false);
  });

  it("names a newly pushed branch as it is", async () => {
    const { formatEvent } = await import("../server/lib/formatters");
    const text = JSON.stringify(
      formatEvent(route("r", "g"), {
        event: "push",
        payload: {
          ref: "refs/heads/feature/refs/tags/test",
          created: true,
          commits: [],
          repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
          sender: { login: "a" },
        },
      }),
    );
    expect(text).toContain("feature/refs/tags/test");
    expect(text).toContain("/tree/feature/refs/tags/test");
  });

  it("logs an error's message and stack", async () => {
    const { log } = await import("../server/lib/lib/log");
    const lines: string[] = [];
    const real = console.error;
    console.error = (line: string): void => void lines.push(line);
    try {
      log.error({ requestId: "r", err: new Error("D1: database is locked") }, "Write failed");
    } finally {
      console.error = real;
    }
    const entry = JSON.parse(lines[0]!) as {
      msg: string;
      requestId: string;
      err: { message: string };
    };
    expect(entry.msg).toBe("Write failed");
    expect(entry.requestId).toBe("r");
    expect(entry.err.message).toBe("D1: database is locked");
  });
});

describe("round 41", () => {
  it("never takes a branch named refs/tags/… for a tag", async () => {
    const { formatEvent } = await import("../server/lib/formatters");
    const text = JSON.stringify(
      formatEvent(route("r", "g"), {
        event: "push",
        payload: {
          ref: "refs/heads/refs/tags/release",
          commits: [{ id: "abcdef1234567", message: "fix", author: { username: "a" } }],
          repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
          sender: { login: "a" },
          pusher: { name: "a" },
        },
      }),
    );
    expect(text).not.toContain("tag: release");
    expect(text).toContain("refs/tags/release");
  });
});

describe("quota", () => {
  it("writes nothing when a guild command sync finds nothing to do", async () => {
    const { syncGuildCommands } = await import("../server/lib/drivers/discord/commands");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/users/@me/guilds")) {
        return new Response(JSON.stringify([{ id: "1" }]), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    const { kv } = createMemoryKV();
    const env = {
      GITHUB_WEBHOOK_SECRET: "",
      KV: kv,
      DB: createSqliteD1().db,
      DISCORD_TOKEN: "t",
      DISCORD_APPLICATION_ID: "app",
    };
    try {
      await syncGuildCommands(env);
      let writes = 0;
      const put = kv.put.bind(kv);
      kv.put = ((...args: unknown[]) => {
        writes++;
        return (put as (...a: unknown[]) => unknown)(...args);
      }) as KVNamespace["put"];
      await syncGuildCommands(env);
      await syncGuildCommands(env);
      expect(writes).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("round 42", () => {
  it("keeps a KV-only chain entry when its move to D1 fails", async () => {
    const { messageTracker } = await import("../server/lib/lib/message-tracker");
    const { noteKvFallback } = await import("../server/lib/storage/d1");
    const { db } = createSqliteD1();
    const { kv } = createMemoryKV();
    await noteKvFallback(kv);
    await kv.put("msg:old:c1", JSON.stringify({ id: "m", v: 1 }));
    const failing = new Proxy(db, {
      get(target, prop, receiver): unknown {
        if (prop === "batch")
          return async (): Promise<never> => Promise.reject(new Error("D1 down"));
        return Reflect.get(target, prop, receiver);
      },
    }) as D1Database;
    const tracker = messageTracker(failing, kv);
    await expect(
      tracker.move(
        { eventId: "old", targetId: "c1" },
        { eventId: "new", targetId: "d:c1" },
        { messageId: "m", version: 1 },
      ),
    ).rejects.toThrow();
    expect((await tracker.get("old", "c1"))?.messageId).toBe("m");
  });
});

describe("round 43", () => {
  it("reaches the guilds after a page whose registrations kept failing", async () => {
    const { syncGuildCommands } = await import("../server/lib/drivers/discord/commands");
    const realFetch = globalThis.fetch;
    const put: string[] = [];
    globalThis.fetch = (async (input: unknown, _init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/users/@me/guilds")) {
        const after = Number(url.searchParams.get("after") ?? "0");
        const ids = Array.from({ length: 201 }, (_, i) => i + 1).filter((i) => i > after);
        return new Response(JSON.stringify(ids.slice(0, 200).map((id) => ({ id: String(id) }))), {
          status: 200,
        });
      }
      const guild = Number(url.pathname.split("/guilds/")[1]?.split("/")[0]);
      put.push(String(guild));
      return new Response("[]", { status: guild >= 172 && guild <= 200 ? 500 : 200 });
    }) as unknown as typeof fetch;
    const env = {
      GITHUB_WEBHOOK_SECRET: "",
      KV: createMemoryKV().kv,
      DB: createSqliteD1().db,
      DISCORD_TOKEN: "t",
      DISCORD_APPLICATION_ID: "app",
    };
    try {
      for (let run = 0; run < 12; run++) await syncGuildCommands(env);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(put).toContain("201");
  });
});

describe("quota review 1", () => {
  it("fetches and stores one Feishu token for parallel sends", async () => {
    const { getTenantAccessToken } = await import("../server/lib/drivers/feishu/rest");
    const { kv } = createMemoryKV();
    let fetches = 0;
    let writes = 0;
    const put = kv.put.bind(kv);
    kv.put = ((...args: unknown[]) => {
      writes++;
      return (put as (...a: unknown[]) => unknown)(...args);
    }) as KVNamespace["put"];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response(JSON.stringify({ code: 0, tenant_access_token: "t", expire: 7200 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    try {
      const env: Env = {
        GITHUB_WEBHOOK_SECRET: "",
        KV: kv,
        DB: createSqliteD1().db,
        FEISHU_APP_ID: "cli_quota",
        FEISHU_APP_SECRET: "s",
      };
      const results = await Promise.all(Array.from({ length: 5 }, () => getTenantAccessToken(env)));
      expect(results.every((r) => r.token === "t")).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetches).toBe(1);
    expect(writes).toBe(1);
  });

  it("registers an unchanged Telegram webhook once, not on every cron run", async () => {
    const { syncTelegramWebhook } = await import("../server/lib/drivers/telegram/commands");
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const env: Env = {
      GITHUB_WEBHOOK_SECRET: "",
      KV: createMemoryKV().kv,
      DB: createSqliteD1().db,
      TELEGRAM_TOKEN: "1:x",
      BASE_URL: "https://hooks.example",
    };
    try {
      for (let i = 0; i < 3; i++) await syncTelegramWebhook(env);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toBe(1);
  });

  it("does not read KV again for a language without an override", async () => {
    const { loadTranslations } = await import("../server/lib/lib/i18n");
    let reads = 0;
    const kv = {
      get: async (): Promise<null> => {
        reads++;
        return null;
      },
    };
    for (let i = 0; i < 5; i++) await loadTranslations("xx-quota", kv);
    expect(reads).toBe(1);
  });
});

describe("quota review 5", () => {
  const feishuEnv = (kv: KVNamespace, appId: string): Env => ({
    GITHUB_WEBHOOK_SECRET: "",
    KV: kv,
    DB: createSqliteD1().db,
    FEISHU_APP_ID: appId,
    FEISHU_APP_SECRET: "s",
  });

  it("answers targets after a failed Feishu token request from memory for a moment", async () => {
    const { getTenantAccessToken } = await import("../server/lib/drivers/feishu/rest");
    const { kv } = createMemoryKV();
    let fetches = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response(JSON.stringify({ code: 99991663, msg: "app ticket invalid" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    try {
      const env = feishuEnv(kv, "cli_fail_cache");
      for (let i = 0; i < 5; i++) expect((await getTenantAccessToken(env)).ok).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetches).toBe(1);
  });

  it("keeps a Feishu token in KV only while a held copy would still be valid", async () => {
    const { getTenantAccessToken, tokenKey } = await import("../server/lib/drivers/feishu/rest");
    const { kv } = createMemoryKV();
    const ttls: number[] = [];
    const put = kv.put.bind(kv);
    kv.put = ((key: string, value: string, opts?: { expirationTtl?: number }) => {
      ttls.push(opts?.expirationTtl ?? 0);
      return put(key, value, opts);
    }) as KVNamespace["put"];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: 0, tenant_access_token: "t", expire: 7200 }), {
        status: 200,
      })) as unknown as typeof fetch;
    try {
      const env = feishuEnv(kv, "cli_ttl");
      expect((await getTenantAccessToken(env)).token).toBe("t");
      expect(await kv.get(tokenKey(env))).toBe("t");
    } finally {
      globalThis.fetch = realFetch;
    }
    // 7200 s token: out of KV 60 s + one hold (300 s) before it expires.
    expect(ttls).toEqual([7200 - 60 - 300]);
  });

  it("drops a rejected Feishu token once, and never a newer one", async () => {
    const { forgetRejectedToken, tokenKey } = await import("../server/lib/drivers/feishu/rest");
    const { kv } = createMemoryKV();
    const env = feishuEnv(kv, "cli_forget");
    let deletes = 0;
    const del = kv.delete.bind(kv);
    kv.delete = ((key: string) => {
      deletes++;
      return del(key);
    }) as KVNamespace["delete"];
    await kv.put(tokenKey(env), "old");
    const refused = { ok: false, errorCode: "FEISHU_TOKEN" };
    for (let i = 0; i < 5; i++) await forgetRejectedToken(refused, env, "old");
    expect(deletes).toBe(1);
    // A late refusal of an older token leaves the token stored since alone.
    await kv.put(tokenKey(env), "new");
    await forgetRejectedToken(refused, env, "older");
    expect(await kv.get(tokenKey(env))).toBe("new");
  });

  it("serves recent failures and a group's audit log from indexes", () => {
    const { sqlite } = createSqliteD1();
    const plan = (sql: string): string =>
      (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
        .map((r) => r.detail)
        .join("; ");
    expect(plan("SELECT id FROM send_logs WHERE ok = 0 ORDER BY ts DESC LIMIT 20")).toContain(
      "idx_send_logs_failed_ts",
    );
    expect(
      plan("SELECT id FROM send_logs WHERE ok = 0 AND group_id = 'g' ORDER BY ts DESC LIMIT 20"),
    ).toContain("idx_send_logs_failed_group_ts");
    const audit = plan("SELECT id FROM audit_logs WHERE group_id = 'g' ORDER BY ts DESC LIMIT 50");
    expect(audit).toContain("idx_audit_group_ts");
    expect(audit).not.toContain("TEMP B-TREE");
  });
});

describe("quota review 6", () => {
  it("shares one fallback marker read among concurrent checks", async () => {
    const { kvFallbackActive } = await import("../server/lib/storage/d1");
    const { kv } = createMemoryKV();
    let reads = 0;
    const get = kv.get.bind(kv);
    kv.get = ((...args: unknown[]) => {
      reads++;
      return (get as (...a: unknown[]) => unknown)(...args);
    }) as KVNamespace["get"];
    const results = await Promise.all(Array.from({ length: 20 }, () => kvFallbackActive(kv)));
    expect(results.every((r) => r === false)).toBe(true);
    expect(reads).toBe(1);
  });

  it("runs a cold store's setup once for concurrent requests", async () => {
    const { initConfigStore, loadConfigSnapshot } = await import("../server/lib/config");
    const { db } = createSqliteD1();
    const { kv } = createMemoryKV();
    let seedReads = 0;
    const get = kv.get.bind(kv);
    kv.get = ((key: string, ...rest: unknown[]) => {
      if (key === "config:d1-seeded") seedReads++;
      return (get as (...a: unknown[]) => unknown)(key, ...rest);
    }) as KVNamespace["get"];
    const env: Env = { GITHUB_WEBHOOK_SECRET: "", KV: kv, DB: db };
    initConfigStore(env);
    await Promise.all(Array.from({ length: 20 }, () => loadConfigSnapshot(env, { fresh: true })));
    expect(seedReads).toBe(1);
  });

  it("holds a Feishu token it could not share in KV until it nears expiry", async () => {
    const { getTenantAccessToken } = await import("../server/lib/drivers/feishu/rest");
    const { kv } = createMemoryKV();
    kv.put = (async () => {
      throw new Error("KV put() limit exceeded for the day");
    }) as KVNamespace["put"];
    let fetches = 0;
    const realFetch = globalThis.fetch;
    const realNow = Date.now;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response(JSON.stringify({ code: 0, tenant_access_token: "t", expire: 7200 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    try {
      const env: Env = {
        GITHUB_WEBHOOK_SECRET: "",
        KV: kv,
        DB: createSqliteD1().db,
        FEISHU_APP_ID: "cli_no_kv",
        FEISHU_APP_SECRET: "s",
      };
      expect((await getTenantAccessToken(env)).token).toBe("t");
      // An hour on (well past the usual few minutes in memory): still held.
      Date.now = (): number => realNow() + 3600_000;
      expect((await getTenantAccessToken(env)).token).toBe("t");
    } finally {
      globalThis.fetch = realFetch;
      Date.now = realNow;
    }
    expect(fetches).toBe(1);
  });
});

describe("quota review 7 (partial)", () => {
  it("writes the fallback marker once for concurrent fallbacks", async () => {
    const { noteKvFallback } = await import("../server/lib/storage/d1");
    const { kv } = createMemoryKV();
    let writes = 0;
    const put = kv.put.bind(kv);
    kv.put = ((...args: Parameters<KVNamespace["put"]>) => {
      writes++;
      return put(...args);
    }) as KVNamespace["put"];
    await Promise.all(Array.from({ length: 20 }, () => noteKvFallback(kv)));
    expect(writes).toBe(1);
  });

  it("reads a language override once for concurrent asks", async () => {
    const { loadTranslations } = await import("../server/lib/lib/i18n");
    let reads = 0;
    const kv = {
      get: async <T>(): Promise<T | null> => {
        reads++;
        return null;
      },
    };
    await Promise.all(Array.from({ length: 20 }, () => loadTranslations("xx-concurrent", kv)));
    expect(reads).toBe(1);
  });

  it("does not ask GitHub again right after an installation token exchange failed", async () => {
    const { getInstallationToken } = await import("../server/lib/github/app-token");
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    let requests = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      requests++;
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    try {
      for (let i = 0; i < 3; i++) {
        expect(await getInstallationToken("1", pem, 777001)).toBeUndefined();
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(requests).toBe(1);
  });
});

describe("round 52", () => {
  it("never waits on another request's run past its limit", async () => {
    const { sharedFlight } = await import("../server/lib/lib/shared-flight");
    const flights = new Map<string, { promise: Promise<string>; startedAt: number }>();
    // A run whose request was canceled: it never settles, its cleanup never runs.
    flights.set("k", { promise: new Promise<string>(() => {}), startedAt: Date.now() });
    const started = performance.now();
    expect(await sharedFlight(flights, "k", async () => "own", 30)).toBe("own");
    expect(performance.now() - started).toBeLessThan(1000);
    // A run that old is not joined at all.
    flights.set("k", { promise: new Promise<string>(() => {}), startedAt: Date.now() - 60 });
    expect(await sharedFlight(flights, "k", async () => "fresh", 30)).toBe("fresh");
    expect(flights.has("k")).toBe(false);
  });

  it("replaces a stuck run once for all its waiters", async () => {
    const { sharedFlight } = await import("../server/lib/lib/shared-flight");
    const flights = new Map<string, { promise: Promise<string>; startedAt: number }>();
    flights.set("k", { promise: new Promise<string>(() => {}), startedAt: Date.now() });
    let runs = 0;
    const run = async (): Promise<string> => {
      runs++;
      await new Promise((r) => setTimeout(r, 20));
      return "replaced";
    };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => sharedFlight(flights, "k", run, 30)),
    );
    expect(results.every((r) => r === "replaced")).toBe(true);
    expect(runs).toBe(1);
  });

  it("lets every waiter of a stuck run take a replacement that already finished", async () => {
    const { sharedFlight } = await import("../server/lib/lib/shared-flight");
    const flights = new Map<string, { promise: Promise<string>; startedAt: number }>();
    flights.set("k", { promise: new Promise<string>(() => {}), startedAt: Date.now() });
    let runs = 0;
    // Finishes (and leaves the map) before the other waiters wake up.
    const run = async (): Promise<string> => {
      runs++;
      return "replaced";
    };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => sharedFlight(flights, "k", run, 30)),
    );
    expect(results.every((r) => r === "replaced")).toBe(true);
    expect(runs).toBe(1);
  });

  it("runs alone, unpublished, after finding three runs stuck", async () => {
    const { sharedFlight } = await import("../server/lib/lib/shared-flight");
    type F = { promise: Promise<string>; startedAt: number; replacedBy?: F };
    const stuck = (): F => ({ promise: new Promise<string>(() => {}), startedAt: Date.now() });
    const first = stuck();
    first.replacedBy = stuck();
    first.replacedBy.replacedBy = stuck();
    const flights = new Map<string, F>([["k", first]]);
    expect(await sharedFlight(flights, "k", async () => "alone", 20)).toBe("alone");
    expect(flights.get("k")).toBe(first);
  });

  it("shares a run that is still in time", async () => {
    const { sharedFlight } = await import("../server/lib/lib/shared-flight");
    const flights = new Map<string, { promise: Promise<number>; startedAt: number }>();
    let runs = 0;
    const run = async (): Promise<number> => {
      runs++;
      await new Promise((r) => setTimeout(r, 10));
      return runs;
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => sharedFlight(flights, "k", run, 1000)),
    );
    expect(results).toEqual([1, 1, 1, 1, 1]);
    expect(runs).toBe(1);
  });

  it("does not take a refused Feishu token back from KV when deleting it failed", async () => {
    const { forgetRejectedToken, getTenantAccessToken, tokenKey } =
      await import("../server/lib/drivers/feishu/rest");
    const { kv } = createMemoryKV();
    const env: Env = {
      GITHUB_WEBHOOK_SECRET: "",
      KV: kv,
      DB: createSqliteD1().db,
      FEISHU_APP_ID: "cli_refused",
      FEISHU_APP_SECRET: "s",
    };
    await kv.put(tokenKey(env), "refused");
    const del = kv.delete.bind(kv);
    kv.delete = (async () => {
      throw new Error("KV delete failed");
    }) as KVNamespace["delete"];
    await forgetRejectedToken({ ok: false, errorCode: "FEISHU_TOKEN" }, env, "refused");
    kv.delete = del;
    let fetches = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response(JSON.stringify({ code: 0, tenant_access_token: "new", expire: 7200 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    try {
      expect((await getTenantAccessToken(env)).token).toBe("new");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetches).toBe(1);
  });

  it("registers a Telegram webhook switched back to an earlier setting again", async () => {
    const { syncTelegramWebhook } = await import("../server/lib/drivers/telegram/commands");
    const { kv } = createMemoryKV();
    const urls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      urls.push(String(JSON.parse(String(init?.body)).url));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      for (const base of ["https://a.example", "https://b.example", "https://a.example"]) {
        await syncTelegramWebhook({
          GITHUB_WEBHOOK_SECRET: "",
          KV: kv,
          TELEGRAM_TOKEN: "77:switch",
          BASE_URL: base,
        });
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(urls).toEqual([
      "https://a.example/telegram/webhook",
      "https://b.example/telegram/webhook",
      "https://a.example/telegram/webhook",
    ]);
  });
});
