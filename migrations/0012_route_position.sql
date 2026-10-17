-- Persist the user-defined route order inside each group. Routes load ordered by
-- (group_id, position, id); rows written before this migration keep position 0
-- and therefore stay in id order until their group's routes are saved again.
ALTER TABLE d1_routes ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_d1_routes_group_position ON d1_routes (group_id, position);
