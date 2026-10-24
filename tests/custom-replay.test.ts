import { describe, it, expect } from "bun:test";
import { createHmac } from "crypto";
import { customProvider, ReplayPendingError, replayNonceKey } from "../server/lib/providers/custom";
import { acceptedKey, idempotencyStore } from "../server/lib/lib/idempotency";
import type { Env } from "../server/lib/types";

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => (store.has(key) ? store.get(key)! : null),
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace;
}

function createEnv(secret: string): Env {
  return {
    GITHUB_WEBHOOK_SECRET: secret,
    KV: createMockKV(),
    DB: {} as D1Database,
  };
}

function replaySignature(secret: string, timestamp: number, nonce: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${nonce}.${body}`).digest("hex")}`;
}

const now = Math.floor(Date.now() / 1000);

describe("custom provider replay protection", () => {
  it("verifies a valid timestamp + nonce + signature", async () => {
    const secret = "s3cret";
    const env = createEnv(secret);
    const body = JSON.stringify({ hello: "world" });
    const nonce = "nonce-1";
    const ok = await customProvider.verify(
      body,
      {
        "x-webhooker-signature": replaySignature(secret, now, nonce, body),
        "x-webhooker-timestamp": String(now),
        "x-webhooker-nonce": nonce,
      },
      env,
    );
    expect(ok).toBe(true);
  });

  it("rejects a replayed nonce even with a valid signature", async () => {
    const secret = "s3cret";
    const env = createEnv(secret);
    const body = JSON.stringify({ hello: "world" });
    const nonce = "nonce-reused";
    const headers = {
      "x-webhooker-signature": replaySignature(secret, now, nonce, body),
      "x-webhooker-timestamp": String(now),
      "x-webhooker-nonce": nonce,
    };
    expect(await customProvider.verify(body, headers, env)).toBe(true);
    // While the first request is not confirmed as accepted, the nonce is
    // neither free nor a proven replay.
    expect(customProvider.verify(body, headers, env)).rejects.toBeInstanceOf(ReplayPendingError);
    const key = await replayNonceKey(secret, nonce);
    await idempotencyStore(env.DB, env.KV).claim(acceptedKey(key), 600);
    expect(await customProvider.verify(body, headers, env)).toBe(false);
  });

  it("scopes nonces to the signing secret", async () => {
    const kv = createMockKV();
    const body = JSON.stringify({ hello: "world" });
    const nonce = "shared-nonce";
    for (const secret of ["tenant-a", "tenant-b"]) {
      const env = { ...createEnv(secret), KV: kv };
      const headers = {
        "x-webhooker-signature": replaySignature(secret, now, nonce, body),
        "x-webhooker-timestamp": String(now),
        "x-webhooker-nonce": nonce,
      };
      expect(await customProvider.verify(body, headers, env)).toBe(true);
    }
  });

  it("rejects a timestamp outside the window", async () => {
    const secret = "s3cret";
    const env = createEnv(secret);
    const body = JSON.stringify({ hello: "world" });
    const stale = now - 3600;
    const nonce = "nonce-stale";
    const ok = await customProvider.verify(
      body,
      {
        "x-webhooker-signature": replaySignature(secret, stale, nonce, body),
        "x-webhooker-timestamp": String(stale),
        "x-webhooker-nonce": nonce,
      },
      env,
    );
    expect(ok).toBe(false);
  });

  it("rejects a signature computed over the wrong input", async () => {
    const secret = "s3cret";
    const env = createEnv(secret);
    const body = JSON.stringify({ hello: "world" });
    const nonce = "nonce-bad-sig";
    const wrong = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const ok = await customProvider.verify(
      body,
      {
        "x-webhooker-signature": wrong,
        "x-webhooker-timestamp": String(now),
        "x-webhooker-nonce": nonce,
      },
      env,
    );
    expect(ok).toBe(false);
  });

  it("still verifies the legacy body-only signature", async () => {
    const secret = "s3cret";
    const env = createEnv(secret);
    const body = JSON.stringify({ hello: "world" });
    const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const ok = await customProvider.verify(body, { "x-webhooker-signature": sig }, env);
    expect(ok).toBe(true);
  });

  it("treats a missing nonce as a legacy (body-only) signature", async () => {
    const secret = "s3cret";
    const env = createEnv(secret);
    const body = JSON.stringify({ hello: "world" });
    // Only a timestamp, no nonce → falls back to body-only verification.
    const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const ok = await customProvider.verify(
      body,
      { "x-webhooker-signature": sig, "x-webhooker-timestamp": String(now) },
      env,
    );
    // Timestamp is present but nonce missing, so replay path is skipped and the
    // body-only signature is used → verified.
    expect(ok).toBe(true);
  });
});
