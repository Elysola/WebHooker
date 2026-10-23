import { canUseD1, isMissingTable, kvFallbackActive, noteKvFallback } from "../storage/d1";
import { log } from "./log";

/**
 * Delivery idempotency: a small, reusable abstraction over "has this key been
 * seen / can I claim it once" so webhook dedup, nonce replay protection,
 * invite consumption and bot-command dedup all share one semantics. Backed by
 * D1 when the binding is present (atomic UPSERT), falling back to a
 * best-effort get-then-put KV claim otherwise — and also when the D1 table
 * does not exist yet (an unmigrated database). Other D1 failures propagate.
 */
export interface IdempotencyStore {
  has(key: string): Promise<boolean>;
  claim(key: string, ttlSeconds: number): Promise<boolean>;
  /** Give a claim back (the claimed work failed and may be retried). */
  release(key: string): Promise<void>;
}

/** KV rejects TTLs under 60 seconds. */
function kvTtl(ttlSeconds: number): number {
  return Math.max(60, Math.ceil(ttlSeconds));
}

export function kvIdempotencyStore(kv: KVNamespace): IdempotencyStore {
  return {
    async has(key): Promise<boolean> {
      const value = await kv.get(key);
      return value !== null && value !== undefined;
    },
    async claim(key, ttlSeconds): Promise<boolean> {
      const value = await kv.get(key);
      if (value !== null && value !== undefined) return false;
      // KV has no compare-and-set: write a unique value and read it back, so
      // of two racing claimers the one whose write was overwritten backs off
      // (best effort — D1 is the atomic store).
      const mine = crypto.randomUUID();
      await kv.put(key, mine, { expirationTtl: kvTtl(ttlSeconds) });
      return (await kv.get(key)) === mine;
    },
    async release(key): Promise<void> {
      await kv.delete(key);
    },
  };
}

export function d1IdempotencyStore(db: D1Database): IdempotencyStore {
  return {
    async has(key): Promise<boolean> {
      const row = await db
        .prepare("SELECT 1 AS hit FROM dedup_keys WHERE key = ? AND expires_at > ?")
        .bind(key, Date.now())
        .first<{ hit: number }>();
      return row != null;
    },
    async claim(key, ttlSeconds): Promise<boolean> {
      const now = Date.now();
      const result = await db
        .prepare(
          `INSERT INTO dedup_keys (key, claimed_at, expires_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             claimed_at = excluded.claimed_at, expires_at = excluded.expires_at
           WHERE dedup_keys.expires_at < excluded.claimed_at`,
        )
        .bind(key, now, now + ttlSeconds * 1000)
        .run();
      return (result.meta?.changes ?? 0) > 0;
    },
    async release(key): Promise<void> {
      await db.prepare("DELETE FROM dedup_keys WHERE key = ?").bind(key).run();
    },
  };
}

/** Run against D1, degrading to KV only while the D1 table is missing. */
function withKvFallback(
  primary: IdempotencyStore,
  fallback: IdempotencyStore,
  kvNs: KVNamespace,
): IdempotencyStore {
  async function run<T>(op: string, d1: () => Promise<T>, kv: () => Promise<T>): Promise<T> {
    try {
      return await d1();
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      log.warn({ err, op }, "D1 dedup table missing, falling back to KV");
      await noteKvFallback(kvNs);
      return kv();
    }
  }
  return {
    has: (key) =>
      run(
        "has",
        async () =>
          (await primary.has(key)) || ((await kvFallbackActive(kvNs)) && fallback.has(key)),
        () => fallback.has(key),
      ),
    claim: (key, ttl) =>
      run(
        "claim",
        async () => {
          // Claimed in KV while the table was missing: still taken.
          if ((await kvFallbackActive(kvNs)) && (await fallback.has(key))) return false;
          return primary.claim(key, ttl);
        },
        () => fallback.claim(key, ttl),
      ),
    release: (key) =>
      run(
        "release",
        async () => {
          await primary.release(key);
          // A copy claimed in KV while the table was missing must go too.
          if (await kvFallbackActive(kvNs)) await fallback.release(key);
        },
        () => fallback.release(key),
      ),
  };
}

export function idempotencyStore(db: D1Database, kv: KVNamespace): IdempotencyStore {
  if (canUseD1(db)) return withKvFallback(d1IdempotencyStore(db), kvIdempotencyStore(kv), kv);
  // Without D1, claims live in KV: marked, so a D1 binding added later still
  // honors the ones not expired yet.
  const store = kvIdempotencyStore(kv);
  return {
    ...store,
    async claim(key, ttl): Promise<boolean> {
      await noteKvFallback(kv);
      return store.claim(key, ttl);
    },
  };
}

/**
 * Key segment naming a group instance. The `@` keeps it apart from every group
 * id (ids are `[a-z0-9-]`): an id chosen to equal some instance string can
 * never address that instance's keys, and no id-prefix scan reaches them.
 */
export function instanceScope(instance: string): string {
  return `@i:${instance}`;
}

/**
 * Scope segment of a tenant: the group's immutable instance when known (a
 * group re-created under a former id never shares state with its
 * predecessor, and a renamed group keeps its own), else the group id
 * (messages from before instances), or a marker no group id can take for the
 * legacy global endpoint.
 */
export function tenantScope(groupId: string | undefined, instance?: string): string {
  if (groupId && instance) return instanceScope(instance);
  return groupId ?? "@global";
}

/**
 * Marker that the work a claim guarded was accepted for good. A claim alone
 * may be left over from an attempt that failed and could not give it back;
 * only a confirmed one proves a retry is a duplicate. The prefix keeps it
 * apart from every claim key (none starts with it), whatever ids they embed.
 */
export function acceptedKey(key: string): string {
  return `accepted:${key}`;
}

/**
 * - `claimed`: this caller runs the work (and must confirm or release it);
 * - `done`: an earlier run was confirmed — a duplicate;
 * - `pending`: another run holds the claim unconfirmed (still running, or it
 *   failed and could not give the claim back): retry later, after `ttl` at most.
 */
export type ClaimState = "claimed" | "done" | "pending";

/**
 * Claim one-time work: a short processing claim (`ttlSeconds`), confirmed
 * with `confirmClaim` once the work is done for good. A failed run that also
 * fails to give its claim back blocks retries only until the claim expires,
 * and is never mistaken for a finished one.
 */
export async function claimOnce(
  store: IdempotencyStore,
  key: string,
  ttlSeconds: number,
): Promise<ClaimState> {
  if (await store.has(acceptedKey(key))) return "done";
  if (await store.claim(key, ttlSeconds)) return "claimed";
  return (await store.has(acceptedKey(key))) ? "done" : "pending";
}

const CONFIRM_ATTEMPTS = 3;

/**
 * Record that claimed work was done; duplicates are recognized for
 * `ttlSeconds`. Tried a few times: once the work happened, a lost
 * confirmation leaves only the short processing claim between a late
 * redelivery and running the work again.
 */
export async function confirmClaim(
  store: IdempotencyStore,
  key: string,
  ttlSeconds: number,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await store.claim(acceptedKey(key), ttlSeconds);
      return;
    } catch (err) {
      if (attempt >= CONFIRM_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
}

/**
 * Statement recording `key` (as `claim` would) in the same D1 transaction as
 * other writes: the record and the writes commit together, so a failure
 * whose answer was lost can be told apart afterwards (`has(key)`).
 */
export function recordStatement(
  db: D1Database,
  key: string,
  ttlSeconds: number,
): D1PreparedStatement {
  const now = Date.now();
  return db
    .prepare(
      `INSERT INTO dedup_keys (key, claimed_at, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         claimed_at = excluded.claimed_at, expires_at = excluded.expires_at`,
    )
    .bind(key, now, now + ttlSeconds * 1000);
}

/**
 * Statement aborting its D1 transaction while `key` is recorded (unexpired):
 * a write done once can never be done again by a replay.
 */
export function unrecordedGuard(db: D1Database, key: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT CASE WHEN EXISTS (SELECT 1 FROM dedup_keys WHERE key = ? AND expires_at > ?)
       THEN json('already recorded') ELSE 1 END AS ok`,
    )
    .bind(key, Date.now());
}

/** Canonical dedup key for a webhook delivery: provider + tenant + delivery id. */
export function deliveryKey(
  provider: string,
  groupId: string | undefined,
  deliveryId: string,
  instance?: string,
): string {
  return `delivery:${provider}:${tenantScope(groupId, instance)}:${deliveryId}`;
}
