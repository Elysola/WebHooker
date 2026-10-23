import type { FilterNode } from "./types";
import { log } from "./lib/log";
import { canUseD1 } from "./storage/d1";
import {
  ConfigConflictError,
  groupVersion,
  groupVersionBump,
  groupVersionGuard,
  runGuarded,
} from "./storage/config-store";

export interface NamedFragment {
  id: string;
  groupId?: string;
  name: string;
  node: FilterNode;
}

interface D1FragmentRow {
  id: string;
  group_id: string;
  name: string;
  node: string;
}

/**
 * Named filter fragments, optionally of one group. Without a usable D1
 * binding there are none; a D1 error propagates, because callers replace a
 * group's whole list and must never build that list from a failed read. An
 * unreadable row is skipped (logged) — or, with `strict`, an error: a write
 * replacing the group's list must never silently delete a row nobody saw.
 */
export async function loadFragments(
  db: D1Database,
  groupId?: string,
  strict = false,
): Promise<NamedFragment[]> {
  if (!canUseD1(db)) return [];
  const stmt =
    groupId === undefined
      ? db.prepare("SELECT id, group_id, name, node FROM d1_fragments ORDER BY id")
      : db
          .prepare(
            "SELECT id, group_id, name, node FROM d1_fragments WHERE group_id = ? ORDER BY id",
          )
          .bind(groupId);
  const { results } = await stmt.all<D1FragmentRow>();
  return (results ?? []).flatMap((r) => {
    try {
      return [
        {
          id: r.id,
          groupId: r.group_id || undefined,
          name: r.name,
          node: JSON.parse(r.node) as FilterNode,
        },
      ];
    } catch (err) {
      if (strict) {
        throw new Error(`filter fragment "${r.id}" is unreadable; repair the row before saving`);
      }
      log.warn({ err, id: r.id }, "Ignoring malformed filter fragment");
      return [];
    }
  });
}

/**
 * Replace one group's fragments in a single transaction; other groups are
 * untouched. `expect` sees the stored fragments first and may throw; the write
 * then commits only if nothing changed the group in between (version guard).
 */
export async function saveGroupFragments(
  db: D1Database,
  groupId: string,
  fragments: NamedFragment[],
  opts?: {
    expect?: (current: NamedFragment[]) => void | Promise<void>;
    /** Guard statements committed first in the write (see `GuardedWrite.guards`). */
    guards?: (db: D1Database) => D1PreparedStatement[];
  },
): Promise<NamedFragment[]> {
  if (!canUseD1(db)) throw new Error("Filter fragments require the D1 binding");
  const version = await groupVersion(db, groupId);
  if (version == null) throw new ConfigConflictError(`group "${groupId}" does not exist`);
  // Loaded strictly even without `expect`: an unreadable row aborts here.
  const stored = await loadFragments(db, groupId, true);
  await opts?.expect?.(stored);
  const now = Date.now();
  await runGuarded(db, [
    groupVersionGuard(db, groupId, version),
    ...(opts?.guards?.(db) ?? []),
    groupVersionBump(db, groupId),
    db.prepare("DELETE FROM d1_fragments WHERE group_id = ?").bind(groupId),
    ...fragments.map((f) =>
      db
        .prepare(
          `INSERT INTO d1_fragments (id, group_id, name, node, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(f.id, groupId, f.name, JSON.stringify(f.node), now, now),
    ),
  ]);
  return loadFragments(db, groupId);
}
