import type { SendRecord } from "./send-log";
import { log } from "./log";
import { isMissingTable } from "../storage/d1";

/**
 * Best-effort write of a dispatch's send logs, in one D1 transaction. A
 * failed write is tried once more before it is given up (and logged).
 */
/**
 * The group a log row belongs to now, found by its instance: the id it had
 * at dispatch is tried first (one primary-key lookup — the usual case); only
 * when it was renamed or deleted meanwhile are the groups scanned.
 */
const GROUP_BY_INSTANCE =
  "COALESCE((SELECT id FROM d1_groups WHERE id = ? AND json_valid(data) AND json_extract(data, '$.instance') = ?), (SELECT id FROM (SELECT id, CASE WHEN json_valid(data) THEN data ELSE '{}' END AS data FROM d1_groups) WHERE json_extract(data, '$.instance') = ?))";

export async function recordSendBatch(db: D1Database, records: SendRecord[]): Promise<void> {
  if (records.length === 0) return;
  // With the group's instance known, the row is filed under whatever id
  // that instance has at insert time: a delivery finishing after its group
  // was renamed lands under the new id, after a delete under none — never
  // under an id another group may own by then. Without groups in D1 (an
  // unmigrated database) rows are filed under the id as given.
  const write = (byInstance: boolean): Promise<unknown> =>
    db.batch(
      records.map((r) => {
        const resolve = byInstance && r.groupInstance != null;
        return db
          .prepare(
            `INSERT INTO send_logs (ts, route_id, group_id, event, repo, target, ok, error, status, message_id, delivery_id, platform, actor, action, duration_ms, error_code, attempts, detail)
             VALUES (?, ?, ${resolve ? GROUP_BY_INSTANCE : "?"}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            r.ts,
            r.routeId,
            ...(resolve
              ? [r.groupId ?? "", r.groupInstance, r.groupInstance]
              : [r.groupId ?? null]),
            r.event,
            r.repo ?? null,
            r.target,
            r.ok ? 1 : 0,
            r.error ?? null,
            r.status ?? null,
            r.messageId ?? null,
            r.deliveryId ?? null,
            r.platform ?? null,
            r.actor ?? null,
            r.action ?? null,
            r.durationMs ?? null,
            r.errorCode ?? null,
            r.attempts ?? null,
            r.detail ? JSON.stringify(r.detail) : null,
          );
      }),
    );
  let byInstance = true;
  for (let attempt = 1; ; attempt++) {
    try {
      await write(byInstance);
      return;
    } catch (err) {
      if (byInstance && isMissingTable(err) && /d1_groups/.test(String(err))) {
        byInstance = false;
        continue;
      }
      if (attempt >= 2 || isMissingTable(err)) {
        log.warn({ err, count: records.length }, "Failed to record send log batch");
        return;
      }
    }
  }
}
