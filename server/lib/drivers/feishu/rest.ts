import { log } from "../../lib/log";
import { sharedFlight, type Flight } from "../../lib/shared-flight";
import type { Env } from "../../types";
import type { SendResult } from "../types";

const FEISHU_API = "https://open.feishu.cn";
/**
 * The cached tenant token of the configured app: switching apps (another
 * FEISHU_APP_ID) never sends with the previous app's token.
 */
export function tokenKey(env: Env): string {
  return `feishu:token:${env.FEISHU_APP_ID?.trim() ?? ""}`;
}

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
      // A 200 whose body cannot be read (or carries no result code) is not
      // known to have succeeded: tried again (the request's uuid keeps a
      // send from doubling).
      if (res.ok && (!data || typeof data.code !== "number")) {
        throw new Error("Feishu answered without a result code");
      }

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

/** How long this isolate uses a token before reading KV again. */
const HELD_TOKEN_MS = 5 * 60_000;
/**
 * A failed token request is answered from memory this long: targets sent one
 * after another in the same delivery then fail at once instead of each
 * reading KV and asking Feishu again (the delivery is retried later anyway).
 */
const FAILED_TOKEN_MS = 5_000;

interface TokenResult {
  ok: boolean;
  token?: string;
  error?: string;
  errorCode?: string;
  status?: number;
}

/**
 * Tokens this isolate holds (per cache key), and refreshes in flight: routes
 * sending in parallel share one token request and one KV write instead of
 * each fetching and storing its own.
 */
const heldTokens = new Map<string, { token: string; until: number }>();
const refreshing = new Map<string, Flight<TokenResult>>();
const failedTokens = new Map<string, { result: TokenResult; until: number }>();
/** Tokens Feishu refused (bounded): never taken from KV again. */
const rejected = new Set<string>();
/** Refused tokens whose KV copy this isolate removed (or is removing). */
const cleared = new Set<string>();

/**
 * A rejected token is dropped from the cache, so the retry fetches a new one.
 * From memory every time; from KV once per isolate (every target refused
 * with it would otherwise delete the same key again) — tried again by the
 * next refusal when that delete fails — and never a newer token another
 * request stored meanwhile.
 */
export async function forgetRejectedToken(
  result: SendResult,
  env: Env,
  token: string,
): Promise<SendResult> {
  if (result.errorCode !== "FEISHU_TOKEN") return result;
  const key = tokenKey(env);
  if (heldTokens.get(key)?.token === token) heldTokens.delete(key);
  if (!rejected.has(token)) {
    if (rejected.size >= 100) {
      rejected.clear();
      cleared.clear();
    }
    rejected.add(token);
  }
  if (!cleared.has(token)) {
    cleared.add(token);
    try {
      if ((await env.KV.get(key)) === token) await env.KV.delete(key);
    } catch {
      cleared.delete(token);
    }
  }
  return result;
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

  const key = tokenKey(env);
  const held = heldTokens.get(key);
  if (held && Date.now() < held.until) return { ok: true, token: held.token };
  const failed = failedTokens.get(key);
  if (failed && Date.now() < failed.until) return failed.result;
  return sharedFlight(
    refreshing,
    key,
    async () => {
      const result = await fetchTenantAccessToken(env, appId, appSecret);
      if (result.ok) failedTokens.delete(key);
      else failedTokens.set(key, { result, until: Date.now() + FAILED_TOKEN_MS });
      return result;
    },
    REQUEST_TIMEOUT_MS + 5_000,
  );
}

async function fetchTenantAccessToken(
  env: Env,
  appId: string,
  appSecret: string,
): Promise<TokenResult> {
  const key = tokenKey(env);
  const cached = await env.KV.get(key);
  // A copy Feishu already refused (its KV delete failed or has not spread
  // yet) is not used again: a new token is requested instead.
  if (cached && !rejected.has(cached)) {
    // Held a few minutes here: KV is read again now and then, so a token
    // another isolate replaced is picked up.
    heldTokens.set(key, { token: cached, until: Date.now() + HELD_TOKEN_MS });
    return { ok: true, token: cached };
  }

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
    // Kept in KV until a held copy (read from KV just before it expires
    // there, then held HELD_TOKEN_MS) still ends ahead of the token itself.
    const ttl = Math.max(60, (data.expire ?? 7200) - 60 - HELD_TOKEN_MS / 1000);
    heldTokens.set(key, {
      token: data.tenant_access_token,
      until: Date.now() + Math.min(HELD_TOKEN_MS, ttl * 1000),
    });
    // Shared with other isolates when it can be: a failed KV write (say, the
    // daily write quota spent) never throws away a valid token — it is then
    // held here until it nears expiry, instead of being fetched (and its
    // write retried) again every few minutes.
    const token = data.tenant_access_token;
    // Feishu handing out a token refused before means it is valid after all.
    rejected.delete(token);
    cleared.delete(token);
    await env.KV.put(key, token, { expirationTtl: ttl }).catch(() => {
      heldTokens.set(key, { token, until: Date.now() + ttl * 1000 });
    });
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
  sendKey?: string,
): Promise<SendResult> {
  const url = `${FEISHU_API}/open-apis/im/v1/messages?receive_id_type=chat_id`;
  // One `uuid` for every attempt of this send (of the delivery, given a
  // `sendKey`): Feishu delivers at most one message per uuid within an hour,
  // so a retry after a lost response never posts a duplicate.
  const body: Record<string, unknown> = {
    receive_id: chatId,
    msg_type: "interactive",
    content: JSON.stringify(content),
    uuid: (sendKey ?? crypto.randomUUID()).slice(0, 50),
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
    uuid: crypto.randomUUID(),
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
