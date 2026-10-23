import type { Env } from "../../types";

/**
 * The `secret_token` Telegram must send with every webhook call. It is
 * `TELEGRAM_WEBHOOK_SECRET` when set, otherwise derived from the bot token
 * (which is itself secret), so the webhook endpoint is never left
 * unauthenticated. Empty when no bot token is configured.
 */
export async function telegramWebhookSecret(env: Env): Promise<string> {
  const explicit = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (explicit) return explicit;
  const token = env.TELEGRAM_TOKEN?.trim();
  if (!token) return "";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`webhooker:telegram-webhook:${token}`),
  );
  // Telegram allows 1-256 characters of A-Z, a-z, 0-9, `_` and `-`.
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
