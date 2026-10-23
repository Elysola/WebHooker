import type { Env } from "../../types";
import { log } from "../../lib/log";
import { handleTelegramUpdate } from "./commands";
import { telegramWebhookSecret } from "./secret";

const MAX_BODY_SIZE = 1024 * 1024;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Handle a POST to the Telegram webhook endpoint. */
export async function handleTelegramWebhookRequest(request: Request, env: Env): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_SIZE) {
    return new Response("Request too large", { status: 413 });
  }

  // Every call must carry the webhook secret. Without a bot token there is
  // no secret to check and nothing to act with, so the endpoint stays closed.
  const secret = await telegramWebhookSecret(env);
  if (!secret) {
    log.warn("Telegram webhook called but TELEGRAM_TOKEN is not configured");
    return new Response("Telegram is not configured", { status: 403 });
  }
  const token = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!token || !timingSafeEqual(token, secret)) {
    return new Response("Invalid secret", { status: 401 });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_SIZE) {
    return new Response("Request too large", { status: 413 });
  }

  let update: unknown;
  try {
    update = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Telegram expects a quick 200; process commands in the background.
  await handleTelegramUpdate(env, update);
  return new Response("ok");
}
