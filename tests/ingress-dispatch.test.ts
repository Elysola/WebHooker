import { describe, it, expect, afterEach } from "bun:test";
import { createHmac } from "crypto";
import { processWebhook } from "../server/lib/webhook";
import { dispatchEvent } from "../server/lib/core/dispatch";
import { resetConfigStore } from "../server/lib/config";
import { githubApiUrl } from "../server/lib/github/app-token";
import { htmlToText } from "../server/lib/formatters/helpers";
import { formatEvent } from "../server/lib/formatters";
import { renderNeutralMessage as renderTelegram } from "../server/lib/drivers/telegram/render";
import { createMemoryKV, createSqliteD1 } from "./d1-sqlite";
import type { Config, Env, Group, Route } from "../server/lib/types";
import type { DeliveryMessage, DispatchSummary } from "../server/lib/queue/delivery";

const restoredFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = restoredFetch;
});

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function config(routes: Route[]): Config {
  return {
    baseUrl: "https://x",
    github: { webhookSecret: "", appId: 0, privateKey: "", clientId: "", clientSecret: "" },
    discord: { token: "t" },
    routes,
  };
}

function route(id: string, groupId: string, extra: Partial<Route> = {}): Route {
  return {
    id,
    name: id,
    enabled: true,
    filters: [{ type: "event", match: ["push", "workflow_run", "issues"] }],
    targets: [{ platform: "discord", channelId: "c1" }],
    groupId,
    ...extra,
  };
}

const group = (id: string, extra: Partial<Group> = {}): Group => ({
  id,
  name: id,
  adminIds: [],
  ...extra,
});

describe("webhook ingress", () => {
  function tenantEnv(queue?: Queue, routes: Route[] = [route("r", "team")]): Env {
    const { kv, store } = createMemoryKV();
    store.set("config:groups", JSON.stringify([group("team")]));
    store.set("config:routes", JSON.stringify(routes));
    store.set("tenant:team", "tenant-secret");
    resetConfigStore(kv);
    return {
      GITHUB_WEBHOOK_SECRET: "global",
      DISCORD_TOKEN: "t",
      KV: kv,
      DB: {} as D1Database,
      QUEUE: queue,
    };
  }

  it("never lets an accepted installation event provision again when redelivered", async () => {
    const sent: DeliveryMessage[] = [];
    const queue = { send: async (m: DeliveryMessage) => void sent.push(m) } as unknown as Queue;
    const env = tenantEnv(queue);
    const body = JSON.stringify({
      action: "created",
      installation: { id: 123, account: { login: "acme" } },
    });
    const headers = {
      "x-github-event": "installation",
      "x-github-delivery": "inst-dup",
      "x-hub-signature-256": sign(body, "global"),
    };
    expect((await processWebhook(env, body, headers, () => undefined)).status).toBe(200);
    const { loadGroups, updateGroup } = await import("../server/lib/web/groups");
    const created = (await loadGroups(env.KV, { fresh: true })).find((g) => g.id === "inst-123");
    expect(created?.installationId).toBe(123);
    // A super admin unbinds it; the same delivery arrives again.
    await updateGroup(env.KV, "inst-123", (g) => ({ ...g, installationId: undefined }));
    const again = await processWebhook(env, body, headers, () => undefined);
    expect(again.body).toMatchObject({ duplicate: true });
    const after = (await loadGroups(env.KV, { fresh: true })).find((g) => g.id === "inst-123");
    expect(after?.installationId).toBeUndefined();
  });

  it("asks for a retry when installation provisioning failed, queueing nothing", async () => {
    const sent: DeliveryMessage[] = [];
    const queue = { send: async (m: DeliveryMessage) => void sent.push(m) } as unknown as Queue;
    const env = tenantEnv(queue);
    const kvPut = env.KV.put.bind(env.KV);
    env.KV.put = (async (key: string, ...rest: unknown[]): Promise<void> =>
      key === "config:groups"
        ? Promise.reject(new Error("KV down"))
        : (kvPut as (...a: unknown[]) => Promise<void>)(key, ...rest)) as KVNamespace["put"];
    const body = JSON.stringify({
      action: "created",
      installation: { id: 99, account: { login: "acme" } },
    });
    const res = await processWebhook(
      env,
      body,
      {
        "x-github-event": "installation",
        "x-github-delivery": "inst-1",
        "x-hub-signature-256": sign(body, "global"),
      },
      () => undefined,
    );
    expect(res.status).toBe(503);
    expect(sent).toHaveLength(0);
  });

  it("never passes a claim it could not give back for an accepted duplicate", async () => {
    let fail = true;
    const sent: DeliveryMessage[] = [];
    const queue = {
      send: async (m: DeliveryMessage) => {
        if (fail) throw new Error("queue down");
        sent.push(m);
      },
    } as unknown as Queue;
    const env = tenantEnv(queue);
    // Giving the claim back fails too.
    const kvDelete = env.KV.delete.bind(env.KV);
    env.KV.delete = async (key: string): Promise<void> =>
      key.startsWith("delivery:") ? Promise.reject(new Error("KV down")) : kvDelete(key);
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const headers = {
      "x-github-event": "push",
      "x-github-delivery": "d-3",
      "x-hub-signature-256": sign(body, "tenant-secret"),
    };
    expect((await processWebhook(env, body, headers, () => undefined, "team")).status).toBe(503);
    fail = false;
    // The leftover claim is not confirmed: the retry is told to come back,
    // never acknowledged as a duplicate of an event that was never queued.
    const retry = await processWebhook(env, body, headers, () => undefined, "team");
    expect(retry.status).toBe(503);
    expect(sent).toHaveLength(0);
  });

  it("keeps one delivery identity for a nonce-signed request retried after an unclear enqueue", async () => {
    const sent: DeliveryMessage[] = [];
    let first = true;
    const queue = {
      send: async (m: DeliveryMessage) => {
        sent.push(m);
        // The queue took it, but the answer was lost.
        if (first) {
          first = false;
          throw new Error("connection reset");
        }
      },
    } as unknown as Queue;
    const env = tenantEnv(queue);
    const body = JSON.stringify({ alert: "disk full" });
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = {
      "x-webhooker-signature": `sha256=${createHmac("sha256", "tenant-secret")
        .update(`${ts}.n-1.${body}`)
        .digest("hex")}`,
      "x-webhooker-timestamp": ts,
      "x-webhooker-nonce": "n-1",
    };
    expect((await processWebhook(env, body, headers, () => undefined, "team")).status).toBe(503);
    expect((await processWebhook(env, body, headers, () => undefined, "team")).status).toBe(200);
    expect(sent).toHaveLength(2);
    // Same delivery: the consumer recognizes the second copy.
    expect(sent[1]!.deliveryId).toBe(sent[0]!.deliveryId);
  });

  it("asks for a retry on a transient failure even without a delivery id", async () => {
    const env = tenantEnv(undefined, [
      route("r", "team", {
        event: undefined,
        filters: [{ type: "event", match: "custom" }],
        targets: [
          { platform: "discord", channelId: "ok" },
          { platform: "discord", channelId: "flaky" },
        ],
      }),
    ]);
    globalThis.fetch = async (input): Promise<Response> =>
      String(input).includes("/channels/flaky/")
        ? new Response(JSON.stringify({ retry_after: 999 }), { status: 429 })
        : new Response(JSON.stringify({ id: "m" }), { status: 200 });
    const body = JSON.stringify({ alert: "disk full" });
    const headers = { "x-webhooker-signature": sign(body, "tenant-secret") };
    // No identity to skip what was sent: a duplicate beats a lost target.
    const res = await processWebhook(env, body, headers, () => undefined, "team");
    expect(res.status).toBe(503);
  });

  it("answers an inline dispatch after it ran and asks for a retry on a transient failure", async () => {
    const env = tenantEnv(undefined, [
      route("r", "team", {
        targets: [
          { platform: "discord", channelId: "ok" },
          { platform: "discord", channelId: "flaky" },
        ],
      }),
    ]);
    const calls: Record<string, number> = {};
    let limited = true;
    globalThis.fetch = async (input): Promise<Response> => {
      const channel = String(input).split("/channels/")[1]!.split("/")[0]!;
      calls[channel] = (calls[channel] ?? 0) + 1;
      if (channel === "flaky" && limited) {
        return new Response(JSON.stringify({ retry_after: 999 }), { status: 429 });
      }
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    };
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const headers = {
      "x-github-event": "push",
      "x-github-delivery": "d-4",
      "x-hub-signature-256": sign(body, "tenant-secret"),
    };
    const first = await processWebhook(env, body, headers, () => undefined, "team");
    expect(first.status).toBe(503);
    limited = false;
    const retry = await processWebhook(env, body, headers, () => undefined, "team");
    expect(retry.status).toBe(200);
    // The target sent the first time is not sent again.
    expect(calls).toEqual({ ok: 1, flaky: 2 });
    const again = await processWebhook(env, body, headers, () => undefined, "team");
    expect(again.body).toMatchObject({ duplicate: true });
  });

  it("answers 503 and releases the dedup claim when the queue rejects the event", async () => {
    let fail = true;
    const sent: DeliveryMessage[] = [];
    const queue = {
      send: async (m: DeliveryMessage) => {
        if (fail) throw new Error("queue down");
        sent.push(m);
      },
    } as unknown as Queue;
    const env = tenantEnv(queue);
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const headers = {
      "x-github-event": "push",
      "x-github-delivery": "d-1",
      "x-hub-signature-256": sign(body, "tenant-secret"),
    };
    const first = await processWebhook(env, body, headers, () => undefined, "team");
    expect(first.status).toBe(503);
    fail = false;
    // The sender's redelivery is accepted, not dropped as a duplicate.
    const retry = await processWebhook(env, body, headers, () => undefined, "team");
    expect(retry.status).toBe(200);
    expect((retry.body as { duplicate?: boolean }).duplicate).toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  it("drops the installation claim of tenant-signed payloads", async () => {
    const sent: DeliveryMessage[] = [];
    const queue = { send: async (m: DeliveryMessage) => void sent.push(m) } as unknown as Queue;
    const env = tenantEnv(queue);
    const body = JSON.stringify({
      action: "created",
      installation: { id: 999, account: { login: "victim" } },
    });
    const headers = {
      "x-github-event": "installation",
      "x-github-delivery": "d-2",
      "x-hub-signature-256": sign(body, "tenant-secret"),
    };
    const res = await processWebhook(env, body, headers, () => undefined, "team");
    expect(res.status).toBe(200);
    expect(sent[0]!.installationId).toBeUndefined();
    // No group was provisioned for the claimed installation.
    const groups = JSON.parse((await env.KV.get("config:groups"))!) as Group[];
    expect(groups.map((g) => g.id)).toEqual(["team"]);
  });

  it("never lets a custom delivery id take the key of a nonce-identified request", async () => {
    const env = tenantEnv(undefined, [
      route("r", "team", {
        event: undefined,
        filters: [{ type: "event", match: "custom" }],
        targets: [{ platform: "discord", channelId: "ok" }],
      }),
    ]);
    let sends = 0;
    globalThis.fetch = async (): Promise<Response> => {
      sends++;
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    };
    const { replayNonceKey } = await import("../server/lib/providers/custom");
    const nonce = "n-77";
    // Event A names, as its delivery id, exactly the identity event B's nonce gets.
    const a = JSON.stringify({ deliveryId: `n:${await replayNonceKey("tenant-secret", nonce)}` });
    expect(
      (
        await processWebhook(
          env,
          a,
          { "x-webhooker-signature": sign(a, "tenant-secret") },
          () => undefined,
          "team",
        )
      ).status,
    ).toBe(200);
    const b = JSON.stringify({ alert: "other event" });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await processWebhook(
      env,
      b,
      {
        "x-webhooker-signature": `sha256=${createHmac("sha256", "tenant-secret")
          .update(`${ts}.${nonce}.${b}`)
          .digest("hex")}`,
        "x-webhooker-timestamp": ts,
        "x-webhooker-nonce": nonce,
      },
      () => undefined,
      "team",
    );
    expect(res.status).toBe(200);
    expect((res.body as { duplicate?: boolean }).duplicate).toBeUndefined();
    expect(sends).toBe(2);
  });
});

describe("dispatch", () => {
  function env(): Env {
    return { GITHUB_WEBHOOK_SECRET: "", KV: createMemoryKV().kv, DB: createSqliteD1().db };
  }

  it("records a formatter crash as a permanent failure instead of dropping it", async () => {
    globalThis.fetch = async (): Promise<Response> => new Response("{}", { status: 200 });
    const e = env();
    const summary = await dispatchEvent(
      config([route("r", "g")]),
      // `issue: null` makes the issues formatter throw.
      { event: "issues", payload: { issue: null } as never },
      e,
      [group("g")],
    );
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]!.errorCode).toBe("FORMAT");
  });

  it("skips targets a previous attempt already finished", async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input): Promise<Response> => {
      urls.push(String(input));
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    };
    const r = route("r", "g", {
      targets: [
        { platform: "discord", channelId: "done" },
        { platform: "discord", channelId: "todo" },
      ],
    });
    const summary = await dispatchEvent(
      config([r]),
      { event: "push", payload: {} },
      env(),
      [group("g")],
      { skipTarget: async (key) => key.endsWith(":done") },
    );
    expect(urls.some((u) => u.includes("/done/"))).toBe(false);
    expect(urls.some((u) => u.includes("/todo/"))).toBe(true);
    expect(summary.succeeded).toEqual(["g:r:discord:todo"]);
  });

  it("never mints App tokens for tenant events and only calls the GitHub API", async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input): Promise<Response> => {
      urls.push(String(input));
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    };
    const e = { ...env(), GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "pem" };
    await dispatchEvent(
      config([route("r", "g")]),
      {
        event: "workflow_run",
        payload: { workflow_run: { id: 1, jobs_url: "https://evil.example/steal" } },
        installationId: 42,
      },
      e,
      [group("g")],
      { tenantId: "g" },
    );
    expect(urls.some((u) => u.includes("evil.example"))).toBe(false);
    expect(urls.some((u) => u.includes("access_tokens"))).toBe(false);
  });

  it("keeps editing the same message after a transient edit failure", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    let editStatus = 200;
    globalThis.fetch = async (input, init): Promise<Response> => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(input) });
      if (method === "PATCH") {
        return editStatus === 200
          ? new Response(JSON.stringify({ id: "m1" }), { status: 200 })
          : new Response("bad request", { status: editStatus });
      }
      return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
    };
    const e = env();
    const run = (status: string, updated: string): Promise<DispatchSummary> =>
      dispatchEvent(
        config([route("r", "g")]),
        {
          event: "workflow_run",
          provider: "github",
          payload: {
            action: "in_progress",
            repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
            workflow_run: { id: 7, status, name: "CI", updated_at: updated, jobs: [{}] },
          },
        },
        e,
        [group("g")],
      );
    await run("queued", "2026-01-01T00:00:00Z");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    editStatus = 400;
    const failed = await run("in_progress", "2026-01-01T00:01:00Z");
    expect(failed.failures).toHaveLength(1);
    // No second message was posted for the same chain.
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    editStatus = 200;
    // An older event arriving late does not overwrite the newer state.
    const before = calls.length;
    await run("queued", "2025-12-31T00:00:00Z");
    expect(calls.length).toBe(before);
  });

  it("separates update chains of two forges with the same repository name", async () => {
    const posts: string[] = [];
    globalThis.fetch = async (input, init): Promise<Response> => {
      if ((init?.method ?? "GET") === "POST") posts.push(String(input));
      return new Response(JSON.stringify({ id: `m${posts.length}` }), { status: 200 });
    };
    const e = env();
    for (const host of ["git1.example.com", "git2.example.com"]) {
      await dispatchEvent(
        config([route("r", "g")]),
        {
          event: "workflow_run",
          provider: "gitea",
          payload: {
            repository: { full_name: "o/r", html_url: `https://${host}/o/r` },
            workflow_run: { id: 7, status: "queued", name: "CI", jobs: [{}] },
          },
        },
        e,
        [group("g")],
      );
    }
    expect(posts).toHaveLength(2);
  });
});

describe("formatting safety", () => {
  it("keeps out-of-range character references verbatim", () => {
    expect(htmlToText("a &#1114112; b &#x41;")).toBe("a &#1114112; b A");
  });

  it("offers merge/close buttons only for github.com", () => {
    const payload = {
      action: "opened",
      repository: { full_name: "o/r", html_url: "https://gitea.example/o/r" },
      pull_request: { number: 1, state: "open", title: "t" },
    };
    const r = route("r", "g");
    expect(formatEvent(r, { event: "pull_request", provider: "gitea", payload }).actions).toBe(
      undefined,
    );
    const gh = {
      ...payload,
      repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
    };
    expect(
      formatEvent(r, { event: "pull_request", provider: "github", payload: gh }).actions,
    ).toHaveLength(2);
  });

  it("shows the deployment state, not the status object", () => {
    const message = formatEvent(route("r", "g"), {
      event: "deployment_status",
      payload: {
        repository: { full_name: "o/r" },
        deployment_status: { state: "success", environment: "prod" },
        deployment: { id: 1 },
      },
    });
    const status = message.fields!.find((f) => /status/i.test(f.name))!;
    expect(status.value).toContain("success");
    expect(status.value).not.toContain("[object Object]");
  });

  it("drops Telegram's author emoji when the group turned emoji off", () => {
    const html = renderTelegram({ title: "t", author: { name: "bob" }, emoji: false });
    expect(html).not.toContain("👤");
  });

  it("accepts only GitHub REST repository URLs for enrichment", () => {
    expect(githubApiUrl("https://api.github.com/repos/o/r/actions/runs/1/jobs")).not.toBeNull();
    expect(githubApiUrl("https://evil.example/repos/o/r")).toBeNull();
    expect(githubApiUrl("http://api.github.com/repos/o/r")).toBeNull();
    expect(githubApiUrl("https://api.github.com/user")).toBeNull();
  });
});

describe("round-trip safety", () => {
  it("records an unreadable delivery ledger as a retryable failure", async () => {
    globalThis.fetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ id: "m" }), { status: 200 });
    const summary = await dispatchEvent(
      config([route("r", "g")]),
      { event: "push", payload: {} },
      { GITHUB_WEBHOOK_SECRET: "", KV: createMemoryKV().kv, DB: createSqliteD1().db },
      [group("g")],
      {
        skipTarget: async () => {
          throw new Error("D1 down");
        },
      },
    );
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]!.errorCode).toBeUndefined();
  });

  it("gives the custom-webhook nonce back when the queue rejects the event", async () => {
    const { kv, store } = createMemoryKV();
    store.set("config:groups", JSON.stringify([group("team")]));
    store.set("tenant:team", "tenant-secret");
    resetConfigStore(kv);
    let fail = true;
    const queue = {
      send: async (): Promise<void> => {
        if (fail) throw new Error("queue down");
      },
    } as unknown as Queue;
    const env: Env = { GITHUB_WEBHOOK_SECRET: "g", KV: kv, DB: {} as D1Database, QUEUE: queue };
    const body = JSON.stringify({ title: "hi" });
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = "n-1";
    const headers = {
      "x-webhooker-signature": `sha256=${createHmac("sha256", "tenant-secret").update(`${ts}.${nonce}.${body}`).digest("hex")}`,
      "x-webhooker-timestamp": ts,
      "x-webhooker-nonce": nonce,
    };
    expect((await processWebhook(env, body, headers, () => undefined, "team")).status).toBe(503);
    fail = false;
    expect((await processWebhook(env, body, headers, () => undefined, "team")).status).toBe(200);
  });
});
