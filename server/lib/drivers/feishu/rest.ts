import { log } from "../../lib/log";
import type { Env } from "../../types";
import type { SendResult } from "../types";

const FEISHU_API = "https://open.feishu.cn";
const TOKEN_KEY = "feishu:token";

interface FeishuResponse {
  code?: number;
  msg?: string;
  data?: { message_id?: string } & Record<string, unknown>;
  error?: { message?: string };
}

/** Feishu business codes for "slow down" (group message rate limit, API frequency limit). */
const RATE_LIMIT_CODES = new Set([230020, 99991400]);
/** Feishu business codes for an invalid or expired tenant access token. */
const TOKEN_CODES = new Set([99991661, 99991663, 99991664, 99991668]);

/**
 * The error code of a failed call: transient business codes map to the codes
 * the delivery queue retries (`RATE_LIMITED`, `FEISHU_TOKEN`), whatever HTTP
 * status Feishu answered with.
 */
function errorCodeOf(status: number, code: number | undefined): string {
  if (code != null && RATE_LIMIT_CODES.has(code)) return "RATE_LIMITED";
  if (code != null && TOKEN_CODES.has(code)) return "FEISHU_TOKEN";
  if (status >= 500) return "FEISHU_5XX";
  return code != null && code !== 0 ? `FEISHU_${code}` : "FEISHU_ERROR";
}

/**
 * Longest a single API call may take. Bounded, so a message edit always ends
 * well within the update-chain lock it runs under (see `deliverUpdate`).
 */
export const REQUEST_TIMEOUT_MS = 15_000;

async function feishuRequest(
  url: string,
  method: string,
  token: string,
  body: Record<string, unknown>,
  label: string,
): Promise<SendResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  let lastStatus = 0;
  let lastError = "";

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      lastStatus = res.status;

      if (res.status === 429) {
        const header = Number(res.headers.get("retry-after") || "1");
        const retryAfter = Number.isFinite(header) && header > 0 ? header : 1;
        lastError = `Rate limited (retry_after=${retryAfter})`;
        log.warn({ retryAfter, attempt, label }, "Feishu rate limited");
        if (retryAfter > 10 || attempt === 2) {
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

      const data = (await res.json().catch(() => null)) as FeishuResponse | null;

      if (!res.ok) {
        lastError = data?.msg ?? data?.error?.message ?? `HTTP ${res.status}`;
        log.error(
          { status: res.status, err: lastError, label, attempts: attempt + 1 },
          "Feishu API error",
        );
        return {
          ok: false,
          error: lastError,
          errorCode: errorCodeOf(res.status, data?.code),
          status: res.status,
          attempts: attempt + 1,
        };
      }

      if (data && typeof data.code === "number" && data.code !== 0) {
        lastError = data.msg ?? `Feishu code ${data.code}`;
        log.error(
          { code: data.code, err: lastError, label, attempts: attempt + 1 },
          "Feishu business error",
        );
        return {
          ok: false,
          error: lastError,
          errorCode: errorCodeOf(res.status, data.code),
          status: res.status,
          attempts: attempt + 1,
        };
      }

      return {
        ok: true,
        status: res.status,
        messageId: data?.data?.message_id ?? undefined,
        attempts: attempt + 1,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.error({ err, label, attempts: attempt + 1 }, "Failed to call Feishu API");
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
    error: lastError || "Max retries exceeded",
    errorCode: "RETRIES",
    status: lastStatus,
    attempts: 3,
  };
}

interface TokenResult {
  ok: boolean;
  token?: string;
  error?: string;
  errorCode?: string;
  status?: number;
}

export async function getTenantAccessToken(env: Env): Promise<TokenResult> {
  const appId = env.FEISHU_APP_ID?.trim();
  const appSecret = env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    return {
      ok: false,
      error: "FEISHU_APP_ID/FEISHU_APP_SECRET not configured",
      errorCode: "NO_TOKEN",
    };
  }

  const cached = await env.KV.get(TOKEN_KEY);
  if (cached) return { ok: true, token: cached };

  const url = `${FEISHU_API}/open-apis/auth/v3/tenant_access_token/internal`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => null)) as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    } | null;
    if (!res.ok || !data || data.code !== 0 || !data.tenant_access_token) {
      const err = data?.msg ?? `HTTP ${res.status}`;
      return { ok: false, error: err, errorCode: "FEISHU_TOKEN", status: res.status };
    }
    const ttl = Math.max(60, (data.expire ?? 7200) - 60);
    await env.KV.put(TOKEN_KEY, data.tenant_access_token, { expirationTtl: ttl });
    return { ok: true, token: data.tenant_access_token };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      errorCode: "NETWORK",
    };
  }
}

export async function sendMessage(
  token: string,
  chatId: string,
  content: Record<string, unknown>,
): Promise<SendResult> {
  const url = `${FEISHU_API}/open-apis/im/v1/messages?receive_id_type=chat_id`;
  const body: Record<string, unknown> = {
    receive_id: chatId,
    msg_type: "interactive",
    content: JSON.stringify(content),
  };
  return feishuRequest(url, "POST", token, body, chatId);
}

export async function updateMessage(
  token: string,
  messageId: string,
  content: Record<string, unknown>,
): Promise<SendResult> {
  const url = `${FEISHU_API}/open-apis/im/v1/messages/${messageId}`;
  const body: Record<string, unknown> = { content: JSON.stringify(content) };
  return feishuRequest(url, "PATCH", token, body, messageId);
}

export async function sendText(token: string, chatId: string, text: string): Promise<SendResult> {
  const url = `${FEISHU_API}/open-apis/im/v1/messages?receive_id_type=chat_id`;
  const body: Record<string, unknown> = {
    receive_id: chatId,
    msg_type: "text",
    content: JSON.stringify({ text }),
  };
  return feishuRequest(url, "POST", token, body, chatId);
}

export async function updateCard(
  token: string,
  cardToken: string,
  card: Record<string, unknown>,
): Promise<SendResult> {
  const url = `${FEISHU_API}/open-apis/interactive/v1/config/update`;
  const body: Record<string, unknown> = { token: cardToken, card };
  return feishuRequest(url, "POST", token, body, "card");
}
