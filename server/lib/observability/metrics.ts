import { isMissingTable } from "../storage/d1";
import { log } from "../lib/log";
import {
  failedSendLogStatement,
  groupScopeClause,
  toRecord,
  type GroupScope,
  type LogRow,
  type SendRecord,
} from "../lib/send-log";

export interface DeliveryMetrics {
  total: number;
  ok: number;
  failed: number;
  failureRate: number;
  byPlatform: { platform: string; total: number; ok: number; failed: number }[];
  byEvent: { event: string; total: number; ok: number; failed: number }[];
  byStatus: { status: string; count: number }[];
  avgDurationMs: number;
  totalAttempts: number;
  avgAttempts: number;
  recentFailures: SendRecord[];
}

interface TotalsRow {
  total: number;
  ok: number;
  avg: number | null;
  attempts_total: number;
  attempts_avg: number | null;
}

interface BreakdownRow {
  key: string | null;
  total: number;
  ok: number;
}

interface StatusRow {
  status: number;
  count: number;
}

const EMPTY: DeliveryMetrics = {
  total: 0,
  ok: 0,
  failed: 0,
  failureRate: 0,
  byPlatform: [],
  byEvent: [],
  byStatus: [],
  avgDurationMs: 0,
  totalAttempts: 0,
  avgAttempts: 0,
  recentFailures: [],
};

export async function getDeliveryMetrics(
  db: D1Database,
  groupId?: GroupScope,
): Promise<DeliveryMetrics> {
  const clause = groupScopeClause(groupId);
  const where = clause ? ` WHERE ${clause.sql}` : "";
  const and = clause ? ` AND ${clause.sql}` : "";
  const bindGroup = (stmt: D1PreparedStatement): D1PreparedStatement =>
    clause && clause.args.length > 0 ? stmt.bind(...clause.args) : stmt;

  try {
    // One round trip for all five queries (each D1 call is a network hop), and
    // a batch runs as one transaction, so the totals and breakdowns agree.
    const results = await db.batch([
      // Totals, average duration and attempts in one scan (AVG and SUM skip
      // NULLs, as the separate filtered queries did).
      bindGroup(
        db.prepare(
          `SELECT COUNT(*) AS total, COALESCE(SUM(ok), 0) AS ok, AVG(duration_ms) AS avg,
             COALESCE(SUM(attempts), 0) AS attempts_total, AVG(attempts) AS attempts_avg
           FROM send_logs${where}`,
        ),
      ),
      bindGroup(
        db.prepare(
          `SELECT platform AS key, COUNT(*) AS total, COALESCE(SUM(ok), 0) AS ok
           FROM send_logs${where} GROUP BY platform`,
        ),
      ),
      bindGroup(
        db.prepare(
          `SELECT event AS key, COUNT(*) AS total, COALESCE(SUM(ok), 0) AS ok
           FROM send_logs${where} GROUP BY event`,
        ),
      ),
      bindGroup(
        db.prepare(
          `SELECT status, COUNT(*) AS count FROM send_logs
           WHERE status IS NOT NULL${and} GROUP BY status`,
        ),
      ),
      failedSendLogStatement(db, 20, groupId),
    ]);
    const rows = <T>(i: number): T[] => (results[i]?.results ?? []) as T[];
    const totals = rows<TotalsRow>(0);
    const byPlatform = rows<BreakdownRow>(1);
    const byEvent = rows<BreakdownRow>(2);
    const byStatus = rows<StatusRow>(3);
    const recentFailures = rows<LogRow>(4).map(toRecord);

    const total = Number(totals[0]?.total) || 0;
    const ok = Number(totals[0]?.ok) || 0;

    return {
      total,
      ok,
      failed: total - ok,
      failureRate: total > 0 ? (total - ok) / total : 0,
      byPlatform: byPlatform.map((r) => {
        const t = Number(r.total) || 0;
        const o = Number(r.ok) || 0;
        return { platform: r.key ?? "unknown", total: t, ok: o, failed: t - o };
      }),
      byEvent: byEvent.map((r) => {
        const t = Number(r.total) || 0;
        const o = Number(r.ok) || 0;
        return { event: r.key ?? "unknown", total: t, ok: o, failed: t - o };
      }),
      byStatus: byStatus.map((r) => ({
        status: String(r.status),
        count: Number(r.count) || 0,
      })),
      avgDurationMs: Number(totals[0]?.avg) || 0,
      totalAttempts: Number(totals[0]?.attempts_total) || 0,
      avgAttempts: Number(totals[0]?.attempts_avg) || 0,
      recentFailures,
    };
  } catch (err) {
    // Only a table not created yet means "nothing yet"; any other failure
    // must reach the caller, not pass for an empty history.
    if (!isMissingTable(err)) throw err;
    log.warn({ err }, "Failed to compute delivery metrics");
    return EMPTY;
  }
}
