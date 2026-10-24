import { groupScopeClause, type GroupScope } from "./send-log";
import { log } from "./log";
import { isMissingTable } from "../storage/d1";

export interface AuditEntry {
  id?: number;
  ts: number;
  actorId?: string;
  actorLogin?: string;
  /** Machine-readable action, e.g. "session.login", "group.update", "invite.create". */
  action: string;
  targetType?: string;
  targetId?: string;
  groupId?: string;
  /**
   * Immutable instance of the group (write-only): the entry is filed under
   * whatever id that instance has when it is written.
   */
  groupInstance?: string;
  /** Free-form metadata. Never include secrets or message bodies. */
  detail?: Record<string, unknown>;
  ip?: string;
}

const COLUMNS =
  "id, ts, actor_id, actor_login, action, target_type, target_id, group_id, detail, ip";

interface AuditRow {
  id: number;
  ts: number;
  actor_id: string | null;
  actor_login: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  group_id: string | null;
  detail: string | null;
  ip: string | null;
}

function toEntry(r: AuditRow): AuditEntry {
  return {
    id: r.id,
    ts: r.ts,
    actorId: r.actor_id ?? undefined,
    actorLogin: r.actor_login ?? undefined,
    action: r.action,
    targetType: r.target_type ?? undefined,
    targetId: r.target_id ?? undefined,
    groupId: r.group_id ?? undefined,
    detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : undefined,
    ip: r.ip ?? undefined,
  };
}

/**
 * Best-effort write; failures never break the business flow.
 *
 * The group is resolved when the row is written, not when the action was
 * decided: an entry landing after its group was renamed is filed under the
 * new id (with the instance known), after a delete or a rename under none —
 * never under an id another group may take over later.
 */
export async function recordAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  const insert = (groupSql: string, ...groupArgs: Array<string | null>): D1PreparedStatement =>
    db
      .prepare(
        `INSERT INTO audit_logs (ts, actor_id, actor_login, action, target_type, target_id, group_id, detail, ip)
         VALUES (?, ?, ?, ?, ?, ?, ${groupSql}, ?, ?)`,
      )
      .bind(
        entry.ts,
        entry.actorId ?? null,
        entry.actorLogin ?? null,
        entry.action,
        entry.targetType ?? null,
        entry.targetId ?? null,
        ...groupArgs,
        entry.detail ? JSON.stringify(entry.detail) : null,
        entry.ip ?? null,
      );
  try {
    try {
      if (entry.groupInstance) {
        // The id given is tried first (a primary-key lookup); the groups are
        // scanned only when it no longer holds that instance (renamed).
        await insert(
          "COALESCE((SELECT id FROM d1_groups WHERE id = ? AND json_valid(data) AND json_extract(data, '$.instance') = ?), (SELECT id FROM (SELECT id, CASE WHEN json_valid(data) THEN data ELSE '{}' END AS data FROM d1_groups) WHERE json_extract(data, '$.instance') = ?))",
          entry.groupId ?? "",
          entry.groupInstance,
          entry.groupInstance,
        ).run();
      } else if (entry.groupId) {
        await insert("(SELECT id FROM d1_groups WHERE id = ?)", entry.groupId).run();
      } else {
        await insert("?", null).run();
      }
    } catch (err) {
      // Groups not in D1 (an unmigrated database): file it as given.
      if (!isMissingTable(err) || !entry.groupId) throw err;
      await insert("?", entry.groupId).run();
    }
  } catch (err) {
    log.warn({ err, action: entry.action }, "Failed to record audit entry");
  }
}

export async function getAuditLog(
  db: D1Database,
  opts: { groupId?: GroupScope; limit?: number } = {},
): Promise<AuditEntry[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  try {
    const clause = groupScopeClause(opts.groupId);
    const { results } = await db
      .prepare(
        `SELECT ${COLUMNS} FROM audit_logs${clause ? ` WHERE ${clause.sql}` : ""} ORDER BY ts DESC LIMIT ?`,
      )
      .bind(...(clause?.args ?? []), limit)
      .all<AuditRow>();
    return results.map(toEntry);
  } catch (err) {
    // Only a table not created yet means "nothing yet"; any other failure
    // must reach the caller, not pass for an empty history.
    if (!isMissingTable(err)) throw err;
    log.warn({ err }, "Failed to load audit log");
    return [];
  }
}

export async function pruneAuditLogs(db: D1Database, retentionDays: number): Promise<number> {
  const cutoff = Date.now() - retentionDays * 86400_000;
  try {
    const { meta } = await db.prepare("DELETE FROM audit_logs WHERE ts < ?").bind(cutoff).run();
    return meta.changes;
  } catch (err) {
    log.warn({ err }, "Failed to prune audit logs");
    return 0;
  }
}
