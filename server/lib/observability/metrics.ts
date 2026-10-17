import { log } from "../lib/log";
import { failedSendLogStatement, toRecord, type LogRow, type SendRecord } from "../lib/send-log";

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

interface AvgRow {
  avg: number | null;
}

interface AttemptsRow {
  total: number;
  avg: number | null;
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
  groupId?: string,
): Promise<DeliveryMetrics> {
  const where = groupId ? " WHERE group_id = ?" : "";
  const and = groupId ? " AND group_id = ?" : "";
  const bindGroup = (stmt: D1PreparedStatement): D1PreparedStatement =>
    groupId ? stmt.bind(groupId) : stmt;

  try {
    // One round trip for all seven queries (each D1 call is a network hop), and
    // a batch runs as one transaction, so the totals and breakdowns agree.
    const results = await db.batch([
      bindGroup(
        db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(ok), 0) AS ok FROM send_logs${where}`),
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
      bindGroup(
        db.prepare(
          `SELECT AVG(duration_ms) AS avg FROM send_logs WHERE duration_ms IS NOT NULL${and}`,
        ),
      ),
      bindGroup(
        db.prepare(
          `SELECT COALESCE(SUM(attempts), 0) AS total, AVG(attempts) AS avg
           FROM send_logs WHERE attempts IS NOT NULL${and}`,
        ),
      ),
      failedSendLogStatement(db, 20, groupId),
    ]);
    const rows = <T>(i: number): T[] => (results[i]?.results ?? []) as T[];
    const totals = rows<TotalsRow>(0);
    const byPlatform = rows<BreakdownRow>(1);
    const byEvent = rows<BreakdownRow>(2);
    const byStatus = rows<StatusRow>(3);
    const duration = rows<AvgRow>(4);
    const attempts = rows<AttemptsRow>(5);
    const recentFailures = rows<LogRow>(6).map(toRecord);

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
      avgDurationMs: Number(duration[0]?.avg) || 0,
      totalAttempts: Number(attempts[0]?.total) || 0,
      avgAttempts: Number(attempts[0]?.avg) || 0,
      recentFailures,
    };
  } catch (err) {
    log.warn({ err }, "Failed to compute delivery metrics");
    return EMPTY;
  }
}
