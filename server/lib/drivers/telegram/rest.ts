import { log } from "../../lib/log";
import type { SendResult } from "../types";

const TELEGRAM_API = "https://api.telegram.org";

interface TelegramResponse {
  ok?: boolean;
  description?: string;
  result?: { message_id?: number };
  parameters?: { retry_after?: number };
}

/**
 * Longest rate-limit wait (seconds) slept inside one request; a longer one is
 * returned as a 429 failure so the delivery queue retries it later instead.
 */
const MAX_INLINE_RETRY_AFTER = 10;

/**
 * Longest a single API call may take. Bounded, so a message edit always ends
 * well within the update-chain lock it runs under (see `deliverUpdate`).
 */
export const REQUEST_TIMEOUT_MS = 15_000;

async function post(
  token: string,
  method: string,
  body: Record<string, unknown>,
  chatId: string,
): Promise<SendResult> {
  const url = `${TELEGRAM_API}/bot${token}/${method}`;
  let lastStatus = 0;
  let lastError = "";

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      lastStatus = res.status;
      const data = (await res.json().catch(() => null)) as TelegramResponse | null;

      if (res.status === 429) {
        // Telegram reports the wait in `parameters.retry_after` (seconds).
        const raw = Number(data?.parameters?.retry_after);
        const retryAfter = Number.isFinite(raw) && raw > 0 ? raw : 1;
        lastError = data?.description ?? `Rate limited (retry_after=${retryAfter})`;
        if (retryAfter > MAX_INLINE_RETRY_AFTER || attempt === 2) {
          return {
            ok: false,
            error: lastError,
            errorCode: "RATE_LIMITED",
            status: 429,
            attempts: attempt + 1,
          };
        }
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }

      if (!res.ok) {
        lastError = data?.description ?? `HTTP ${res.status}`;
        log.error(
          { status: res.status, err: lastError, chatId, attempts: attempt + 1 },
          "Telegram API error",
        );
        return {
          ok: false,
          error: lastError,
          errorCode: res.status >= 500 ? "TELEGRAM_5XX" : "TELEGRAM_ERROR",
          status: res.status,
          attempts: attempt + 1,
        };
      }

      return {
        ok: true,
        status: res.status,
        messageId: data?.result?.message_id != null ? String(data.result.message_id) : undefined,
        attempts: attempt + 1,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.error({ err, chatId, attempts: attempt + 1 }, "Failed to send Telegram message");
      if (attempt === 2) {
        return {
          ok: false,
          error: lastError,
          errorCode: "NETWORK",
          status: lastStatus,
          attempts: attempt + 1,
        };
      }
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }

  return {
    ok: false,
    error: lastError || "Failed to send Telegram message",
    errorCode: "RETRIES",
    status: lastStatus,
    attempts: 3,
  };
}

export async function sendMessage(
  token: string,
  chatId: string,
  text: string,
  topicId?: string,
  linkPreviewUrl?: string,
): Promise<SendResult> {
  if (!token) {
    return { ok: false, error: "TELEGRAM_TOKEN not configured", errorCode: "NO_TOKEN" };
  }
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: !linkPreviewUrl,
  };
  if (linkPreviewUrl) {
    body.link_preview_options = {
      url: linkPreviewUrl,
      prefer_small_media: true,
      show_above_text: true,
    };
  }
  if (topicId) {
    body.message_thread_id = Number(topicId);
  }
  return post(token, "sendMessage", body, chatId);
}

export async function sendPhoto(
  token: string,
  chatId: string,
  photoUrl: string,
  caption?: string,
  topicId?: string,
): Promise<SendResult> {
  if (!token) {
    return { ok: false, error: "TELEGRAM_TOKEN not configured", errorCode: "NO_TOKEN" };
  }
  const body: Record<string, unknown> = {
    chat_id: chatId,
    photo: photoUrl,
    parse_mode: "HTML",
  };
  if (caption) {
    body.caption = caption;
  }
  if (topicId) {
    body.message_thread_id = Number(topicId);
  }
  return post(token, "sendPhoto", body, chatId);
}

export async function editMessageText(
  token: string,
  chatId: string,
  messageId: string,
  text: string,
  topicId?: string,
  linkPreviewUrl?: string,
): Promise<SendResult> {
  if (!token) {
    return { ok: false, error: "TELEGRAM_TOKEN not configured", errorCode: "NO_TOKEN" };
  }
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: !linkPreviewUrl,
  };
  if (linkPreviewUrl) {
    body.link_preview_options = {
      url: linkPreviewUrl,
      prefer_small_media: true,
      show_above_text: true,
    };
  }
  if (topicId) {
    body.message_thread_id = Number(topicId);
  }
  return post(token, "editMessageText", body, chatId);
}

export async function editMessageCaption(
  token: string,
  chatId: string,
  messageId: string,
  caption: string,
  topicId?: string,
): Promise<SendResult> {
  if (!token) {
    return { ok: false, error: "TELEGRAM_TOKEN not configured", errorCode: "NO_TOKEN" };
  }
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    caption,
    parse_mode: "HTML",
  };
  if (topicId) {
    body.message_thread_id = Number(topicId);
  }
  return post(token, "editMessageCaption", body, chatId);
}
