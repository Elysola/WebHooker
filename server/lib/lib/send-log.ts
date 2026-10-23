import { log } from "./log";
import { isMissingTable } from "../storage/d1";

export interface SendRecord {
  id?: number;
  ts: number;
  routeId: string;
  groupId?: string;
  /** Immutable instance of the group (write-only: resolves `group_id` at insert time). */
  groupInstance?: string;
  event: string;
  repo?: string;
  target: string;
  ok: boolean;
  error?: string;
  status?: number;
  messageId?: string;
  deliveryId?: string;
  platform?: string;
  actor?: string;
  action?: string;
  durationMs?: number;
  errorCode?: string;
  attempts?: number;
  detail?: Record<string, unknown>;
}

const COLUMNS =
  "id, ts, route_id, group_id, event, repo, target, ok, error, status, message_id, delivery_id, platform, actor, action, duration_ms, error_code, attempts, detail";

export interface LogRow {
  id: number;
  ts: number;
  route_id: string;
  group_id: string | null;
  event: string;
  repo: string | null;
  target: string;
  ok: number;
  error: string | null;
  status: number | null;
  message_id: string | null;
  delivery_id: string | null;
  platform: string | null;
  actor: string | null;
  action: string | null;
  duration_ms: number | null;
  error_code: string | null;
  attempts: number | null;
  detail: string | null;
}

export function toRecord(r: LogRow): SendRecord {
  return {
    id: r.id,
    ts: r.ts,
    routeId: r.route_id,
    groupId: r.group_id ?? undefined,
    event: r.event,
    repo: r.repo ?? undefined,
    target: r.target,
    ok: r.ok === 1,
    error: r.error ?? undefined,
    status: r.status ?? undefined,
    messageId: r.message_id ?? undefined,
    deliveryId: r.delivery_id ?? undefined,
    platform: r.platform ?? undefined,
    actor: r.actor ?? undefined,
    action: r.action ?? undefined,
    durationMs: r.duration_ms ?? undefined,
    errorCode: r.error_code ?? undefined,
    attempts: r.attempts ?? undefined,
    detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : undefined,
  };
}

export async function recordSend(db: D1Database, record: SendRecord): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO send_logs (ts, route_id, group_id, event, repo, target, ok, error, status, message_id, delivery_id, platform, actor, action, duration_ms, error_code, attempts, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.ts,
        record.routeId,
        record.groupId ?? null,
        record.event,
        record.repo ?? null,
        record.target,
        record.ok ? 1 : 0,
        record.error ?? null,
        record.status ?? null,
        record.messageId ?? null,
        record.deliveryId ?? null,
        record.platform ?? null,
        record.actor ?? null,
        record.action ?? null,
        record.durationMs ?? null,
        record.errorCode ?? null,
        record.attempts ?? null,
        record.detail ? JSON.stringify(record.detail) : null,
      )
      .run();
  } catch (err) {
    log.warn({ err }, "Failed to record send log");
  }
}

/**
 * Rows visible to a reader: every group (undefined), one group (a string) or
 * a set of groups (an array — empty matches nothing). The condition is applied
 * in SQL, before ordering and LIMIT, so another group's rows can neither leak
 * into nor crowd out the reader's own.
 */
export type GroupScope = string | string[] | undefined;

export function groupScopeClause(scope: GroupScope): { sql: string; args: string[] } | null {
  if (scope === undefined) return null;
  const ids = typeof scope === "string" ? [scope] : scope;
  if (ids.length === 0) return { sql: "0", args: [] };
  if (ids.length === 1) return { sql: "group_id = ?", args: ids };
  // One JSON parameter, however many groups: D1 binds at most 100 per statement.
  return {
    sql: "group_id IN (SELECT value FROM json_each(?))",
    args: [JSON.stringify(ids)],
  };
}

export async function getSendLog(
  db: D1Database,
  limit = 50,
  scope?: GroupScope,
): Promise<SendRecord[]> {
  try {
    const clause = groupScopeClause(scope);
    const { results } = await db
      .prepare(
        `SELECT ${COLUMNS} FROM send_logs${clause ? ` WHERE ${clause.sql}` : ""} ORDER BY ts DESC LIMIT ?`,
      )
      .bind(...(clause?.args ?? []), limit)
      .all<LogRow>();
    return results.map(toRecord);
  } catch (err) {
    // Only a table not created yet means "nothing yet"; any other failure
    // must reach the caller, not pass for an empty history.
    if (!isMissingTable(err)) throw err;
    log.warn({ err }, "Failed to load send log");
    return [];
  }
}

export async function getSendLogById(db: D1Database, id: number): Promise<SendRecord | null> {
  try {
    const { results } = await db
      .prepare(`SELECT ${COLUMNS} FROM send_logs WHERE id = ? LIMIT 1`)
      .bind(id)
      .all<LogRow>();
    const row = results[0];
    return row ? toRecord(row) : null;
  } catch (err) {
    // Only a table not created yet means "nothing yet"; any other failure
    // must reach the caller, not pass for an empty history.
    if (!isMissingTable(err)) throw err;
    log.warn({ err, id }, "Failed to load send log entry");
    return null;
  }
}

export async function getSendLogByDelivery(
  db: D1Database,
  deliveryId: string,
): Promise<SendRecord[]> {
  try {
    const { results } = await db
      .prepare(`SELECT ${COLUMNS} FROM send_logs WHERE delivery_id = ? ORDER BY ts DESC`)
      .bind(deliveryId)
      .all<LogRow>();
    return results.map(toRecord);
  } catch (err) {
    // Only a table not created yet means "nothing yet"; any other failure
    // must reach the caller, not pass for an empty history.
    if (!isMissingTable(err)) throw err;
    log.warn({ err, deliveryId }, "Failed to load send log by delivery");
    return [];
  }
}

/** The latest failed sends within a group scope (rows map with `toRecord`). */
export function failedSendLogStatement(
  db: D1Database,
  limit = 20,
  scope?: GroupScope,
): D1PreparedStatement {
  const clause = groupScopeClause(scope);
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM send_logs WHERE ok = 0${clause ? ` AND ${clause.sql}` : ""} ORDER BY ts DESC LIMIT ?`,
    )
    .bind(...(clause?.args ?? []), limit);
}

export async function getFailedSendLog(
  db: D1Database,
  limit = 20,
  groupId?: GroupScope,
): Promise<SendRecord[]> {
  try {
    const { results } = await failedSendLogStatement(db, limit, groupId).all<LogRow>();
    return results.map(toRecord);
  } catch (err) {
    // Only a table not created yet means "nothing yet"; any other failure
    // must reach the caller, not pass for an empty history.
    if (!isMissingTable(err)) throw err;
    log.warn({ err }, "Failed to load failed send log");
    return [];
  }
}
