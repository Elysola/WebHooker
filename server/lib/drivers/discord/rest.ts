import { log } from "../../lib/log";
import type { SendResult } from "../types";

const DISCORD_API = "https://discord.com/api/v10";

interface DiscordMessage {
  id?: string;
}

/**
 * Longest a single API call may take. Bounded, so a message edit always ends
 * well within the update-chain lock it runs under (see `deliverUpdate`).
 */
export const REQUEST_TIMEOUT_MS = 15_000;

async function request(
  url: string,
  method: string,
  token: string,
  message: unknown,
  channelId: string,
): Promise<SendResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.status === 429) {
        const rateLimit = (await res.json()) as { retry_after?: number };
        const retryAfter = (rateLimit.retry_after ?? 1) * 1000;
        log.warn({ retryAfter, attempt }, "Rate limited");
        await new Promise((r) => setTimeout(r, retryAfter));
        continue;
      }

      if (!res.ok) {
        const err = await res.text();
        if (res.status >= 500) {
          log.error({ status: res.status, err, attempt, channelId }, "Discord API 5xx");
          if (attempt === 2)
            return {
              ok: false,
              error: err,
              errorCode: "DISCORD_5XX",
              status: res.status,
              attempts: attempt + 1,
            };
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        log.error({ status: res.status, err, channelId }, "Discord API error");
        return {
          ok: false,
          error: err,
          errorCode: "DISCORD_ERROR",
          status: res.status,
          attempts: attempt + 1,
        };
      }

      let messageId: string | undefined;
      try {
        const data = (await res.json()) as DiscordMessage;
        messageId = data.id;
      } catch {
        // ignore malformed success body
      }

      return { ok: true, status: res.status, messageId, attempts: attempt + 1 };
    } catch (err) {
      log.error({ err, attempt, channelId }, "Failed to send message");
      if (attempt === 2)
        return { ok: false, error: String(err), errorCode: "NETWORK", attempts: attempt + 1 };
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }

  return { ok: false, error: "Max retries exceeded", errorCode: "RETRIES", attempts: 3 };
}

export async function sendMessage(
  token: string,
  channelId: string,
  message: unknown,
  threadId?: string,
): Promise<SendResult> {
  const url = threadId
    ? `${DISCORD_API}/channels/${threadId}/messages`
    : `${DISCORD_API}/channels/${channelId}/messages`;
  return request(url, "POST", token, message, channelId);
}

export async function editMessage(
  token: string,
  channelId: string,
  messageId: string,
  message: unknown,
  threadId?: string,
): Promise<SendResult> {
  const base = threadId ?? channelId;
  const url = `${DISCORD_API}/channels/${base}/messages/${messageId}`;
  return request(url, "PATCH", token, message, channelId);
}
