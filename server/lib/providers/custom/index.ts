import type { Env, WebhookEvent } from "../../types";
import type { Provider } from "../types";
import { hmacSha256Hex, timingSafeEqual } from "../hmac";
import { verifySignature } from "../github/verify";
import { claimOnce, idempotencyStore } from "../../lib/idempotency";

const REPLAY_WINDOW_SECONDS = 300;
/** How long an accepted nonce is remembered (longer than the signature window). */
export const NONCE_TTL_SECONDS = 600;
/**
 * How long a nonce stays held while its request is processed. Short, so a
 * request whose attempt failed (and could not give the nonce back) can be
 * retried well within the signature window.
 */
export const NONCE_CLAIM_SECONDS = 120;

/**
 * The request cannot be judged now: its nonce is held by an attempt not
 * confirmed as accepted (still running, or failed without giving the nonce
 * back), or the nonce store is unavailable. Not a proven replay: retry later.
 */
export class ReplayPendingError extends Error {
  constructor(message = "Replay nonce is held by an unconfirmed attempt") {
    super(message);
  }
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Replay protection for `custom` webhooks: the sender adds `X-WebHooker-Timestamp`
 * (Unix seconds) and `X-WebHooker-Nonce` and signs
 * `timestamp + "." + nonce + "." + body` instead of the bare body. We reject
 * timestamps outside a ±5min window and reject any nonce already seen (nonces
 * are kept for 10min). Senders without those headers keep the legacy
 * body-only signature so existing integrations continue to work.
 *
 * Nonces are scoped to the signing secret, so two tenants picking the same
 * nonce never block each other, and claimed atomically (D1 when available),
 * so two concurrent replays cannot both pass.
 */
async function verifyReplayProtected(
  body: string,
  headers: Record<string, string>,
  secret: string,
  env: Env,
): Promise<boolean> {
  const timestamp = parseTimestamp(headers["x-webhooker-timestamp"]);
  const nonce = headers["x-webhooker-nonce"];
  const signature = headers["x-webhooker-signature"];
  if (timestamp == null || !nonce || !secret) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > REPLAY_WINDOW_SECONDS) return false;

  const expected = `sha256=${await hmacSha256Hex(secret, `${timestamp}.${nonce}.${body}`)}`;
  if (!timingSafeEqual(signature ?? "", expected)) return false;

  const key = await replayNonceKey(secret, nonce);
  let state;
  try {
    state = await claimOnce(idempotencyStore(env.DB, env.KV), key, NONCE_CLAIM_SECONDS);
  } catch {
    // A storage failure says nothing about the signature.
    throw new ReplayPendingError("Replay protection is temporarily unavailable");
  }
  // Only a nonce whose request was accepted makes this a replay.
  if (state === "pending") throw new ReplayPendingError();
  return state === "claimed";
}

/** Claim key of a replay-protection nonce, scoped to the signing secret. */
export async function replayNonceKey(secret: string, nonce: string): Promise<string> {
  const scope = (await hmacSha256Hex(secret, "webhooker:nonce-scope")).slice(0, 16);
  return `nonce:${scope}:${nonce}`;
}

/**
 * Custom webhook provider: accepts arbitrary JSON posts (monitoring, CI,
 * scripts, ...) that are not signed by a forge. The sender signs the payload
 * with the tenant's secret using the GitHub-style `sha256=<hex>` HMAC header
 * `X-WebHooker-Signature`, optionally adding replay-protection headers (see
 * `verifyReplayProtected`). Payloads become `custom` events that flow through
 * the normal route matching pipeline (a route with `event: custom`).
 */
export const customProvider: Provider = {
  id: "custom",

  matches(headers) {
    return (
      headers["x-github-event"] === undefined &&
      headers["x-gitea-event"] === undefined &&
      headers["x-webhooker-signature"] !== undefined
    );
  },

  async verify(body, headers, env: Env) {
    // The tenant webhook handler overrides GITHUB_WEBHOOK_SECRET with the
    // group's secret; on the legacy global endpoint this falls back to the
    // operator's global secret.
    const secret = env.GITHUB_WEBHOOK_SECRET;
    if (
      headers["x-webhooker-timestamp"] !== undefined &&
      headers["x-webhooker-nonce"] !== undefined
    ) {
      return verifyReplayProtected(body, headers, secret, env);
    }
    return verifySignature(body, headers["x-webhooker-signature"], secret);
  },

  parse(body, _headers): WebhookEvent | null {
    try {
      const payload = JSON.parse(body) as Record<string, unknown>;
      // An object only: a top-level array (or scalar) could not be parked and
      // restored like every other payload, so it is refused up front.
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
      // Optional id for sender-side dedup (retries from monitoring systems).
      const deliveryId =
        typeof payload.deliveryId === "string" && payload.deliveryId
          ? payload.deliveryId
          : undefined;
      return { event: "custom", provider: "custom", payload, deliveryId };
    } catch {
      return null;
    }
  },
};
