import { describe, it, expect } from "bun:test";
import { handleTelegramWebhookRequest } from "../server/lib/drivers/telegram/updates";
import { telegramWebhookSecret } from "../server/lib/drivers/telegram/secret";
import { createMemoryKV } from "./d1-sqlite";
import type { Env } from "../server/lib/types";

function env(overrides: Partial<Env> = {}): Env {
  return { GITHUB_WEBHOOK_SECRET: "", KV: createMemoryKV().kv, DB: {} as D1Database, ...overrides };
}

function post(secret?: string): Request {
  return new Request("https://x/telegram/webhook", {
    method: "POST",
    headers: secret ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {},
    body: JSON.stringify({ update_id: 1 }),
  });
}

describe("telegram webhook authentication", () => {
  it("stays closed without a bot token", async () => {
    expect((await handleTelegramWebhookRequest(post("anything"), env())).status).toBe(403);
  });

  it("derives a secret from the bot token when none is configured", async () => {
    const e = env({ TELEGRAM_TOKEN: "123:abc" });
    const secret = await telegramWebhookSecret(e);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect((await handleTelegramWebhookRequest(post(), e)).status).toBe(401);
    expect((await handleTelegramWebhookRequest(post("wrong"), e)).status).toBe(401);
    expect((await handleTelegramWebhookRequest(post(secret), e)).status).toBe(200);
  });

  it("prefers the configured secret", async () => {
    const e = env({ TELEGRAM_TOKEN: "123:abc", TELEGRAM_WEBHOOK_SECRET: "explicit" });
    expect(await telegramWebhookSecret(e)).toBe("explicit");
    expect((await handleTelegramWebhookRequest(post("explicit"), e)).status).toBe(200);
  });
});
