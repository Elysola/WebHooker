import type { H3Event } from "h3";
import type { Env } from "./types";

/**
 * Cloudflare bindings (KV, D1, secrets) from the request context. Works on
 * Cloudflare Workers (fetch and scheduled) and in tests that stub
 * `event.context.cloudflare`. Throws with a clear message in other runtimes.
 */
export function cfEnv(event: H3Event): Env {
  const env = (event.context.cloudflare as { env?: Env } | undefined)?.env;
  if (!env) {
    throw new Error("Cloudflare bindings unavailable — run via wrangler dev/deploy");
  }
  return env;
}

/**
 * The raw web `Request` for this event. On the Cloudflare module preset it
 * lives in `event.context.cloudflare.request`; on other web runtimes h3
 * exposes it as `event.web.request`.
 *
 * NOTE: nitro pre-reads the request body into its internal buffers, so the
 * returned Request's body stream is already consumed — use `readRawBody()`
 * (or `readBody()`) to get the payload instead of `request.text()`.
 */
export function rawRequest(event: H3Event): Request {
  const cf = (event.context.cloudflare as { request?: Request } | undefined)?.request;
  const web = event.web?.request;
  const req = cf ?? web;
  if (!req) {
    throw new Error("Raw request unavailable — run via wrangler dev/deploy");
  }
  return req;
}

/** `waitUntil` from the CF execution context (no-op outside workers). */
export function cfWaitUntil(event: H3Event): (promise: Promise<unknown>) => void {
  const cloudflare = event.context.cloudflare as
    | {
        ctx?: { waitUntil?: (p: Promise<unknown>) => void };
        context?: { waitUntil?: (p: Promise<unknown>) => void };
      }
    | undefined;
  const waitUntil =
    (event.context.waitUntil as ((p: Promise<unknown>) => void) | undefined) ??
    cloudflare?.context?.waitUntil ??
    cloudflare?.ctx?.waitUntil;
  return waitUntil ? waitUntil.bind(event.context) : () => undefined;
}

/** Lowercased request headers (the provider detection reads lowercase keys). */
export function headersFrom(event: H3Event): Record<string, string> {
  const out: Record<string, string> = {};
  event.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** Largest body the bot callback routes read (each handler checks it again). */
export const MAX_CALLBACK_BODY = 1024 * 1024;

/**
 * A body declared larger than `max` bytes: answered 413 before the route
 * reads (and copies) it. Bodies without a declared length are still checked
 * by the handler once read.
 */
export function declaresBodyOver(event: H3Event, max = MAX_CALLBACK_BODY): boolean {
  const length = Number(event.headers.get("content-length"));
  return Number.isFinite(length) && length > max;
}
