import { describe, it, expect } from "bun:test";
import type { Env } from "../server/lib/types";
import {
  decryptFeishuPayload,
  verifyFeishuSignature,
  handleFeishuWebhookRequest,
} from "../server/lib/drivers/feishu/updates";
import { createMemoryKV } from "./d1-sqlite";

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Feishu's event signature: hex SHA-256 of timestamp + nonce + encryptKey + body. */
function sign(encryptKey: string, timestamp: string, nonce: string, body: string): Promise<string> {
  return sha256Hex(`${timestamp}${nonce}${encryptKey}${body}`);
}

/** Encrypt like Feishu: AES-256-CBC, key SHA-256(encryptKey), IV prepended. */
async function encrypt(encryptKey: string, plaintext: string): Promise<string> {
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encryptKey));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, [
    "encrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const all = new Uint8Array(16 + ct.length);
  all.set(iv);
  all.set(ct, 16);
  let bin = "";
  for (const b of all) bin += String.fromCharCode(b);
  return btoa(bin);
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_WEBHOOK_SECRET: "",
    FEISHU_APP_ID: "",
    FEISHU_APP_SECRET: "",
    KV: createMemoryKV().kv,
    DB: {} as D1Database,
    ...overrides,
  };
}

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://x/feishu/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("feishu signature", () => {
  it("verifies a correct signature", async () => {
    const body = JSON.stringify({ hello: "world" });
    const sig = await sign("key", "1700000000", "abc", body);
    expect(await verifyFeishuSignature("key", "1700000000", "abc", body, sig)).toBe(true);
  });

  it("rejects a wrong or missing signature", async () => {
    const body = JSON.stringify({ hello: "world" });
    const sig = await sign("other", "1", "2", body);
    expect(await verifyFeishuSignature("key", "1", "2", body, sig)).toBe(false);
    expect(await verifyFeishuSignature("key", "1", "2", body, "")).toBe(false);
  });

  it("decrypts an encrypted payload", async () => {
    const encrypted = await encrypt("key", JSON.stringify({ a: 1 }));
    expect(JSON.parse(await decryptFeishuPayload("key", encrypted))).toEqual({ a: 1 });
  });
});

describe("feishu webhook", () => {
  it("refuses every request when no verification is configured", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "xyz" });
    const res = await handleFeishuWebhookRequest(post(body), env());
    expect(res.status).toBe(403);
  });

  it("answers the url_verification challenge with a matching token", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "xyz123", token: "vt" });
    const res = await handleFeishuWebhookRequest(
      post(body),
      env({ FEISHU_VERIFICATION_TOKEN: "vt" }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { challenge: string }).challenge).toBe("xyz123");
  });

  it("rejects a wrong verification token", async () => {
    const body = JSON.stringify({
      schema: "2.0",
      header: { event_type: "im.message.receive_v1", token: "nope" },
      event: {},
    });
    const res = await handleFeishuWebhookRequest(
      post(body),
      env({ FEISHU_VERIFICATION_TOKEN: "vt" }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a missing or bad signature when an encrypt key is set", async () => {
    const body = JSON.stringify({ schema: "2.0", header: { event_type: "x" }, event: {} });
    const e = env({ FEISHU_ENCRYPT_KEY: "key" });
    expect((await handleFeishuWebhookRequest(post(body), e)).status).toBe(401);
    expect(
      (await handleFeishuWebhookRequest(post(body, { "x-lark-signature": "deadbeef" }), e)).status,
    ).toBe(401);
  });

  it("accepts a correctly signed, encrypted event once", async () => {
    const inner = JSON.stringify({
      schema: "2.0",
      header: { event_id: "ev-1", event_type: "unknown.event" },
      event: {},
    });
    const body = JSON.stringify({ encrypt: await encrypt("key", inner) });
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = "n1";
    const headers = {
      "x-lark-request-timestamp": ts,
      "x-lark-request-nonce": nonce,
      "x-lark-signature": await sign("key", ts, nonce, body),
    };
    const e = env({ FEISHU_ENCRYPT_KEY: "key" });
    expect((await handleFeishuWebhookRequest(post(body, headers), e)).status).toBe(200);
    // The retried delivery of the same event is acknowledged without running again.
    expect((await handleFeishuWebhookRequest(post(body, headers), e)).status).toBe(200);
  });

  it("refuses a correctly signed request whose timestamp is stale", async () => {
    const inner = JSON.stringify({
      schema: "2.0",
      header: { event_id: "ev-old", event_type: "unknown.event" },
      event: {},
    });
    const body = JSON.stringify({ encrypt: await encrypt("key", inner) });
    // Older than any event claim could still remember.
    const ts = String(Math.floor(Date.now() / 1000) - 13 * 3600);
    const headers = {
      "x-lark-request-timestamp": ts,
      "x-lark-request-nonce": "n2",
      "x-lark-signature": await sign("key", ts, "n2", body),
    };
    const e = env({ FEISHU_ENCRYPT_KEY: "key" });
    expect((await handleFeishuWebhookRequest(post(body, headers), e)).status).toBe(401);
  });

  it("refuses an oversized body before parsing it", async () => {
    const body = JSON.stringify({ pad: "x".repeat(1024 * 1024) });
    const e = env({ FEISHU_VERIFICATION_TOKEN: "vt" });
    expect((await handleFeishuWebhookRequest(post(body), e)).status).toBe(413);
  });
});

describe("feishu command parsing", () => {
  it("never runs a command merely quoted inside a message", async () => {
    const e = env({ FEISHU_VERIFICATION_TOKEN: "vt" });
    // Any account lookup would fail loudly: a parsed command would answer 503.
    e.DB = {
      prepare: (): never => {
        throw new Error("command ran");
      },
    } as unknown as D1Database;
    const body = JSON.stringify({
      schema: "2.0",
      header: { event_id: "ev-q", event_type: "im.message.receive_v1", token: "vt" },
      event: {
        sender: { sender_id: { open_id: "ou_1" } },
        message: {
          chat_id: "oc_1",
          content: JSON.stringify({
            text: "please do not run /gh merge https://github.com/o/r/pull/7",
          }),
        },
      },
    });
    expect((await handleFeishuWebhookRequest(post(body), e)).status).toBe(200);
  });
});

describe("feishu command retries", () => {
  it("answers 503 and releases the event when it failed before reaching GitHub", async () => {
    const e = env({ FEISHU_VERIFICATION_TOKEN: "vt" });
    // A D1 binding whose link lookup fails: the command never reaches GitHub.
    e.DB = {
      prepare: (): unknown => ({
        bind: (): unknown => ({
          all: async (): Promise<never> => {
            throw new Error("D1 down");
          },
        }),
      }),
    } as unknown as D1Database;
    const body = JSON.stringify({
      schema: "2.0",
      header: { event_id: "ev-9", event_type: "im.message.receive_v1", token: "vt" },
      event: {
        sender: { sender_id: { open_id: "ou_1" } },
        message: {
          chat_id: "oc_1",
          content: JSON.stringify({ text: "/gh merge https://github.com/o/r/pull/1" }),
        },
      },
    });
    expect((await handleFeishuWebhookRequest(post(body), e)).status).toBe(503);
    // The retry is not swallowed as a duplicate.
    expect((await handleFeishuWebhookRequest(post(body), e)).status).toBe(503);
  });
});
