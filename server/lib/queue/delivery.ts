import type { Env } from "../types";
import { r2PayloadStore } from "../storage/payload";
import { canUseD1, isMissingTable, kvFallbackActive, noteKvFallback } from "../storage/d1";
import { idempotencyStore, kvIdempotencyStore, tenantScope } from "../lib/idempotency";
import { log } from "../lib/log";

export type DeliveryStatus =
  "pending" | "processing" | "delivered" | "retrying" | "failed" | "dead";

export interface DeliveryMessage {
  deliveryId: string;
  /** Tenant group of a per-group ingress (`/webhook/{groupId}`); absent for the global endpoint. */
  groupId?: string;
  /**
   * The tenant group's immutable instance at ingress. The consumer delivers
   * only to the group holding it now (following renames), never to another
   * group that later took over the id.
   */
  groupInstance?: string;
  provider: string;
  event: string;
  payload?: Record<string, unknown>;
  /** R2 object key (new) or KV key (legacy `queue:payload:*`). */
  payloadRef?: string;
  /** Distinguishes R2 payload refs from legacy KV keys. */
  payloadRefType?: "r2" | "kv";
  installationId?: number;
  receivedAt: number;
  requestId?: string;
  /**
   * 2 for messages whose state keys use the current scopes (`@global`,
   * instances). Absent on messages queued before: only those may have state
   * under the old `...:global:` key.
   */
  stateVersion?: number;
}

export interface DispatchFailure {
  /** Stable identity of the route × target, used to skip it on a retry. */
  key?: string;
  target: string;
  error?: string;
  errorCode?: string;
  status?: number;
}

export interface DispatchSummary {
  attempts: number;
  failures: DispatchFailure[];
  /** Keys of the route × targets that were sent successfully. */
  succeeded?: string[];
}

export const DELIVERY_QUEUE = "webhooker-delivery";
export const DELIVERY_DLQ = "webhooker-delivery-dlq";

/**
 * Queue messages may be 128 KB (128 000 bytes, a little of it taken by the
 * queue's own metadata); measured in UTF-8 bytes of the JSON. Close to the
 * limit, so only payloads that cannot go in the message are parked — each
 * parked one costs a KV write, read and delete (scarce on Workers Free).
 */
const MAX_QUEUE_MESSAGE_BYTES = 120_000;
/**
 * Parked payloads must outlive every retry and the DLQ hand-off. Queue
 * messages are retained up to four days, so the payload is too.
 */
export const PAYLOAD_TTL_SECONDS = 4 * 86400;
/**
 * What a delivery finished (state, done targets, permanent failures) is kept
 * as long as delivery state (pruned after 7 days): a redelivery within that
 * window — queued or inline — never sends a finished target again.
 */
const LEDGER_TTL_SECONDS = 7 * 86400;
const STATE_KV_TTL_SECONDS = LEDGER_TTL_SECONDS;
/** How long a just-parked KV payload may still be invisible (eventual consistency). */
const KV_VISIBILITY_GRACE_MS = 10 * 60_000;
/** A consumer holds a delivery this long before another one may take over. */
const LEASE_MS = 5 * 60_000;

const RETRYABLE_ERROR_CODES = new Set([
  "DISCORD_5XX",
  "TELEGRAM_5XX",
  "FEISHU_5XX",
  "FEISHU_TOKEN",
  "NETWORK",
  "RETRIES",
  "RATE_LIMITED",
]);

const RETRY_DELAYS_SECONDS = [5, 30, 120, 600];

/** The stored payload of a delivery is gone or unreadable: it cannot be dispatched. */
export class PayloadUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadUnavailableError";
  }
}

export function isRetryableError(code?: string): boolean {
  return code == null || RETRYABLE_ERROR_CODES.has(code);
}

/** Transient by code, or by HTTP status (5xx, 429) whatever the platform's code. */
export function isRetryableFailure(failure: DispatchFailure): boolean {
  if (failure.status != null && (failure.status >= 500 || failure.status === 429)) return true;
  return isRetryableError(failure.errorCode);
}

/**
 * A delivery is retried when any target failed transiently. Targets that
 * succeeded or failed permanently are recorded first (see `markTargetsDone`)
 * so the retry only re-sends the transient ones: one bad target never cancels
 * the retries of the others.
 */
export function classifyDelivery(summary: DispatchSummary): {
  failed: boolean;
  retryable: boolean;
} {
  if (summary.failures.length === 0) return { failed: false, retryable: false };
  return { failed: true, retryable: summary.failures.some(isRetryableFailure) };
}

export function retryDelay(attempt: number): number {
  if (attempt < 1) return RETRY_DELAYS_SECONDS[0] ?? 5;
  const idx = Math.min(attempt - 1, RETRY_DELAYS_SECONDS.length - 1);
  return RETRY_DELAYS_SECONDS[idx] ?? 600;
}

function scopeKey(
  provider: string,
  groupId: string | undefined,
  deliveryId: string,
  instance?: string,
): string {
  return `${provider}:${tenantScope(groupId, instance)}:${deliveryId}`;
}

/** State key of a delivery; tenant deliveries are keyed by their group instance. */
export function deliveryStateKey(
  provider: string,
  groupId: string | undefined,
  deliveryId: string,
  instance?: string,
): string {
  return `delivery-state:${scopeKey(provider, groupId, deliveryId, instance)}`;
}

/**
 * KV key of a parked payload. Unique per enqueue: a redelivery of the same
 * delivery parks its own copy, so cleaning up after its failed send can never
 * remove the payload an earlier queue message still needs.
 */
function payloadKey(provider: string, groupId: string | undefined, deliveryId: string): string {
  return `queue:payload:${scopeKey(provider, groupId, deliveryId)}:${crypto.randomUUID()}`;
}

export async function setDeliveryState(
  env: Env,
  key: string,
  status: DeliveryStatus,
): Promise<void> {
  const db = env.DB;
  if (canUseD1(db)) {
    try {
      await db
        .prepare(
          `INSERT INTO delivery_state (key, status, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
        )
        .bind(key, status, Date.now())
        .run();
      return;
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      log.warn({ err, key }, "D1 delivery_state table missing, falling back to KV");
    }
  }
  // Marked, so D1 (missing table now, or added to the deployment later)
  // still honors this state.
  await noteKvFallback(env.KV);
  await env.KV.put(key, JSON.stringify({ status, at: Date.now() }), {
    expirationTtl: STATE_KV_TTL_SECONDS,
  });
}

export async function getDeliveryState(env: Env, key: string): Promise<DeliveryStatus | null> {
  const db = env.DB;
  if (canUseD1(db)) {
    try {
      const row = await db
        .prepare("SELECT status FROM delivery_state WHERE key = ?")
        .bind(key)
        .first<{ status: DeliveryStatus }>();
      if (row?.status || !(await kvFallbackActive(env.KV))) return row?.status ?? null;
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      log.warn({ err, key }, "D1 delivery_state table missing, falling back to KV");
      await noteKvFallback(env.KV);
    }
  }
  const raw = await env.KV.get(key);
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { status?: DeliveryStatus }).status ?? null;
  } catch {
    return null;
  }
}

export type LeaseResult = "acquired" | "finished" | "busy";

/**
 * A delivery lease: its status and, when acquired, the fencing token (the
 * `updated_at` the holder wrote). Renewals and terminal writes only apply
 * while the row still carries the holder's token, so a consumer whose lease
 * was taken over can neither overwrite the new holder's state nor go on as if
 * it still owned the delivery. Null token: KV fallback (no fencing).
 */
export interface Lease {
  status: LeaseResult;
  token: number | null;
}

const FINISHED: ReadonlySet<DeliveryStatus | null> = new Set(["delivered", "dead", "failed"]);

/**
 * Take a delivery for processing. With D1 this is one conditional UPSERT: it
 * succeeds only for a new delivery, one waiting for a retry, or one whose
 * previous holder's lease expired — so two consumers can never dispatch the
 * same delivery at the same time. `finished` deliveries are done for good;
 * `busy` ones are being processed elsewhere right now.
 */
export async function acquireDelivery(env: Env, key: string): Promise<Lease> {
  const db = env.DB;
  if (canUseD1(db)) {
    try {
      // Finished while the table was missing (state lives in KV then).
      if (await kvFallbackActive(env.KV)) {
        const kvState = await env.KV.get(key);
        if (
          kvState &&
          FINISHED.has((JSON.parse(kvState) as { status?: DeliveryStatus }).status ?? null)
        ) {
          return { status: "finished", token: null };
        }
      }
      const now = Date.now();
      const result = await db
        .prepare(
          `INSERT INTO delivery_state (key, status, updated_at) VALUES (?, 'processing', ?)
           ON CONFLICT(key) DO UPDATE SET status = 'processing', updated_at = excluded.updated_at
           WHERE delivery_state.status IN ('pending', 'retrying')
              OR (delivery_state.status = 'processing' AND delivery_state.updated_at < ?)`,
        )
        .bind(key, now, now - LEASE_MS)
        .run();
      if ((result.meta?.changes ?? 0) > 0) return { status: "acquired", token: now };
      const status = await getDeliveryState(env, key);
      return { status: FINISHED.has(status) ? "finished" : "busy", token: null };
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      log.warn({ err, key }, "D1 delivery_state table missing, falling back to KV");
      await noteKvFallback(env.KV);
    }
  }
  // KV: best effort (no atomic compare-and-set).
  const prior = await getDeliveryState(env, key);
  if (FINISHED.has(prior)) return { status: "finished", token: null };
  await setDeliveryState(env, key, "processing");
  return { status: "acquired", token: null };
}

/**
 * Mark a delivery dead (its message left the DLQ) — atomically, and only
 * while it is neither finished nor held by a live lease: a copy of the same
 * delivery that finished or is still sending keeps its state. Without D1:
 * best effort.
 */
export async function markDeliveryDead(
  env: Env,
  key: string,
): Promise<"dead" | "finished" | "busy"> {
  if (canUseD1(env.DB)) {
    try {
      const now = Date.now();
      const result = await env.DB.prepare(
        `INSERT INTO delivery_state (key, status, updated_at) VALUES (?, 'dead', ?)
         ON CONFLICT(key) DO UPDATE SET status = 'dead', updated_at = excluded.updated_at
         WHERE delivery_state.status IN ('pending', 'retrying')
            OR (delivery_state.status = 'processing' AND delivery_state.updated_at < ?)`,
      )
        .bind(key, now, now - LEASE_MS)
        .run();
      if ((result.meta?.changes ?? 0) > 0) return "dead";
      return FINISHED.has(await getDeliveryState(env, key)) ? "finished" : "busy";
    } catch (err) {
      if (!isMissingTable(err)) throw err;
    }
  }
  if (FINISHED.has(await getDeliveryState(env, key))) return "finished";
  await setDeliveryState(env, key, "dead");
  return "dead";
}

/**
 * Extend a held lease; the new token, or null when the lease was lost (taken
 * over after expiry). Without D1 the lease cannot be fenced and stays valid.
 */
export async function renewLease(
  env: Env,
  key: string,
  token: number | null,
): Promise<number | null> {
  if (token == null || !canUseD1(env.DB)) return token;
  const now = Math.max(Date.now(), token + 1);
  const result = await env.DB.prepare(
    `UPDATE delivery_state SET updated_at = ?
     WHERE key = ? AND status = 'processing' AND updated_at = ?`,
  )
    .bind(now, key, token)
    .run();
  return (result.meta?.changes ?? 0) > 0 ? now : null;
}

/**
 * Write the outcome of a held lease (`retrying` or a terminal status); false
 * when the lease was lost meanwhile — the new holder's state then stands.
 */
export async function finishLease(
  env: Env,
  key: string,
  token: number | null,
  status: DeliveryStatus,
): Promise<boolean> {
  if (token == null || !canUseD1(env.DB)) {
    await setDeliveryState(env, key, status);
    return true;
  }
  const result = await env.DB.prepare(
    `UPDATE delivery_state SET status = ?, updated_at = ?
     WHERE key = ? AND status = 'processing' AND updated_at = ?`,
  )
    .bind(status, Math.max(Date.now(), token + 1), key, token)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

function targetDoneKey(stateKey: string, targetKey: string): string {
  return `delivery-target:${stateKey}:${targetKey}`;
}

/**
 * Remember route × targets that need no further attempt for this delivery —
 * one D1 transaction for all of them (KV claims without D1 or its table).
 * With `permanentFailure`, the delivery's permanent-failure marker is written
 * in the same transaction: a target is never skipped as finished while the
 * failure that finished it is forgotten (which would let the delivery end
 * up `delivered`).
 */
export async function markTargetsDone(
  env: Env,
  stateKey: string,
  targetKeys: string[],
  opts: { permanentFailure?: boolean } = {},
): Promise<void> {
  const keys = targetKeys.map((t) => targetDoneKey(stateKey, t));
  // The marker goes first: in the KV fallback, a write failing midway leaves
  // at worst a marker without its target (the target is simply retried).
  if (opts.permanentFailure) keys.unshift(permanentFailureKey(stateKey));
  if (keys.length === 0) return;
  if (canUseD1(env.DB)) {
    const now = Date.now();
    const expires = now + LEDGER_TTL_SECONDS * 1000;
    try {
      await env.DB.batch(
        keys.map((key) =>
          env.DB.prepare(
            `INSERT INTO dedup_keys (key, claimed_at, expires_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at`,
          ).bind(key, now, expires),
        ),
      );
      return;
    } catch (err) {
      if (!isMissingTable(err)) throw err;
    }
  }
  await noteKvFallback(env.KV);
  const store = kvIdempotencyStore(env.KV);
  for (const key of keys) {
    await store.claim(key, LEDGER_TTL_SECONDS);
  }
}

/**
 * Whether a route × target already finished in an earlier attempt of this
 * delivery. The delivery's finished targets are read in one D1 query (on the
 * first check) rather than one per target: a large fan-out would otherwise
 * spend the invocation's D1 queries before sending anything.
 */
export function targetDoneChecker(
  env: Env,
  stateKey: string,
): (targetKey: string) => Promise<boolean> {
  const store = idempotencyStore(env.DB, env.KV);
  let finished: Promise<Set<string> | null> | null = null;
  return async (targetKey) => {
    const key = targetDoneKey(stateKey, targetKey);
    finished ??= finishedTargets(env, stateKey);
    const known = await finished;
    if (!known) return store.has(key);
    if (known.has(key)) return true;
    // Copies written to KV while the table was missing: looked up only for
    // the targets D1 does not know as finished.
    return (await kvFallbackActive(env.KV)) ? kvIdempotencyStore(env.KV).has(key) : false;
  };
}

/** The delivery's finished-target keys, or null where they are read one by one. */
async function finishedTargets(env: Env, stateKey: string): Promise<Set<string> | null> {
  if (!canUseD1(env.DB)) return null;
  const prefix = targetDoneKey(stateKey, "");
  try {
    const { results } = await env.DB.prepare(
      "SELECT key FROM dedup_keys WHERE key >= ? AND key < ? AND expires_at > ?",
    )
      .bind(prefix, `${prefix}\uffff`, Date.now())
      .all<{ key: string }>();
    return new Set((results ?? []).map((r) => r.key));
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

function permanentFailureKey(stateKey: string): string {
  return `delivery-failed:${stateKey}`;
}

/** Whether an earlier attempt of this delivery left a target failed for good. */
export function hadPermanentFailure(env: Env, stateKey: string): Promise<boolean> {
  return idempotencyStore(env.DB, env.KV).has(permanentFailureKey(stateKey));
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Enqueue a verified webhook. Payloads too large for a queue message are
 * parked in R2 (or KV) first; when the send itself fails, the parked copy is
 * removed again and the error propagates, so the caller can tell the sender
 * to retry instead of acknowledging an event that was never queued.
 */
export async function enqueueWebhook(env: Env, message: DeliveryMessage): Promise<void> {
  const queue = env.QUEUE;
  if (!queue) throw new Error("QUEUE binding is not configured");
  const { payload, ...rest } = message;
  const direct: DeliveryMessage = { ...rest, payload };
  if (byteLength(JSON.stringify(direct)) <= MAX_QUEUE_MESSAGE_BYTES) {
    await queue.send(direct);
    return;
  }
  const serialized = JSON.stringify(payload ?? {});
  let parked: DeliveryMessage;
  if (env.PAYLOAD) {
    const key = await r2PayloadStore(env).put(serialized, PAYLOAD_TTL_SECONDS);
    parked = { ...rest, payloadRef: key, payloadRefType: "r2" };
  } else {
    const payloadRef = payloadKey(message.provider, message.groupId, message.deliveryId);
    await env.KV.put(payloadRef, serialized, { expirationTtl: PAYLOAD_TTL_SECONDS });
    parked = { ...rest, payloadRef, payloadRefType: "kv" };
  }
  // A failed send leaves the parked copy in place: the queue may have taken
  // the message after all (the error can be a lost response), and deleting
  // the payload would doom it. An unused copy expires (KV TTL) or is pruned
  // as an orphan (R2).
  await queue.send(parked);
}

function parsePayload(raw: string, ref: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // reported below
  }
  throw new PayloadUnavailableError(`Parked payload ${ref} is corrupt`);
}

/**
 * The event payload of a queued delivery. A parked payload that is missing or
 * corrupt is an explicit error — dispatching an empty payload instead would
 * match nothing and record the delivery as delivered.
 */
export async function resolvePayload(
  env: Env,
  message: DeliveryMessage,
): Promise<Record<string, unknown>> {
  if (message.payload) return message.payload;
  if (!message.payloadRef) throw new PayloadUnavailableError("Delivery carries no payload");
  if (message.payloadRefType === "r2") {
    if (!env.PAYLOAD) throw new Error("R2 binding is not configured");
    const raw = await r2PayloadStore(env).get(message.payloadRef);
    if (raw == null) {
      throw new PayloadUnavailableError(`Parked payload ${message.payloadRef} is missing`);
    }
    return parsePayload(raw, message.payloadRef);
  }
  const raw = await env.KV.get(message.payloadRef);
  if (raw == null) {
    // KV writes can take a while to become visible elsewhere: a payload
    // parked minutes ago is retried, not declared lost.
    if (Date.now() - message.receivedAt < KV_VISIBILITY_GRACE_MS) {
      throw new Error(`Parked payload ${message.payloadRef} is not visible yet`);
    }
    throw new PayloadUnavailableError(`Parked payload ${message.payloadRef} is missing`);
  }
  return parsePayload(raw, message.payloadRef);
}

export async function discardPayload(env: Env, message: DeliveryMessage): Promise<void> {
  if (!message.payloadRef) return;
  if (message.payloadRefType === "r2") {
    if (env.PAYLOAD) await r2PayloadStore(env).delete(message.payloadRef);
    return;
  }
  await env.KV.delete(message.payloadRef);
}
