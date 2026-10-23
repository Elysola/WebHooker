import { describe, it, expect, afterEach } from "bun:test";
import { handleInteractionRequest } from "../server/lib/drivers/discord/interactions";
import { saveToken } from "../server/lib/github/store";
import { createMemoryKV, createSqliteD1 } from "./d1-sqlite";
import type { Env } from "../server/lib/types";

const restoredFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = restoredFetch;
});

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function setup(): Promise<{
  env: Env;
  send: (interaction: Record<string, unknown>) => Promise<Response>;
}> {
  const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = hex(await crypto.subtle.exportKey("raw", keys.publicKey));
  const { db, sqlite } = createSqliteD1();
  sqlite.exec("INSERT INTO discord_links (discord_user_id, github_user_id) VALUES ('d1', 'g1')");
  const { kv } = createMemoryKV();
  await saveToken(kv, "g1", "gho_token", 3600);
  const env: Env = { GITHUB_WEBHOOK_SECRET: "", KV: kv, DB: db, DISCORD_PUBLIC_KEY: publicKey };
  async function send(interaction: Record<string, unknown>): Promise<Response> {
    const body = JSON.stringify(interaction);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = hex(
      await crypto.subtle.sign(
        "Ed25519",
        keys.privateKey,
        new TextEncoder().encode(timestamp + body),
      ),
    );
    return handleInteractionRequest(
      new Request("https://x/discord/interactions", {
        method: "POST",
        headers: { "X-Signature-Ed25519": signature, "X-Signature-Timestamp": timestamp },
        body,
      }),
      env,
    );
  }
  return { env, send };
}

describe("discord interactions", () => {
  it("edits the deferred reply through the application webhook and strips the clicked message", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    globalThis.fetch = async (input, init): Promise<Response> => {
      calls.push({ method: init?.method ?? "GET", url: String(input) });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const { send } = await setup();
    const res = await send({
      id: "i1",
      application_id: "app1",
      token: "tok",
      type: 3,
      channel_id: "chan",
      member: { user: { id: "d1" } },
      message: { id: "msg9" },
      data: { custom_id: "ghpr|close|o|r|7" },
    });
    expect(res.status).toBe(202);
    expect(
      calls.some((c) => c.method === "PATCH" && c.url.endsWith("/channels/chan/messages/msg9")),
    ).toBe(true);
    expect(
      calls.some(
        (c) => c.method === "PATCH" && c.url.endsWith("/webhooks/app1/tok/messages/@original"),
      ),
    ).toBe(true);
  });

  it("runs a replayed interaction only once", async () => {
    let callbacks = 0;
    globalThis.fetch = async (input): Promise<Response> => {
      if (String(input).includes("/callback")) callbacks++;
      return new Response("{}", { status: 200 });
    };
    const { send } = await setup();
    const interaction = {
      id: "i2",
      application_id: "app1",
      token: "tok",
      type: 2,
      member: { user: { id: "d1" } },
      data: { name: "gh", type: 1, options: [{ name: "logout" }] },
    };
    await send(interaction);
    await send(interaction);
    expect(callbacks).toBe(1);
  });

  it("refuses to edit a comment longer than the modal can hold", async () => {
    const bodies: string[] = [];
    globalThis.fetch = async (input, init): Promise<Response> => {
      const url = String(input);
      if (url.includes("/issues/comments/")) {
        return new Response(JSON.stringify({ body: "x".repeat(5000), user: { login: "a" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/callback")) bodies.push(String(init?.body));
      return new Response("{}", { status: 200 });
    };
    const { send } = await setup();
    await send({
      id: "i3",
      application_id: "app1",
      token: "tok",
      type: 2,
      member: { user: { id: "d1" } },
      data: {
        name: "gh",
        type: 1,
        options: [
          {
            name: "comment",
            options: [
              {
                name: "edit",
                options: [
                  { name: "link", value: "https://github.com/o/r/issues/1#issuecomment-55" },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(bodies).toHaveLength(1);
    const reply = JSON.parse(bodies[0]!) as { type: number; data: { content?: string } };
    // A message (type 4) pointing to GitHub, not a modal (type 9) holding a cut-off copy.
    expect(reply.type).toBe(4);
    expect(reply.data.content).toContain("github.com/o/r/issues/1#issuecomment-55");
  });

  it("acknowledges a comment modal before calling GitHub, then shows the outcome", async () => {
    const order: string[] = [];
    globalThis.fetch = async (input, init): Promise<Response> => {
      const url = String(input);
      if (url.includes("/callback")) {
        order.push(`callback:${(JSON.parse(String(init?.body)) as { type: number }).type}`);
      } else if (url.includes("api.github.com")) {
        order.push("github");
        return new Response(
          JSON.stringify({ html_url: "https://github.com/o/r/issues/7#c", user: { login: "a" } }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      } else if (url.endsWith("/messages/@original")) {
        order.push("original");
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const { send } = await setup();
    await send({
      id: "i4",
      application_id: "app1",
      token: "tok",
      type: 5,
      member: { user: { id: "d1" } },
      data: {
        custom_id: "ghc|add|o|r|7",
        components: [{ components: [{ custom_id: "body", value: "hello" }] }],
      },
    });
    // Deferred (type 5) first: a slow GitHub call never fails the interaction.
    expect(order[0]).toBe("callback:5");
    expect(order.indexOf("github")).toBeGreaterThan(0);
    expect(order.at(-1)).toBe("original");
  });

  it("leaves GitHub alone when Discord refused the acknowledgement", async () => {
    const calls: string[] = [];
    globalThis.fetch = async (input): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/callback")) return new Response("unknown interaction", { status: 404 });
      return new Response(
        JSON.stringify({ html_url: "https://github.com/o/r/issues/7#c", user: { login: "a" } }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    };
    const { send } = await setup();
    await send({
      id: "i5",
      application_id: "app1",
      token: "tok",
      type: 5,
      member: { user: { id: "d1" } },
      data: {
        custom_id: "ghc|add|o|r|7",
        components: [{ components: [{ custom_id: "body", value: "hello" }] }],
      },
    });
    expect(calls.some((u) => u.includes("api.github.com"))).toBe(false);
  });

  it("refuses to save an edit over changes made on GitHub after the modal opened", async () => {
    let current = "original";
    const patches: string[] = [];
    const callbacks: string[] = [];
    const originals: string[] = [];
    globalThis.fetch = async (input, init): Promise<Response> => {
      const url = String(input);
      if (url.includes("/issues/comments/55")) {
        if ((init?.method ?? "GET") === "PATCH") patches.push(String(init?.body));
        return new Response(
          JSON.stringify({
            body: current,
            html_url: "https://github.com/o/r/issues/1#issuecomment-55",
            user: { login: "a" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/callback")) callbacks.push(String(init?.body));
      if (url.endsWith("/messages/@original")) originals.push(String(init?.body));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const { send } = await setup();
    await send({
      id: "i6",
      application_id: "app1",
      token: "tok",
      type: 2,
      member: { user: { id: "d1" } },
      data: {
        name: "gh",
        type: 1,
        options: [
          {
            name: "comment",
            options: [
              {
                name: "edit",
                options: [
                  { name: "link", value: "https://github.com/o/r/issues/1#issuecomment-55" },
                ],
              },
            ],
          },
        ],
      },
    });
    const modal = JSON.parse(callbacks[0]!) as { type: number; data: { custom_id: string } };
    expect(modal.type).toBe(9);
    expect(modal.data.custom_id.length).toBeLessThanOrEqual(100);
    // Short enough: the context (with the text's hash) travels in the id — no KV write.
    expect(modal.data.custom_id.startsWith("ghc|ed|")).toBe(true);
    current = "changed on GitHub";
    await send({
      id: "i7",
      application_id: "app1",
      token: "tok2",
      type: 5,
      member: { user: { id: "d1" } },
      data: {
        custom_id: modal.data.custom_id,
        components: [{ components: [{ custom_id: "body", value: "original, edited" }] }],
      },
    });
    expect(patches).toHaveLength(0);
    expect(originals.at(-1)).toContain("已被修改");
  });

  it("keeps the custom id short for long repository names", async () => {
    const callbacks: string[] = [];
    globalThis.fetch = async (input, init): Promise<Response> => {
      if (String(input).includes("/callback")) callbacks.push(String(init?.body));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const { send } = await setup();
    const repo = "r".repeat(100);
    await send({
      id: "i8",
      application_id: "app1",
      token: "tok",
      type: 2,
      member: { user: { id: "d1" } },
      data: {
        name: "gh",
        type: 1,
        options: [
          {
            name: "comment",
            options: [
              {
                name: "add",
                options: [{ name: "link", value: `https://github.com/o/${repo}/issues/1` }],
              },
            ],
          },
        ],
      },
    });
    const modal = JSON.parse(callbacks[0]!) as { type: number; data: { custom_id: string } };
    expect(modal.type).toBe(9);
    expect(modal.data.custom_id.length).toBeLessThanOrEqual(100);
    // Too long to carry its context: kept in KV (the only case that writes).
    expect(modal.data.custom_id.startsWith("ghc|m|")).toBe(true);
  });
});
