import type { Env } from "../types";
import { idempotencyStore, type IdempotencyStore } from "../lib/idempotency";
import { log } from "../lib/log";
import { canUseD1 } from "./d1";

/**
 * Where the state of a webhook delivery lives: its dedup claim and replay
 * nonce at ingress, its lease and status, the finished-target ledger and the
 * messages it edits. D1 is the default: Workers Free allows 100,000 row
 * writes/day there, while each write is a round trip to the database. KV
 * answers from the edge, but allows only ~1,000 writes/day on the free plan
 * and has no compare-and-set, so a lease or a claim can be taken twice in a
 * race — the deliberate trade for latency at low volume.
 */
export type DeliveryStateStore = "d1" | "kv";

/** Unknown values already reported (the binding is fixed per deployment). */
const warned = new Set<string>();

/** The configured store: `DELIVERY_STATE_STORE=kv` switches, anything else is D1. */
export function deliveryStateStore(env: Pick<Env, "DELIVERY_STATE_STORE">): DeliveryStateStore {
  const value = (env.DELIVERY_STATE_STORE ?? "").trim().toLowerCase();
  if (value === "kv") return "kv";
  if (value !== "" && value !== "d1" && !warned.has(value)) {
    warned.add(value);
    log.warn({ value }, "Unknown DELIVERY_STATE_STORE, using d1");
  }
  return "d1";
}

/**
 * Whether delivery state is written to D1: the configured store, when the
 * binding can take it. State written to KV is marked, so a deployment
 * switched back to D1 still honors its claims and leases. The other direction
 * is not read: with `kv` set, the D1 rows of the past days — dedup claims and
 * their confirmations, delivery states, the finished-target ledger, message
 * tracking (30 days) — are invisible, so a redelivery of an event that already
 * finished is sent again, targets already sent are sent again, and an
 * in-progress `workflow_run`/`check_run` chain posts a new message. Switching
 * on a quiet deployment, or draining the queue first, avoids that.
 */
export function deliveryStateUsesD1(env: Pick<Env, "DB" | "DELIVERY_STATE_STORE">): boolean {
  return deliveryStateStore(env) === "d1" && canUseD1(env.DB);
}

/**
 * The claim store of the delivery pipeline (ingress dedup, replay nonces, the
 * delivery target ledger). Out of scope: claims tied to a D1 transaction of
 * their own (invites, sessions, tokens, bot interactions, group ids), which
 * stay in D1 whichever store deliveries use.
 */
export function deliveryClaimStore(
  env: Pick<Env, "DB" | "KV" | "DELIVERY_STATE_STORE">,
): IdempotencyStore {
  return idempotencyStore(deliveryStateUsesD1(env) ? env.DB : undefined, env.KV);
}
