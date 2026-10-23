import type { Filter, Group, Route } from "../types";
import { log } from "../lib/log";
import * as v from "valibot";
import { filterNodeSchema, filterSchema, migrateGroups, migrateRoutes } from "../config/schema";
import { filterNodeWellFormed, filterPatternsUsable } from "../events/filter-ast";
import { canUseD1, isMissingTable, noteKvFallback } from "./d1";
import { sharedFlight, type Flight } from "../lib/shared-flight";

export interface LoadOptions {
  /**
   * Read the authoritative store directly, skipping every cache. Write paths
   * (read-modify-write) and access checks use it so they never act on a
   * snapshot another isolate has already changed.
   */
  fresh?: boolean;
}

/** A conditional write lost against a concurrent change; the caller reloads. */
export class ConfigConflictError extends Error {
  constructor(message = "Configuration changed concurrently") {
    super(message);
    this.name = "ConfigConflictError";
  }
}

/** Builds the replacement of a group (null: keep it); may throw to abort. */
export type GroupMutation = (group: Group) => Group | null | Promise<Group | null>;

/** A precondition on the stored value, checked before a write that then commits atomically. */
/** Extra statements committed in a group's rename/delete transaction. */
export type LifecycleStatements = (db: D1Database) => D1PreparedStatement[];

export interface GuardedWrite<T> {
  expect?: (current: T) => void | Promise<void>;
  /**
   * Guard statements run first in the write's own transaction (D1): one that
   * raises aborts the write (ConfigConflictError). Checks that must hold at
   * commit time, across groups, go here. Ignored by the KV-only store.
   */
  guards?: LifecycleStatements;
  /**
   * Statements committed after the write, in the same transaction (D1): a
   * record that must exist exactly when the write does. In the first of them
   * SQLite's `changes()` tells whether the write changed its row (a lost
   * compare-and-swap does not; it is retried). Ignored by KV.
   */
  after?: LifecycleStatements;
  /**
   * Route lists only: replace the group's routes even though some stored rows
   * cannot be read — the caller's explicit repair of a group whose unreadable
   * rows would otherwise block every save. Off by default.
   */
  discardUnreadable?: boolean;
}

/**
 * A statement that aborts its batch (D1 batches are transactions) unless the
 * group row still has `version`: it raises a JSON error otherwise. Writers that
 * guard on the version and bump it serialize against each other.
 */
export function groupVersionGuard(
  db: D1Database,
  id: string,
  version: number,
): D1PreparedStatement {
  return db
    .prepare(
      "SELECT CASE WHEN (SELECT version FROM d1_groups WHERE id = ?) = ? THEN 1 ELSE json('version conflict') END AS ok",
    )
    .bind(id, version);
}

export function groupVersionBump(db: D1Database, id: string): D1PreparedStatement {
  return db.prepare("UPDATE d1_groups SET version = version + 1 WHERE id = ?").bind(id);
}

/** Marker row (in `dedup_keys`) of a group id recently deleted or renamed away. */
/** KV marker of the one-time identity migration (KV-only deployments). */
const KV_IDENTITY_MARKER = "config:identity-migrated";

/** D1 marker row (in `dedup_keys`) of the one-time identity migration. */
const IDENTITY_MARKER_ROW = "config:identity-v1";

/** D1 marker row (in `dedup_keys`) committed with the one-time KV seed. */
const SEED_MARKER_ROW = "config:d1-seeded";

export function retiredGroupKey(id: string): string {
  return `group-retired:${id}`;
}

/** Aborts its batch (like a version guard) while the id is retired. */
function notRetiredGuard(db: D1Database, id: string): D1PreparedStatement {
  return db
    .prepare(
      "SELECT CASE WHEN EXISTS (SELECT 1 FROM dedup_keys WHERE key = ? AND expires_at > ?) THEN json('id retired') ELSE 1 END AS ok",
    )
    .bind(retiredGroupKey(id), Date.now());
}

/** Run a guarded batch, turning a failed guard into a ConfigConflictError. */
export async function runGuarded(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<D1Result[]> {
  try {
    return await db.batch(statements);
  } catch (err) {
    if (/malformed JSON/i.test(String(err))) throw new ConfigConflictError();
    throw err;
  }
}

/** The stored version of a group row, or null when the group does not exist. */
export async function groupVersion(db: D1Database, id: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT version FROM d1_groups WHERE id = ?")
    .bind(id)
    .first<{ version: number }>();
  return row ? row.version : null;
}

/** Routes and groups of one moment, plus the groups with an unreadable route row. */
export interface ConfigSnapshot {
  routes: Route[];
  groups: Group[];
  unreadable?: string[];
}

export interface ConfigStore {
  readonly kind: "d1" | "kv";
  loadRoutes(opts?: LoadOptions): Promise<Route[]>;
  /** Routes and groups of one consistent moment (use it whenever both are needed). */
  loadSnapshot(opts?: LoadOptions): Promise<ConfigSnapshot>;
  /**
   * Replace the full route set. Only groups whose route list actually differs
   * are rewritten, so a stale snapshot of one group never touches another.
   */
  saveRoutes(routes: Route[]): Promise<void>;
  /**
   * Replace one group's routes (in the given order); other groups are
   * untouched. `expect` sees the stored routes first and may throw (e.g. a
   * ConfigConflictError for a stale revision); the write then only commits if
   * nothing changed the group in between. Resolves to the stored routes.
   */
  saveGroupRoutes(groupId: string, routes: Route[], opts?: GuardedWrite<Route[]>): Promise<Route[]>;
  loadGroups(opts?: LoadOptions): Promise<Group[]>;
  /**
   * One group, read fresh from the store — its row alone, not the whole
   * configuration (a request that may still be refused reads no more).
   * `unreadable`: the row exists but cannot be used.
   */
  loadGroup(id: string): Promise<{ group: Group | null; unreadable: boolean }>;
  /**
   * Replace the full group set: groups missing from `groups` are deleted with
   * their routes and fragments, changed groups are upserted, unchanged ones are
   * left alone.
   */
  saveGroups(groups: Group[]): Promise<void>;
  /**
   * Insert a group unless one with its id exists (or, with D1, the id is
   * retired); true when it was created.
   */
  createGroup(group: Group): Promise<boolean>;
  /**
   * Atomically read-modify-write one group (compare-and-swap on its stored
   * version, retried on contention). `mutate` returns the new group, or null to
   * leave it unchanged. Resolves to the stored group, or null when it does not
   * exist. Throws ConfigConflictError when contention never settles.
   */
  updateGroup(
    id: string,
    mutate: GroupMutation,
    opts?: Pick<GuardedWrite<Group>, "guards" | "after">,
  ): Promise<Group | null>;
  /**
   * Delete a group together with its routes and filter fragments; `extra`
   * statements (history, id retirement) commit in the same transaction, which
   * fails if the group changed after `expect` checked it.
   */
  deleteGroup(
    id: string,
    opts?: GuardedWrite<Group> & { extra?: LifecycleStatements; version?: number },
  ): Promise<void>;
  /**
   * Move a group, its routes and its fragments to a new id in one transaction
   * (with `extra` statements), failing if the group changed after `expect`
   * checked it. Resolves to the renamed group.
   */
  renameGroup(
    from: string,
    to: string,
    opts?: GuardedWrite<Group> & { extra?: LifecycleStatements; transform?: (g: Group) => Group },
  ): Promise<Group>;
  invalidateCache(): void;
}

interface D1GroupRow {
  id: string;
  name: string;
  data: string;
  version: number;
}

interface D1RouteRow {
  id: string;
  group_id: string;
  name: string;
  enabled: number;
  filters: string;
  targets: string;
  stop: number;
  fallback: number;
  discord_role_ids: string | null;
  ast: string | null;
}

const CACHE_TTL = 60_000;

/**
 * Shape checks of route rows already judged, by their stored content: every
 * fresh snapshot judges every row, and compiling each pattern again (more
 * than the shared pattern cache holds, it would be every time) spends CPU on
 * rows that have not changed. Bounded; a changed row has new content.
 */
const rowChecks = new Map<string, boolean>();
const MAX_ROW_CHECKS = 5000;
/** Legacy KV keys: the pre-D1 source of truth, read once to seed D1. */
const KV_ROUTES_KEY = "config:routes";
const KV_GROUPS_KEY = "config:groups";
/** Read-only degrade copy, used only while D1 reads fail. */
/** Set once D1 holds (or has been seeded with) the configuration. */
const KV_SEEDED_KEY = "config:d1-seeded";
/** Group created for legacy routes that never belonged to one. */
export const UNGROUPED_ID = "ungrouped";
const UPDATE_ATTEMPTS = 5;

function parseJson<T>(value: string, label: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    log.warn({ err, label }, "Ignoring malformed configuration row");
    return null;
  }
}

/** Stored form of a group: the id is the row key, `revision` is never persisted. */
/**
 * The webhook secret a group write keeps: one the mutation set, none when it
 * cleared it (`null`), else the stored one — a client's edit never carries it.
 */
function keptSecret(next: Group, prev: Group): string | undefined {
  // Removed: kept as "" — an explicit "none", so no older KV copy of the
  // secret is ever read again (absent would mean "never set here").
  if (next.webhookSecret === null) return "";
  return next.webhookSecret ?? prev.webhookSecret ?? undefined;
}

/**
 * The fields dispatch and access checks rely on have the shape they assume
 * (a field of the wrong type would make them throw for every event). A row
 * failing this counts as unreadable — isolated to its group.
 */
function groupShapeOk(g: Group): boolean {
  const strings = (x: unknown): boolean =>
    x === undefined || (Array.isArray(x) && x.every((s) => typeof s === "string"));
  const objects = (x: unknown): boolean =>
    x === undefined || (Array.isArray(x) && x.every((o) => !!o && typeof o === "object"));
  return (
    strings(g.providers) &&
    strings(g.owners) &&
    strings(g.adminIds) &&
    objects(g.members) &&
    objects(g.forgeSources) &&
    (g.logTarget == null || (typeof g.logTarget === "object" && !Array.isArray(g.logTarget))) &&
    (g.installationId == null || typeof g.installationId === "number") &&
    (g.isolated === undefined || typeof g.isolated === "boolean") &&
    (g.instance === undefined || typeof g.instance === "string") &&
    (g.legacyId === undefined || typeof g.legacyId === "string")
  );
}

/** A fresh immutable group instance id. */
function newInstanceId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * Instance of a group backfilled in KV-only mode: derived from its id, so
 * concurrent cold starts racing on the read-modify-write of `config:groups`
 * all arrive at the same value (KV has no conditional write). Only legacy
 * groups without an instance get one; new groups always get a random id.
 */
async function backfilledInstanceId(id: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`webhooker:legacy-instance:${id}`),
  );
  return [...new Uint8Array(digest).slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function storedGroup(group: Group): Group {
  const { revision: _revision, ...rest } = group as Group & { revision?: unknown };
  return rest as Group;
}

/** JSON with object keys sorted, so equal data compares equal whatever the key order. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

function sameJson(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

/** The columns a route is stored as, for change detection. */
function storedRoute(r: Route): unknown {
  return {
    id: r.id,
    name: r.name,
    enabled: !!r.enabled,
    filters: r.filters ?? [],
    targets: r.targets ?? [],
    stop: !!r.stop,
    fallback: !!r.fallback,
    discordRoleIds: r.discordRoleIds ?? null,
    ast: r.ast ?? null,
  };
}

function routesByGroup(routes: Route[]): Map<string, Route[]> {
  const out = new Map<string, Route[]>();
  for (const r of routes) {
    const gid = r.groupId ?? "";
    const list = out.get(gid);
    if (list) list.push(r);
    else out.set(gid, [r]);
  }
  return out;
}

export function d1ConfigStore(db: D1Database, kv: KVNamespace): ConfigStore {
  /**
   * Routes and groups are cached as one snapshot read in one transaction, so a
   * dispatch never combines routes of one moment with groups of another (e.g.
   * a renamed group's old routes with its new id).
   */
  let snapshot: (ConfigSnapshot & { expiresAt: number }) | null = null;
  let seeded = false;
  let instancesChecked = false;

  /**
   * Run a statement that uses the `position` column (migration 0012) and fall
   * back to its legacy form only when the database confirms the column is
   * missing. Any other error propagates, and nothing is remembered, so a
   * database migrated later is picked up on the next call.
   */
  async function withPosition<T>(run: (positioned: boolean) => Promise<T>): Promise<T> {
    try {
      return await run(true);
    } catch (err) {
      // SQLite says "no such column: position" for reads and "has no column
      // named position" for inserts.
      if (!/no such column: position|no column named position/i.test(String(err))) throw err;
      return run(false);
    }
  }

  function rowToRoute(r: D1RouteRow): Route | null {
    const filters = parseJson<Route["filters"]>(r.filters, `route:${r.id}:filters`);
    const targets = parseJson<Route["targets"]>(r.targets, `route:${r.id}:targets`);
    const discordRoleIds = r.discord_role_ids
      ? parseJson<Route["discordRoleIds"]>(r.discord_role_ids, `route:${r.id}:discord_role_ids`)
      : undefined;
    const ast = r.ast ? parseJson<Route["ast"]>(r.ast, `route:${r.id}:ast`) : undefined;
    if (!filters || !targets || (r.discord_role_ids && !discordRoleIds) || (r.ast && !ast)) {
      return null;
    }
    // Parsable is not enough: a field of the wrong shape would make the
    // matcher throw, i.e. the route silently never match. Such a row counts
    // as unreadable (the group's deliveries then fail visibly and retry).
    const isObject = (x: unknown): boolean => !!x && typeof x === "object" && !Array.isArray(x);
    const check = (): boolean =>
      Array.isArray(filters) &&
      filters.every(
        (f) => isObject(f) && !("all" in f || "any" in f || "not" in f) && v.is(filterSchema, f),
      ) &&
      Array.isArray(targets) &&
      targets.every(isObject) &&
      (discordRoleIds == null ||
        (Array.isArray(discordRoleIds) && discordRoleIds.every((d) => typeof d === "string"))) &&
      (ast == null || (filterNodeWellFormed(ast) && v.is(filterNodeSchema, ast))) &&
      // Patterns the matcher cannot run would silently never match — checked
      // on what it evaluates: the AST when there is one, else the flat list.
      (ast != null
        ? filterPatternsUsable(ast)
        : filters.every((f) => filterPatternsUsable(f as Filter)));
    // Whatever a row holds, judging it never throws: one bad row is one
    // unreadable route, never a failed configuration snapshot.
    const checkKey = JSON.stringify([r.filters, r.targets, r.discord_role_ids, r.ast]);
    let shapeOk = rowChecks.get(checkKey);
    if (shapeOk === undefined) {
      try {
        shapeOk = check();
      } catch {
        shapeOk = false;
      }
      if (rowChecks.size >= MAX_ROW_CHECKS) rowChecks.clear();
      rowChecks.set(checkKey, shapeOk);
    }
    if (!shapeOk) {
      log.warn({ routeId: r.id, groupId: r.group_id }, "Ignoring malformed route row");
      return null;
    }
    return {
      id: r.id,
      groupId: r.group_id,
      name: r.name,
      enabled: r.enabled === 1,
      filters,
      targets,
      stop: r.stop === 1,
      fallback: r.fallback === 1,
      discordRoleIds: discordRoleIds ?? undefined,
      ast: ast ?? undefined,
    };
  }

  /**
   * Routes in stored order. An unreadable row is skipped (logged) for reads;
   * with `strict` it is an error instead — a write that replaces the group's
   * routes must never silently delete a row nobody could see.
   */
  async function loadRoutesFromD1(groupId?: string, strict = false): Promise<Route[]> {
    const results = await withPosition(async (positioned) => {
      const order = positioned ? "group_id, position, id" : "group_id, id";
      const where = groupId === undefined ? "" : " WHERE group_id = ?";
      const stmt = db.prepare(
        `SELECT id, group_id, name, enabled, filters, targets, stop, fallback, discord_role_ids, ast FROM d1_routes${where} ORDER BY ${order}`,
      );
      return (await (groupId === undefined ? stmt : stmt.bind(groupId)).all<D1RouteRow>()).results;
    });
    return (results ?? []).flatMap((r) => {
      const route = rowToRoute(r);
      if (!route && strict) {
        throw new Error(
          `route "${r.id}" of group "${r.group_id}" is unreadable; repair the row before saving`,
        );
      }
      return route ? [route] : [];
    });
  }

  async function loadGroupRowsFromD1(): Promise<D1GroupRow[]> {
    const { results } = await db
      .prepare("SELECT id, name, data, version FROM d1_groups ORDER BY id")
      .all<D1GroupRow>();
    return results ?? [];
  }

  function rowToGroup(r: D1GroupRow): Group | null {
    const group = parseJson<Group>(r.data, `group:${r.id}`);
    if (group !== null && (typeof group !== "object" || Array.isArray(group))) return null;
    if (group !== null && !groupShapeOk(group)) {
      log.warn({ groupId: r.id }, "Ignoring malformed group row");
      return null;
    }
    // The row key is authoritative: a stale `id` inside the JSON never wins.
    return group ? { ...group, id: r.id } : null;
  }

  async function loadGroupsFromD1(): Promise<Group[]> {
    return (await loadGroupRowsFromD1()).flatMap((r) => {
      const g = rowToGroup(r);
      return g ? [g] : [];
    });
  }

  /** Groups and routes from one D1 batch (one transaction: a consistent pair). */
  async function loadSnapshotFromD1(): Promise<ConfigSnapshot> {
    const [groupRows, routeRows] = await withPosition(async (positioned) => {
      const order = positioned ? "group_id, position, id" : "group_id, id";
      const results = await db.batch([
        db.prepare("SELECT id, name, data, version FROM d1_groups ORDER BY id"),
        db.prepare(
          `SELECT id, group_id, name, enabled, filters, targets, stop, fallback, discord_role_ids, ast FROM d1_routes ORDER BY ${order}`,
        ),
      ]);
      return [
        (results[0]?.results ?? []) as D1GroupRow[],
        (results[1]?.results ?? []) as D1RouteRow[],
      ] as const;
    });
    const unreadable = new Set<string>();
    return {
      groups: groupRows.flatMap((r) => {
        const g = rowToGroup(r);
        // A group row nobody can read is not a deleted group: its routes
        // must fail visibly, not be skipped as routes of a missing group.
        if (!g && routeRows.some((route) => route.group_id === r.id)) unreadable.add(r.id);
        return g ? [g] : [];
      }),
      routes: routeRows.flatMap((r) => {
        const route = rowToRoute(r);
        if (!route) unreadable.add(r.group_id);
        return route ? [route] : [];
      }),
      unreadable: [...unreadable],
    };
  }

  /**
   * A configuration list from KV: the list, `null` when the key is absent.
   * Read errors propagate — a failed read must never pass for "no data".
   */
  async function readKvList<T>(key: string): Promise<T[] | null> {
    const raw = await kv.get<T[]>(key, "json");
    if (raw == null) return null;
    if (!Array.isArray(raw)) throw new Error(`KV key ${key} does not hold a list`);
    return raw;
  }

  function routeInsert(
    r: Route,
    groupId: string,
    position: number,
    positioned: boolean,
  ): D1PreparedStatement {
    const now = Date.now();
    const values = [
      r.id,
      groupId,
      r.name,
      r.enabled ? 1 : 0,
      JSON.stringify(r.filters ?? []),
      JSON.stringify(r.targets ?? []),
      r.stop ? 1 : 0,
      r.fallback ? 1 : 0,
      r.discordRoleIds ? JSON.stringify(r.discordRoleIds) : null,
      r.ast ? JSON.stringify(r.ast) : null,
    ];
    if (positioned) {
      return db
        .prepare(
          `INSERT INTO d1_routes (id, group_id, name, enabled, filters, targets, stop, fallback, discord_role_ids, ast, position, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(...values, position, now, now);
    }
    return db
      .prepare(
        `INSERT INTO d1_routes (id, group_id, name, enabled, filters, targets, stop, fallback, discord_role_ids, ast, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(...values, now, now);
  }

  /** Statements replacing one group's routes, in order. */
  function replaceGroupStatements(
    groupId: string,
    routes: Route[],
    positioned: boolean,
  ): D1PreparedStatement[] {
    return [
      db.prepare("DELETE FROM d1_routes WHERE group_id = ?").bind(groupId),
      ...routes.map((r, i) => routeInsert(r, groupId, i, positioned)),
    ];
  }

  function groupUpsert(g: Group): D1PreparedStatement {
    const now = Date.now();
    const stored = storedGroup(g);
    return db
      .prepare(
        `INSERT INTO d1_groups (id, name, data, version, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           data = excluded.data,
           version = d1_groups.version + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(stored.id, stored.name, JSON.stringify(stored), now, now);
  }

  function groupDeleteStatements(id: string): D1PreparedStatement[] {
    return [
      db.prepare("DELETE FROM d1_routes WHERE group_id = ?").bind(id),
      db.prepare("DELETE FROM d1_fragments WHERE group_id = ?").bind(id),
      db.prepare("DELETE FROM d1_groups WHERE id = ?").bind(id),
    ];
  }

  /**
   * Seed D1 once from the legacy KV configuration. It runs only while both
   * tables are empty and no seed has happened before (a KV marker), never
   * overwrites a row, and is awaited — so a configuration that was emptied on
   * purpose stays empty instead of being resurrected from an old copy.
   */
  /** Commit the seed together with its D1 marker; false when another isolate seeded first. */
  async function runSeed(statements: D1PreparedStatement[]): Promise<boolean> {
    const marker = db
      .prepare("INSERT INTO dedup_keys (key, claimed_at, expires_at) VALUES (?, ?, ?)")
      .bind(SEED_MARKER_ROW, Date.now(), Number.MAX_SAFE_INTEGER);
    try {
      await db.batch([marker, ...statements]);
      return true;
    } catch (err) {
      if (/UNIQUE constraint failed: dedup_keys/i.test(String(err))) return false;
      // No marker table yet (an unmigrated database): seed without it.
      if (!isMissingTable(err) || !/dedup_keys/.test(String(err))) throw err;
      await db.batch(statements);
      return true;
    }
  }

  async function ensureSeeded(): Promise<void> {
    if (seeded) return;
    if (await kv.get(KV_SEEDED_KEY)) {
      seeded = true;
      return;
    }
    const counts = await db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM d1_groups) AS groups, (SELECT COUNT(*) FROM d1_routes) AS routes",
      )
      .first<{ groups: number; routes: number }>();
    if ((counts?.groups ?? 0) === 0 && (counts?.routes ?? 0) === 0) {
      // Strict reads: a KV failure aborts the seed (and leaves no marker), so
      // a transient error can never seed a partial configuration for good.
      // Identity fields in a legacy list came from clients (the old API stored
      // whatever it was sent): dropped, the backfill assigns real ones. A list
      // this server already manages (KV-only deployment, migrated) keeps them.
      const managed = (await kv.get(KV_IDENTITY_MARKER)) != null;
      const groups = migrateGroups((await readKvList<Group>(KV_GROUPS_KEY)) ?? []).map((g) => {
        if (managed) return g;
        const { instance: _i, instanceBackfilled: _b, legacyId: _l, ...rest } = g;
        return rest as Group;
      });
      const routes = migrateRoutes((await readKvList<Route>(KV_ROUTES_KEY)) ?? []);
      if (groups.length > 0 || routes.length > 0) {
        const known = new Set(groups.map((g) => g.id));
        // Routes without a group go to a group of their own, under an id no
        // existing group (nor route) uses: never into a tenant's group that
        // happens to be called "ungrouped".
        const referenced = new Set(routes.map((r) => r.groupId).filter(Boolean));
        let ungroupedId = UNGROUPED_ID;
        for (let n = 2; known.has(ungroupedId) || referenced.has(ungroupedId); n++) {
          ungroupedId = `${UNGROUPED_ID}-${n}`;
        }
        const placeholders: Group[] = [];
        for (const r of routes) {
          const gid = r.groupId || ungroupedId;
          if (!known.has(gid)) {
            known.add(gid);
            // Routes without a group were global before groups existed: their
            // placeholder stays open. A route naming a group that is gone is
            // a leftover — kept for review, but isolated (no source bound, so
            // it takes no events) instead of reopened to every source.
            // It gets a fresh instance right away (no `legacyId`): it is not
            // the group that once had the id, so that group's secret, invites
            // and queued deliveries never apply to it.
            // The group for routes that had none gets its identity now too:
            // nothing of a former group applies to it, and its empty
            // `legacyId` lets those routes adopt their chains, which were
            // tracked without a group prefix.
            placeholders.push(
              r.groupId
                ? { id: gid, name: gid, adminIds: [], isolated: true, instance: newInstanceId() }
                : { id: gid, name: gid, adminIds: [], instance: newInstanceId(), legacyId: "" },
            );
            if (r.groupId) {
              log.warn({ groupId: gid }, "Seeded routes of a missing group as an isolated group");
            }
          }
        }
        const now = Date.now();
        const statements = [...groups, ...placeholders].map((g) =>
          db
            .prepare(
              `INSERT INTO d1_groups (id, name, data, version, created_at, updated_at)
               VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(id) DO NOTHING`,
            )
            .bind(g.id, g.name, JSON.stringify(storedGroup(g)), now, now),
        );
        await withPosition(async (positioned) => {
          const routeStatements: D1PreparedStatement[] = [];
          for (const [gid, list] of routesByGroup(routes)) {
            // A legacy list may repeat an id; the first copy wins, as it did
            // when the KV list was the source of truth.
            const seen = new Set<string>();
            list
              .filter((r) => !seen.has(r.id) && seen.add(r.id))
              .forEach((r, i) =>
                routeStatements.push(routeInsert(r, gid || ungroupedId, i, positioned)),
              );
          }
          // Plain INSERTs: a conflicting row means D1 already holds data, and
          // the whole seed transaction is abandoned rather than merged. The
          // marker row commits with the seed: an isolate that read the empty
          // tables too and arrives late (perhaps after an admin deleted the
          // seeded groups) conflicts on it and never re-seeds.
          await runSeed([...statements, ...routeStatements]);
        });
        log.info(
          { groups: groups.length, routes: routes.length },
          "Seeded D1 configuration from KV",
        );
        // A deployment moving from KV to D1 also left delivery state, message
        // tracking and claims in KV, written before the fallback marker
        // existed: marked now, so D1 reads still consult them while they live.
        await noteKvFallback(kv);
      }
    }
    await kv.put(KV_SEEDED_KEY, "1");
    seeded = true;
  }

  /**
   * Give every group an immutable `instance` id (once per isolate; a no-op
   * once all groups have one). Renames keep it, a re-created id gets a new
   * one: invites and delivery ledgers bound to it never cross to another group.
   */
  async function ensureInstances(): Promise<void> {
    if (instancesChecked) return;
    // A backfilled group also records the id it has right now: pre-instance
    // state stored under that id belongs to it, whatever its id later becomes.
    await db.batch([
      // Malformed rows are skipped (CASE keeps JSON functions off them): they
      // are isolated by the snapshot as unreadable, never fail this setup.
      db.prepare(
        `UPDATE d1_groups SET data = json_set(data, '$.instance', lower(hex(randomblob(16))),
             '$.instanceBackfilled', json('true'), '$.legacyId', id),
           version = version + 1
         WHERE CASE WHEN json_valid(data) THEN json_extract(data, '$.instance') IS NULL ELSE 0 END`,
      ),
      // Backfilled before `legacyId` existed (and not renamed since).
      db.prepare(
        `UPDATE d1_groups SET data = json_set(data, '$.legacyId', id), version = version + 1
         WHERE CASE WHEN json_valid(data)
           THEN json_extract(data, '$.instanceBackfilled') = 1
             AND json_extract(data, '$.legacyId') IS NULL
           ELSE 0 END`,
      ),
    ]);
    instancesChecked = true;
  }

  /**
   * Once per database: identity fields that were stored before this server
   * assigned them came from clients (the old groups API kept any field it was
   * sent), so none of them is trusted. Every group then existing is a
   * pre-instance group: its `legacyId` becomes its own id, and an instance it
   * shares with another group is replaced. Committed with its marker row.
   */
  async function migrateIdentities(): Promise<void> {
    // No stored instance is kept: a client-chosen one could have been picked
    // to equal the one another group is about to receive.
    const rewrite = (): D1PreparedStatement[] => [
      db.prepare(
        `UPDATE d1_groups SET data = json_set(data, '$.instance', lower(hex(randomblob(16))),
           '$.instanceBackfilled', json('true'), '$.legacyId', id), version = version + 1
         WHERE json_valid(data)`,
      ),
    ];
    try {
      const done = await db
        .prepare("SELECT 1 AS hit FROM dedup_keys WHERE key = ?")
        .bind(IDENTITY_MARKER_ROW)
        .first<{ hit: number }>();
      if (done) return;
      // Identities already managed by this server (a KV-only deployment, or
      // a migration done while the marker table was missing): only the marker
      // is recorded — rewriting them would cut groups off their secrets,
      // invites and queued deliveries.
      const managed = (await kv.get(KV_IDENTITY_MARKER)) != null;
      // The marker goes first, as a plain INSERT: of two isolates racing,
      // the second conflicts on it and its whole batch rolls back — a stale
      // run can never rewrite groups created after the migration.
      await db.batch([
        db
          .prepare("INSERT INTO dedup_keys (key, claimed_at, expires_at) VALUES (?, ?, ?)")
          .bind(IDENTITY_MARKER_ROW, Date.now(), Number.MAX_SAFE_INTEGER),
        ...(managed ? [] : rewrite()),
      ]);
    } catch (err) {
      // Another isolate migrated first (its marker stands): nothing to do.
      if (/UNIQUE constraint failed: dedup_keys/i.test(String(err))) return;
      if (!isMissingTable(err)) throw err;
      // No marker table: the database misses migrations. Identities can be
      // neither trusted unmigrated nor migrated safely (only once, atomically)
      // — so nothing is served until the migrations are applied.
      throw new Error(
        "D1 migrations are incomplete (table dedup_keys is missing): apply them before serving",
      );
    }
  }

  const readying = new Map<"setup", Flight<void>>();
  function ensureReady(): Promise<void> {
    if (seeded && instancesChecked) return Promise.resolve();
    // Requests arriving together at a cold isolate share one setup (its KV
    // read, marker query and updates) instead of each running its own; a
    // failed setup is cleared, so the next request tries again. Each step is
    // safe to run twice, so a request that stops waiting for another's setup
    // (see `sharedFlight`) can run its own.
    return sharedFlight(
      readying,
      "setup",
      async () => {
        // Identities first: the seed below inserts groups with server-made
        // identities only, which the migration must not touch.
        if (!instancesChecked) await migrateIdentities();
        await ensureSeeded();
        await ensureInstances();
      },
      15_000,
    );
  }

  function invalidate(): void {
    snapshot = null;
  }

  async function afterWrite(): Promise<void> {
    invalidate();
  }

  /**
   * The configuration snapshot. D1 read failures propagate — there is no
   * stale fallback copy that could resurrect revoked restrictions or targets;
   * callers fail and retry instead.
   */
  async function snapshotFor(opts?: LoadOptions): Promise<ConfigSnapshot> {
    if (!opts?.fresh && snapshot && Date.now() < snapshot.expiresAt) return snapshot;
    await ensureReady();
    const fresh = await loadSnapshotFromD1();
    snapshot = { ...fresh, expiresAt: Date.now() + CACHE_TTL };
    return fresh;
  }

  const store: ConfigStore = {
    kind: "d1",

    async loadRoutes(opts?: LoadOptions): Promise<Route[]> {
      return (await snapshotFor(opts)).routes;
    },

    async loadSnapshot(opts?: LoadOptions): Promise<ConfigSnapshot> {
      const { routes, groups, unreadable } = await snapshotFor(opts);
      return { routes, groups, unreadable };
    },

    async saveRoutes(routes: Route[]): Promise<void> {
      await ensureReady();
      // Versions first, routes second: a group changed in between fails its guard.
      const { results: versionRows } = await db
        .prepare("SELECT id, version FROM d1_groups")
        .all<{ id: string; version: number }>();
      const versions = new Map<string, number>((versionRows ?? []).map((r) => [r.id, r.version]));
      const current = routesByGroup(await loadRoutesFromD1());
      const next = routesByGroup(routes);
      const changed = new Set<string>();
      for (const gid of new Set([...current.keys(), ...next.keys()])) {
        const before = (current.get(gid) ?? []).map(storedRoute);
        const after = (next.get(gid) ?? []).map(storedRoute);
        if (!sameJson(before, after)) changed.add(gid);
      }
      // A group about to be rewritten must have no unreadable row to lose.
      for (const gid of changed) await loadRoutesFromD1(gid, true);
      if (changed.size > 0) {
        await withPosition((positioned) =>
          runGuarded(
            db,
            [...changed].flatMap((gid) => {
              const version = versions.get(gid);
              const guard =
                version == null
                  ? []
                  : [groupVersionGuard(db, gid, version), groupVersionBump(db, gid)];
              return [...guard, ...replaceGroupStatements(gid, next.get(gid) ?? [], positioned)];
            }),
          ),
        );
      }
      await afterWrite();
    },

    async saveGroupRoutes(
      groupId: string,
      routes: Route[],
      opts?: GuardedWrite<Route[]>,
    ): Promise<Route[]> {
      await ensureReady();
      // Version first, routes second: any route write in between bumps the
      // version, so the guard below refuses rather than overwrite it.
      const version = await groupVersion(db, groupId);
      if (version == null) throw new Error(`group "${groupId}" does not exist`);
      // Loaded strictly even without `expect`: an unreadable row aborts here
      // (unless the caller explicitly discards such rows).
      const stored = await loadRoutesFromD1(groupId, !opts?.discardUnreadable);
      await opts?.expect?.(stored);
      await withPosition((positioned) =>
        runGuarded(db, [
          groupVersionGuard(db, groupId, version),
          ...(opts?.guards?.(db) ?? []),
          groupVersionBump(db, groupId),
          ...replaceGroupStatements(
            groupId,
            routes.map((r) => ({ ...r, groupId })),
            positioned,
          ),
        ]),
      );
      await afterWrite();
      return loadRoutesFromD1(groupId);
    },

    async loadGroups(opts?: LoadOptions): Promise<Group[]> {
      // Fresh: the groups table alone (access checks need no routes) — a
      // full snapshot would read every route along on each admin request.
      if (opts?.fresh) {
        await ensureReady();
        return loadGroupsFromD1();
      }
      return (await snapshotFor(opts)).groups;
    },

    async loadGroup(id: string): Promise<{ group: Group | null; unreadable: boolean }> {
      await ensureReady();
      const row = await db
        .prepare(
          "SELECT id, name, CASE WHEN json_valid(data) THEN data ELSE '' END AS data, version FROM d1_groups WHERE id = ?",
        )
        .bind(id)
        .first<D1GroupRow>();
      if (!row) return { group: null, unreadable: false };
      const group = rowToGroup(row);
      return { group, unreadable: group === null };
    },

    async saveGroups(groups: Group[]): Promise<void> {
      await ensureReady();
      const current = new Map((await loadGroupsFromD1()).map((g) => [g.id, g]));
      const nextIds = new Set(groups.map((g) => g.id));
      const statements: D1PreparedStatement[] = [];
      for (const id of current.keys()) {
        if (!nextIds.has(id)) statements.push(...groupDeleteStatements(id));
      }
      for (const g of groups) {
        const prev = current.get(g.id);
        // The instance id is server-owned: kept for existing groups, new otherwise.
        const next = {
          ...g,
          instance: prev?.instance ?? newInstanceId(),
          instanceBackfilled: prev?.instanceBackfilled,
          legacyId: prev?.legacyId,
          webhookSecret: prev?.webhookSecret ?? undefined,
        };
        if (!prev || !sameJson(storedGroup(prev), storedGroup(next))) {
          statements.push(groupUpsert(next));
        }
      }
      if (statements.length > 0) await db.batch(statements);
      await afterWrite();
    },

    async createGroup(group: Group): Promise<boolean> {
      await ensureReady();
      const now = Date.now();
      const stored = {
        ...storedGroup(group),
        instance: newInstanceId(),
        instanceBackfilled: undefined,
        legacyId: undefined,
        webhookSecret: undefined,
      };
      const insert = (sql: string, ...extra: unknown[]): Promise<D1Result> =>
        db
          .prepare(sql)
          .bind(stored.id, stored.name, JSON.stringify(stored), now, now, ...extra)
          .run();
      let result: D1Result;
      try {
        // A retired id is refused in the insert itself: a delete or rename
        // committed after the caller's own retirement check still counts.
        result = await insert(
          `INSERT INTO d1_groups (id, name, data, version, created_at, updated_at)
           SELECT ?, ?, ?, 1, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM dedup_keys WHERE key = ? AND expires_at > ?)
           ON CONFLICT(id) DO NOTHING`,
          retiredGroupKey(stored.id),
          now,
        );
      } catch (err) {
        // No retirement records yet (an unmigrated database).
        if (!isMissingTable(err) || !/dedup_keys/.test(String(err))) throw err;
        result = await insert(
          `INSERT INTO d1_groups (id, name, data, version, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(id) DO NOTHING`,
        );
      }
      const created = (result.meta?.changes ?? 0) > 0;
      if (created) await afterWrite();
      return created;
    },

    async updateGroup(
      id: string,
      mutate: GroupMutation,
      opts?: Pick<GuardedWrite<Group>, "guards" | "after">,
    ): Promise<Group | null> {
      await ensureReady();
      for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt++) {
        const row = await db
          .prepare("SELECT id, name, data, version FROM d1_groups WHERE id = ?")
          .bind(id)
          .first<D1GroupRow>();
        if (!row) return null;
        const prev = rowToGroup(row);
        if (!prev) return null;
        const next = await mutate(prev);
        if (!next) return prev;
        // Server-owned identity fields always come from the stored group.
        const stored = {
          ...storedGroup(next),
          id,
          instance: prev.instance,
          instanceBackfilled: prev.instanceBackfilled,
          legacyId: prev.legacyId,
          webhookSecret: keptSecret(next, prev),
        };
        const update = db
          .prepare(
            `UPDATE d1_groups SET name = ?, data = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND version = ?`,
          )
          .bind(stored.name, JSON.stringify(stored), Date.now(), id, row.version);
        const guards = opts?.guards?.(db) ?? [];
        const after = opts?.after?.(db) ?? [];
        const result =
          guards.length + after.length > 0
            ? (await runGuarded(db, [...guards, update, ...after]))[guards.length]!
            : await update.run();
        if ((result.meta?.changes ?? 0) > 0) {
          await afterWrite();
          return stored;
        }
      }
      throw new ConfigConflictError();
    },

    async deleteGroup(
      id: string,
      opts?: GuardedWrite<Group> & { extra?: LifecycleStatements; version?: number },
    ): Promise<void> {
      await ensureReady();
      const row = await db
        .prepare("SELECT id, name, data, version FROM d1_groups WHERE id = ?")
        .bind(id)
        .first<D1GroupRow>();
      if (!row) return;
      // The version the deletion was confirmed on (any route or fragment
      // write since moved it): anything added after the confirmation stays.
      if (opts?.version != null && row.version !== opts.version) throw new ConfigConflictError();
      const group = rowToGroup(row);
      if (group) await opts?.expect?.(group);
      // Deletes exactly the group that was checked: a change in between aborts.
      await runGuarded(db, [
        groupVersionGuard(db, id, row.version),
        ...(opts?.extra?.(db) ?? []),
        ...groupDeleteStatements(id),
      ]);
      await afterWrite();
    },

    async renameGroup(
      from: string,
      to: string,
      opts?: GuardedWrite<Group> & {
        extra?: LifecycleStatements;
        transform?: (g: Group) => Group;
      },
    ): Promise<Group> {
      await ensureReady();
      const row = await db
        .prepare("SELECT id, name, data, version FROM d1_groups WHERE id = ?")
        .bind(from)
        .first<D1GroupRow>();
      const group = row ? rowToGroup(row) : null;
      if (!row || !group) throw new Error(`group "${from}" does not exist`);
      await opts?.expect?.(group);
      const now = Date.now();
      const base = storedGroup(group);
      const renamed = {
        ...(opts?.transform ? opts.transform(base) : base),
        id: to,
        instance: base.instance,
        instanceBackfilled: base.instanceBackfilled,
        legacyId: base.legacyId,
      };
      // The copy is only valid while the source row is unchanged (guard).
      // Parent first, then children, then the old parent: every statement
      // satisfies the d1_routes foreign key, and the batch is one transaction,
      // so a failure leaves the group exactly as it was.
      await runGuarded(db, [
        groupVersionGuard(db, from, row.version),
        // The target id may have been retired since the caller checked it.
        notRetiredGuard(db, to),
        db
          .prepare(
            `INSERT INTO d1_groups (id, name, data, version, created_at, updated_at)
             VALUES (?, ?, ?, 1, ?, ?)`,
          )
          .bind(to, renamed.name, JSON.stringify(renamed), now, now),
        db.prepare("UPDATE d1_routes SET group_id = ? WHERE group_id = ?").bind(to, from),
        db.prepare("UPDATE d1_fragments SET group_id = ? WHERE group_id = ?").bind(to, from),
        ...(opts?.extra?.(db) ?? []),
        db.prepare("DELETE FROM d1_groups WHERE id = ?").bind(from),
      ]);
      await afterWrite();
      return renamed;
    },

    invalidateCache(): void {
      invalidate();
    },
  };
  return store;
}

/**
 * Configuration kept in KV only, for deployments (and tests) without a D1
 * binding. Each list is one permanent key; writes are read-modify-write and
 * therefore best-effort under concurrency, which is why D1 is preferred.
 */
export function kvConfigStore(kv: KVNamespace): ConfigStore {
  /** Absent key: empty list. A failed read propagates, never passing for "no data". */
  async function readList<T>(key: string): Promise<T[]> {
    const raw = await kv.get<T[]>(key, "json");
    return Array.isArray(raw) ? raw : [];
  }
  const loadRoutes = async (): Promise<Route[]> => migrateRoutes(await readList(KV_ROUTES_KEY));
  let identitiesMigrated = false;
  const loadGroups = async (): Promise<Group[]> => {
    let groups = migrateGroups(await readList<Group>(KV_GROUPS_KEY));
    // Same one-time identity migration as the D1 store: identity fields
    // stored before it came from clients, so every group then existing is a
    // pre-instance group under its own id (a shared instance is replaced).
    if (!identitiesMigrated && !(await kv.get(KV_IDENTITY_MARKER))) {
      // No stored instance is kept: a client-chosen one could equal the one
      // derived for another group.
      groups = await Promise.all(
        groups.map(async (g) => ({
          ...g,
          instance: await backfilledInstanceId(g.id),
          instanceBackfilled: true,
          legacyId: g.id,
        })),
      );
      await kv.put(KV_GROUPS_KEY, JSON.stringify(groups.map(storedGroup)));
      await kv.put(KV_IDENTITY_MARKER, "1");
    }
    identitiesMigrated = true;
    // Same one-time instance backfill as the D1 store.
    const pending = (g: Group): boolean =>
      !g.instance || (g.instanceBackfilled === true && !g.legacyId);
    if (!groups.some(pending)) return groups;
    const filled = await Promise.all(
      groups.map(async (g) =>
        !pending(g)
          ? g
          : {
              ...g,
              instance: g.instance ?? (await backfilledInstanceId(g.id)),
              instanceBackfilled: true,
              legacyId: g.id,
            },
      ),
    );
    await kv.put(KV_GROUPS_KEY, JSON.stringify(filled.map(storedGroup)));
    return filled;
  };
  const putRoutes = (routes: Route[]): Promise<void> =>
    kv.put(KV_ROUTES_KEY, JSON.stringify(routes));
  const putGroups = (groups: Group[]): Promise<void> =>
    kv.put(KV_GROUPS_KEY, JSON.stringify(groups.map(storedGroup)));

  return {
    kind: "kv",
    loadRoutes,
    async loadSnapshot(): Promise<{ routes: Route[]; groups: Group[] }> {
      const [groups, routes] = await Promise.all([loadGroups(), loadRoutes()]);
      return { groups, routes };
    },
    async saveRoutes(routes): Promise<void> {
      await putRoutes(routes);
    },
    async saveGroupRoutes(groupId, routes, opts): Promise<Route[]> {
      const all = await loadRoutes();
      await opts?.expect?.(all.filter((r) => r.groupId === groupId));
      const saved = routes.map((r) => ({ ...r, groupId }));
      await putRoutes([...all.filter((r) => r.groupId !== groupId), ...saved]);
      return saved;
    },
    loadGroups,
    async loadGroup(id: string): Promise<{ group: Group | null; unreadable: boolean }> {
      return { group: (await loadGroups()).find((g) => g.id === id) ?? null, unreadable: false };
    },
    async saveGroups(groups): Promise<void> {
      const ids = new Set(groups.map((g) => g.id));
      const routes = await loadRoutes();
      const kept = routes.filter((r) => !r.groupId || ids.has(r.groupId));
      if (kept.length !== routes.length) await putRoutes(kept);
      await putGroups(groups);
    },
    async createGroup(group): Promise<boolean> {
      const groups = await loadGroups();
      if (groups.some((g) => g.id === group.id)) return false;
      // Routes left under this id by an interrupted rename or delete belong
      // to another group: a new group never inherits them.
      const routes = await loadRoutes();
      if (routes.some((r) => r.groupId === group.id)) {
        await putRoutes(routes.filter((r) => r.groupId !== group.id));
      }
      await putGroups([
        ...groups,
        {
          ...group,
          instance: newInstanceId(),
          instanceBackfilled: undefined,
          legacyId: undefined,
          webhookSecret: undefined,
        },
      ]);
      return true;
    },
    async updateGroup(id, mutate): Promise<Group | null> {
      const groups = await loadGroups();
      const prev = groups.find((g) => g.id === id);
      if (!prev) return null;
      const next = await mutate(prev);
      if (!next) return prev;
      const stored = {
        ...storedGroup(next),
        id,
        instance: prev.instance,
        instanceBackfilled: prev.instanceBackfilled,
        legacyId: prev.legacyId,
        webhookSecret: keptSecret(next, prev),
      };
      await putGroups(groups.map((g) => (g.id === id ? stored : g)));
      return stored;
    },
    async deleteGroup(id, opts): Promise<void> {
      const group = (await loadGroups()).find((g) => g.id === id);
      if (group) await opts?.expect?.(group);
      // Group first: should the second write fail, what is left are inert
      // routes of a missing group, never a group whose routes were dropped.
      await putGroups((await loadGroups()).filter((g) => g.id !== id));
      await putRoutes((await loadRoutes()).filter((r) => r.groupId !== id));
    },
    async renameGroup(from, to, opts): Promise<Group> {
      const groups = await loadGroups();
      const group = groups.find((g) => g.id === from);
      if (!group) throw new Error(`group "${from}" does not exist`);
      if (groups.some((g) => g.id === to)) throw new Error(`group "${to}" already exists`);
      await opts?.expect?.(group);
      const moved = {
        ...(opts?.transform ? opts.transform(group) : group),
        id: to,
        instance: group.instance,
        instanceBackfilled: group.instanceBackfilled,
        legacyId: group.legacyId,
      };
      // No transaction across the two keys: copy the routes first, move the
      // group, drop the old copies last. Stopping anywhere leaves every route
      // under the group's current id (plus inert copies under the other one).
      const routes = await loadRoutes();
      const copies = routes.filter((r) => r.groupId === from).map((r) => ({ ...r, groupId: to }));
      await putRoutes([...routes.filter((r) => r.groupId !== to), ...copies]);
      await putGroups(groups.map((g) => (g.id === from ? moved : g)));
      await putRoutes((await loadRoutes()).filter((r) => r.groupId !== from));
      return storedGroup(moved);
    },
    invalidateCache(): void {},
  };
}

/** The store for a binding pair: D1-backed when D1 is usable, KV-only otherwise. */
export function createConfigStore(db: D1Database | undefined, kv: KVNamespace): ConfigStore {
  return canUseD1(db) ? d1ConfigStore(db!, kv) : kvConfigStore(kv);
}
