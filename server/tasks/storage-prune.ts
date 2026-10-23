import { cfEnv } from "../lib/cf";
import { log } from "../lib/lib/log";
import { PAYLOAD_TTL_SECONDS } from "../lib/queue/delivery";

const DELIVERY_STATE_RETENTION_MS = 7 * 24 * 3600 * 1000;
const MESSAGE_TRACKING_RETENTION_MS = 30 * 24 * 3600 * 1000;
/** Parked payloads older than every possible retry are orphans (R2 has no TTL). */
const PAYLOAD_RETENTION_MS = PAYLOAD_TTL_SECONDS * 1000 + 24 * 3600 * 1000;
const PAYLOAD_PRUNE_BATCH = 500;

/**
 * Delete parked queue payloads left behind in R2 (a send that failed after
 * the upload, a consumer that crashed before discarding). Keys sort by upload
 * date (`webhooks/YYYY/MM/DD/...`), so each run looks at the oldest objects
 * first and removes those past the retention window.
 */
async function prunePayloads(bucket: R2Bucket, now: number): Promise<number> {
  const listed = await bucket.list({ prefix: "webhooks/", limit: PAYLOAD_PRUNE_BATCH });
  const stale = listed.objects
    .filter((o) => o.uploaded.getTime() < now - PAYLOAD_RETENTION_MS)
    .map((o) => o.key);
  if (stale.length > 0) await bucket.delete(stale);
  return stale.length;
}

/**
 * Scheduled: purge expired rows from the D1-backed ephemeral stores
 * (dedup_keys, delivery_state, message_tracking) and orphaned R2 payloads.
 * These replaced the KV keys that relied on per-entry TTL; D1 rows and R2
 * objects must be removed by this task instead.
 */
export default defineTask({
  meta: { name: "storage:prune", description: "Prune D1 dedup/delivery/message-tracking rows" },
  async run(event) {
    try {
      const env = cfEnv(event);
      const now = Date.now();
      let removed = 0;
      const dedup = await env.DB.prepare("DELETE FROM dedup_keys WHERE expires_at < ?")
        .bind(now)
        .run();
      removed += dedup.meta?.changes ?? 0;
      const delivery = await env.DB.prepare("DELETE FROM delivery_state WHERE updated_at < ?")
        .bind(now - DELIVERY_STATE_RETENTION_MS)
        .run();
      removed += delivery.meta?.changes ?? 0;
      const messages = await env.DB.prepare("DELETE FROM message_tracking WHERE updated_at < ?")
        .bind(now - MESSAGE_TRACKING_RETENTION_MS)
        .run();
      removed += messages.meta?.changes ?? 0;
      if (env.PAYLOAD) removed += await prunePayloads(env.PAYLOAD, now);
      if (removed > 0) log.info({ removed }, "Pruned D1 storage rows");
      return { result: "ok", removed };
    } catch (err) {
      log.error({ err }, "Storage prune from cron failed");
      return { result: "error" };
    }
  },
});
