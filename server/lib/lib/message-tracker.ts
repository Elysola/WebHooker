import { canUseD1, isMissingTable, kvFallbackActive, noteKvFallback } from "../storage/d1";
import { log } from "./log";

/**
 * A tracked platform message: its id plus the version (event time, ms) of the
 * update it currently shows, so an older event arriving late never overwrites
 * a newer state. Entries written before versions existed carry `version: 0`.
 */
export interface TrackedMessage {
  messageId: string;
  version: number;
}

export interface MessageTracker {
  get(eventId: string, targetId: string): Promise<TrackedMessage | null>;
  /** Store (or refresh) an entry; refreshing also renews its retention. */
  set(eventId: string, targetId: string, entry: TrackedMessage): Promise<void>;
  delete(eventId: string, targetId: string): Promise<void>;
  /**
   * Re-file an entry under a new key, dropping the old one — in one D1
   * transaction, so the entry is never left under both (two owners).
   */
  move(
    from: { eventId: string; targetId: string },
    to: { eventId: string; targetId: string },
    entry: TrackedMessage,
  ): Promise<void>;
}

/** KV entries outlive the D1 retention of message_tracking rows (30 days). */
const MESSAGE_KEY_TTL_SECONDS = 30 * 86400;

/** Stored value: JSON `{ id, v }`, or a bare message id from older versions. */
export function decodeTracked(value: string | null | undefined): TrackedMessage | null {
  if (!value) return null;
  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as { id?: unknown; v?: unknown };
      if (typeof parsed.id === "string" && parsed.id) {
        return { messageId: parsed.id, version: Number(parsed.v) || 0 };
      }
    } catch {
      // fall through: treat as a bare id
    }
  }
  return { messageId: value, version: 0 };
}

export function encodeTracked(entry: TrackedMessage): string {
  return JSON.stringify({ id: entry.messageId, v: entry.version });
}

/**
 * What a moved entry leaves under its old key in D1: a tombstone. Without it,
 * a KV copy of the old entry (written while the table was missing, its delete
 * not yet seen everywhere) could be read back and adopted a second time.
 */
const MOVED = '{"moved":true}';

export function kvMessageTracker(kv: KVNamespace): MessageTracker {
  const key = (eventId: string, targetId: string): string => `msg:${eventId}:${targetId}`;
  return {
    async get(eventId, targetId): Promise<TrackedMessage | null> {
      return decodeTracked(await kv.get(key(eventId, targetId)));
    },
    async set(eventId, targetId, entry): Promise<void> {
      await kv.put(key(eventId, targetId), encodeTracked(entry), {
        expirationTtl: MESSAGE_KEY_TTL_SECONDS,
      });
    },
    async delete(eventId, targetId): Promise<void> {
      await kv.delete(key(eventId, targetId));
    },
    async move(from, to, entry): Promise<void> {
      // No transactions in KV: the old key goes first, so a failure leaves
      // the entry lost (a new message later) rather than owned twice.
      await kv.delete(key(from.eventId, from.targetId));
      await kv.put(key(to.eventId, to.targetId), encodeTracked(entry), {
        expirationTtl: MESSAGE_KEY_TTL_SECONDS,
      });
    },
  };
}

/** A D1 lookup: the entry, and whether its key was moved away (a tombstone). */
async function d1Lookup(
  db: D1Database,
  eventId: string,
  targetId: string,
): Promise<{ entry: TrackedMessage | null; moved: boolean }> {
  const row = await db
    .prepare("SELECT message_id FROM message_tracking WHERE event_id = ? AND target_id = ?")
    .bind(eventId, targetId)
    .first<{ message_id: string }>();
  if (row?.message_id === MOVED) return { entry: null, moved: true };
  return { entry: decodeTracked(row?.message_id), moved: false };
}

export function d1MessageTracker(db: D1Database): MessageTracker {
  return {
    async get(eventId, targetId): Promise<TrackedMessage | null> {
      return (await d1Lookup(db, eventId, targetId)).entry;
    },
    async set(eventId, targetId, entry): Promise<void> {
      await db
        .prepare(
          `INSERT INTO message_tracking (event_id, target_id, message_id, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(event_id, target_id) DO UPDATE SET
             message_id = excluded.message_id, updated_at = excluded.updated_at`,
        )
        .bind(eventId, targetId, encodeTracked(entry), Date.now())
        .run();
    },
    async delete(eventId, targetId): Promise<void> {
      await db
        .prepare("DELETE FROM message_tracking WHERE event_id = ? AND target_id = ?")
        .bind(eventId, targetId)
        .run();
    },
    async move(from, to, entry): Promise<void> {
      await db.batch([
        db
          .prepare(
            `INSERT INTO message_tracking (event_id, target_id, message_id, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(event_id, target_id) DO UPDATE SET
               message_id = excluded.message_id, updated_at = excluded.updated_at`,
          )
          .bind(to.eventId, to.targetId, encodeTracked(entry), Date.now()),
        // The old key keeps a tombstone (pruned with the other rows).
        db
          .prepare(
            `INSERT INTO message_tracking (event_id, target_id, message_id, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(event_id, target_id) DO UPDATE SET
               message_id = excluded.message_id, updated_at = excluded.updated_at`,
          )
          .bind(from.eventId, from.targetId, MOVED, Date.now()),
      ]);
    },
  };
}

/** D1 first; degrades to KV only while the D1 table is missing (unmigrated). */
function withKvFallback(
  primary: MessageTracker,
  fallback: MessageTracker,
  kvNs: KVNamespace,
  db: D1Database,
): MessageTracker {
  async function run<T>(op: string, d1: () => Promise<T>, kv: () => Promise<T>): Promise<T> {
    try {
      return await d1();
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      log.warn({ err, op }, "D1 message_tracking table missing, falling back to KV");
      await noteKvFallback(kvNs);
      return kv();
    }
  }
  return {
    get: (e, t) =>
      run(
        "get",
        async () => {
          const { entry, moved } = await d1Lookup(db, e, t);
          // A moved key never falls back to its KV copy.
          if (entry || moved) return entry;
          return (await kvFallbackActive(kvNs)) ? fallback.get(e, t) : null;
        },
        () => fallback.get(e, t),
      ),
    set: (e, t, entry) =>
      run(
        "set",
        () => primary.set(e, t, entry),
        () => fallback.set(e, t, entry),
      ),
    delete: (e, t) =>
      run(
        "delete",
        async () => {
          await primary.delete(e, t);
          // Otherwise the KV copy from the missing-table period would resurface.
          if (await kvFallbackActive(kvNs)) await fallback.delete(e, t);
        },
        () => fallback.delete(e, t),
      ),
    move: (from, to, entry) =>
      run(
        "move",
        async () => {
          // D1 first (the new entry and the old key's tombstone, together):
          // from then on the tombstone keeps any KV copy from being adopted
          // again. The KV copy goes after — removing it first would lose the
          // entry altogether should the D1 write fail.
          await primary.move(from, to, entry);
          // Cleanup only (the tombstone already guards): a failure here never
          // fails the move that went through.
          try {
            if (await kvFallbackActive(kvNs)) await fallback.delete(from.eventId, from.targetId);
          } catch {
            // left to expire
          }
        },
        () => fallback.move(from, to, entry),
      ),
  };
}

export function messageTracker(db: D1Database, kv: KVNamespace): MessageTracker {
  if (canUseD1(db)) return withKvFallback(d1MessageTracker(db), kvMessageTracker(kv), kv, db);
  // Without D1, tracking lives in KV: marked, so a D1 binding added later
  // still finds the messages to edit.
  const tracker = kvMessageTracker(kv);
  return {
    ...tracker,
    async set(eventId, targetId, entry): Promise<void> {
      await noteKvFallback(kv);
      return tracker.set(eventId, targetId, entry);
    },
    async move(from, to, entry): Promise<void> {
      await noteKvFallback(kv);
      return tracker.move(from, to, entry);
    },
  };
}

/**
 * Serializes the updates of one message chain. With D1 the lock is a
 * `dedup_keys` row taken by an atomic conditional UPSERT (taken over only once
 * expired) and released only by its holder, identified by the claim time it
 * wrote. Without D1 it degrades to a best-effort KV marker.
 */
export interface ChainLock {
  /** A holder token, or null while someone else holds the lock. */
  acquire(key: string, ttlSeconds: number): Promise<string | null>;
  release(key: string, token: string): Promise<void>;
}

export function chainLock(db: D1Database, kv: KVNamespace): ChainLock {
  const kvLock: ChainLock = {
    async acquire(key, ttlSeconds) {
      if (await kv.get(key)) return null;
      const token = crypto.randomUUID();
      await kv.put(key, token, { expirationTtl: Math.max(60, ttlSeconds) });
      return token;
    },
    async release(key, token) {
      if ((await kv.get(key)) === token) await kv.delete(key);
    },
  };
  if (!canUseD1(db)) return kvLock;
  return {
    async acquire(key, ttlSeconds): Promise<string | null> {
      const now = Date.now();
      try {
        const result = await db
          .prepare(
            `INSERT INTO dedup_keys (key, claimed_at, expires_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET
               claimed_at = excluded.claimed_at, expires_at = excluded.expires_at
             WHERE dedup_keys.expires_at < excluded.claimed_at`,
          )
          .bind(key, now, now + ttlSeconds * 1000)
          .run();
        return (result.meta?.changes ?? 0) > 0 ? String(now) : null;
      } catch (err) {
        if (!isMissingTable(err)) throw err;
        return kvLock.acquire(key, ttlSeconds);
      }
    },
    async release(key, token): Promise<void> {
      try {
        await db
          .prepare("DELETE FROM dedup_keys WHERE key = ? AND claimed_at = ?")
          .bind(key, Number(token))
          .run();
      } catch (err) {
        if (!isMissingTable(err)) throw err;
        await kvLock.release(key, token);
      }
    },
  };
}
