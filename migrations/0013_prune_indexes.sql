-- Every index also costs a D1 row write whenever its columns are written, so
-- only indexes whose reads would otherwise cost far more are added here:
-- delivery state changes a few times per delivery, the failure indexes are
-- written for failed sends only, and the audit index replaces another.

-- The storage-prune task (every 5 minutes) deletes delivery state by age:
-- an index on updated_at keeps it from scanning the whole table each run.
CREATE INDEX IF NOT EXISTS idx_delivery_state_updated_at ON delivery_state (updated_at);

-- The metrics page lists the latest failed sends: failures are rare, so
-- without these (partial, failures only) indexes the query walks every
-- successful row in time order before finding them.
CREATE INDEX IF NOT EXISTS idx_send_logs_failed_ts ON send_logs (ts DESC) WHERE ok = 0;
CREATE INDEX IF NOT EXISTS idx_send_logs_failed_group_ts ON send_logs (group_id, ts DESC) WHERE ok = 0;

-- A group's audit log is read newest first: (group_id, ts) serves it in order
-- (and every lookup by group_id), so the single-column index is replaced.
CREATE INDEX IF NOT EXISTS idx_audit_group_ts ON audit_logs (group_id, ts DESC);
DROP INDEX IF EXISTS idx_audit_group;
