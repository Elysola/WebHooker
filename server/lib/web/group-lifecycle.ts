import type { Env } from "../types";
import { retiredGroupKey, type LifecycleStatements } from "../storage/config-store";
import { idempotencyStore, instanceScope } from "../lib/idempotency";
import { canUseD1 } from "../storage/d1";
import { log } from "../lib/log";

/**
 * A deleted or renamed group id stays retired this long: queued deliveries
 * still addressed to it (queue retries span minutes, the DLQ up to days) can
 * then never reach an unrelated group that took over the id.
 */
const RETIRED_TTL_SECONDS = 4 * 86400;
const ALIAS_TTL_SECONDS = 4 * 86400;

const retiredKey = retiredGroupKey;

function aliasKey(id: string): string {
  return `group:renamed:${id}`;
}

/** D1 alias row: `group-alias:{from} {to}` (ids never contain spaces). */
function aliasRowPrefix(from: string): string {
  return `group-alias:${from} `;
}

/**
 * The first key past every key starting with `prefix` (its last character
 * incremented): `key >= prefix AND key < end` is a primary-key range, where
 * `substr(key, …) = prefix` scans the whole table.
 */
function prefixEnd(prefix: string): string {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

function retireStatement(db: D1Database, id: string): D1PreparedStatement {
  const now = Date.now();
  return db
    .prepare(
      `INSERT INTO dedup_keys (key, claimed_at, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET claimed_at = excluded.claimed_at, expires_at = excluded.expires_at`,
    )
    .bind(retiredKey(id), now, now + RETIRED_TTL_SECONDS * 1000);
}

/**
 * Statements committed with a group's deletion: its send logs and audit
 * entries stay for super admins but no longer belong to any group (a later
 * group with the same id must not inherit them), its message tracking is
 * dropped, and the id is retired.
 */
export function deleteLifecycle(
  id: string,
  instance?: string,
  legacyId?: string,
): LifecycleStatements {
  // The group's own chains only: under its instance, and — from before
  // instances — under the id it had back then. Rows under its current id may
  // belong to the group that had that id before instances.
  const prefixes = [
    ...(instance ? [`${instanceScope(instance)}:`] : []),
    ...(legacyId ? [`${legacyId}:`] : []),
  ];
  return (db) => [
    db.prepare("UPDATE send_logs SET group_id = NULL WHERE group_id = ?").bind(id),
    db.prepare("UPDATE audit_logs SET group_id = NULL WHERE group_id = ?").bind(id),
    ...prefixes.map((prefix) =>
      db
        .prepare("DELETE FROM message_tracking WHERE event_id >= ? AND event_id < ?")
        .bind(prefix, prefixEnd(prefix)),
    ),
    retireStatement(db, id),
  ];
}

/**
 * Statements committed with a group's rename: its history moves to the new id
 * (visible to the group, to nobody else), and the old id is retired. Message
 * tracking stays put: chains are keyed by the group's instance, and those from
 * before instances by its `legacyId` — neither changes with a rename.
 */
export function renameLifecycle(from: string, to: string): LifecycleStatements {
  return (db) => [
    db.prepare("UPDATE send_logs SET group_id = ? WHERE group_id = ?").bind(to, from),
    db.prepare("UPDATE audit_logs SET group_id = ? WHERE group_id = ?").bind(to, from),
    retireStatement(db, from),
    // Committed with the rename itself: queued deliveries for the old id can
    // always find the new one.
    db
      .prepare(
        `INSERT INTO dedup_keys (key, claimed_at, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET claimed_at = excluded.claimed_at, expires_at = excluded.expires_at`,
      )
      .bind(`${aliasRowPrefix(from)}${to}`, Date.now(), Date.now() + ALIAS_TTL_SECONDS * 1000),
  ];
}

/** Mark a group id as recently used (KV-only deployments; D1 does it in the transaction). */
export async function retireGroupId(env: Env, id: string): Promise<void> {
  if (canUseD1(env.DB)) return;
  try {
    await idempotencyStore(env.DB, env.KV).claim(retiredKey(id), RETIRED_TTL_SECONDS);
  } catch (err) {
    log.warn({ err, id }, "Failed to retire group id");
  }
}

export async function isGroupIdRetired(env: Env, id: string): Promise<boolean> {
  return idempotencyStore(env.DB, env.KV).has(retiredKey(id));
}

/** Remember where a renamed group went (KV-only deployments; D1 records it in the rename). */
export async function recordGroupRename(env: Env, from: string, to: string): Promise<void> {
  if (canUseD1(env.DB)) return;
  await env.KV.put(aliasKey(from), to, { expirationTtl: ALIAS_TTL_SECONDS });
}

async function nextAlias(env: Env, id: string): Promise<string | null> {
  if (canUseD1(env.DB)) {
    const prefix = aliasRowPrefix(id);
    const row = await env.DB.prepare(
      `SELECT key FROM dedup_keys WHERE key >= ? AND key < ? AND expires_at > ?
       ORDER BY claimed_at DESC LIMIT 1`,
    )
      .bind(prefix, prefixEnd(prefix), Date.now())
      .first<{ key: string }>();
    return row ? row.key.slice(prefix.length) : null;
  }
  return env.KV.get(aliasKey(id));
}

/**
 * The current id of a group that may have been renamed (follows chains).
 * Read errors propagate: an unknown alias must not pass for "no alias".
 */
export async function resolveGroupAlias(env: Env, id: string): Promise<string> {
  return (await groupAliasChain(env, id)).at(-1)!;
}

/** Every id a group had from `id` on, oldest first (`id` itself included). */
export async function groupAliasChain(env: Env, id: string): Promise<string[]> {
  const chain = [id];
  for (let i = 0; i < 5; i++) {
    const next = await nextAlias(env, chain.at(-1)!);
    if (!next || chain.includes(next)) break;
    chain.push(next);
  }
  return chain;
}
