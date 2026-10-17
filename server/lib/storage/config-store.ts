import type { Group, Route } from "../types";
import { log } from "../lib/log";

export interface ConfigStore {
  loadRoutes(): Promise<Route[]>;
  saveRoutes(routes: Route[]): Promise<void>;
  loadGroups(): Promise<Group[]>;
  saveGroups(groups: Group[]): Promise<void>;
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

const CACHE_TTL = 300_000;
const KV_ROUTES_KEY = "config:routes";
const KV_GROUPS_KEY = "config:groups";

const KV_CACHE_TTL = 3600;

function parseJson<T>(value: string, label: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    log.warn({ err, label }, "Ignoring malformed configuration row");
    return null;
  }
}

export function d1ConfigStore(db: D1Database, kv: KVNamespace): ConfigStore {
  let routesCache: { routes: Route[]; expiresAt: number } | null = null;
  let groupsCache: { groups: Group[]; expiresAt: number } | null = null;

  async function loadRoutesFromD1(): Promise<Route[]> {
    const stmt = db.prepare(
      "SELECT id, group_id, name, enabled, filters, targets, stop, fallback, discord_role_ids, ast FROM d1_routes ORDER BY id",
    );
    if (typeof stmt.all !== "function") return [];
    const { results } = await stmt.all<D1RouteRow>();
    if (!results || results.length === 0) return [];
    return results.flatMap((r) => {
      const filters = parseJson<Route["filters"]>(r.filters, `route:${r.id}:filters`);
      const targets = parseJson<Route["targets"]>(r.targets, `route:${r.id}:targets`);
      const discordRoleIds = r.discord_role_ids
        ? parseJson<Route["discordRoleIds"]>(r.discord_role_ids, `route:${r.id}:discord_role_ids`)
        : undefined;
      const ast = r.ast ? parseJson<Route["ast"]>(r.ast, `route:${r.id}:ast`) : undefined;
      if (!filters || !targets || (r.discord_role_ids && !discordRoleIds) || (r.ast && !ast)) {
        return [];
      }
      return [
        {
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
        },
      ];
    });
  }

  async function loadGroupsFromD1(): Promise<Group[]> {
    const stmt = db.prepare("SELECT id, name, data, version FROM d1_groups ORDER BY id");
    if (typeof stmt.all !== "function") return [];
    const { results } = await stmt.all<D1GroupRow>();
    if (!results || results.length === 0) return [];
    return results.flatMap((r) => {
      const group = parseJson<Group>(r.data, `group:${r.id}`);
      return group ? [group] : [];
    });
  }

  async function loadRoutesFromKV(): Promise<Route[]> {
    try {
      const raw = await kv.get<Route[]>(KV_ROUTES_KEY, "json");
      if (raw) return raw;
    } catch (err) {
      log.warn({ err }, "Failed to load routes from KV");
    }
    return [];
  }

  async function loadGroupsFromKV(): Promise<Group[]> {
    try {
      const raw = await kv.get<Group[]>(KV_GROUPS_KEY, "json");
      if (raw) return raw;
    } catch (err) {
      log.warn({ err }, "Failed to load groups from KV");
    }
    return [];
  }

  function routeStatements(
    routes: Route[],
    existingRouteKeys?: Set<string>,
  ): D1PreparedStatement[] {
    const now = Date.now();
    const statements: D1PreparedStatement[] = [];

    // If we have existing routes, delete those not in the new set
    if (existingRouteKeys) {
      const newKeys = new Set(routes.map((r) => `${r.id}:${r.groupId ?? ""}`));
      for (const key of existingRouteKeys) {
        if (!newKeys.has(key)) {
          const [id, groupId] = key.split(":");
          statements.push(
            db.prepare("DELETE FROM d1_routes WHERE id = ? AND group_id = ?").bind(id, groupId),
          );
        }
      }
    } else {
      // Backward compatibility: delete all routes if no existing set provided
      statements.push(db.prepare("DELETE FROM d1_routes"));
    }

    // Upsert all routes
    for (const r of routes) {
      statements.push(
        db
          .prepare(
            `INSERT INTO d1_routes (id, group_id, name, enabled, filters, targets, stop, fallback, discord_role_ids, ast, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
             ON CONFLICT(id, group_id) DO UPDATE SET
               name = excluded.name,
               enabled = excluded.enabled,
               filters = excluded.filters,
               targets = excluded.targets,
               stop = excluded.stop,
               fallback = excluded.fallback,
               discord_role_ids = excluded.discord_role_ids,
               ast = excluded.ast,
               updated_at = excluded.updated_at`,
          )
          .bind(
            r.id,
            r.groupId ?? "",
            r.name,
            r.enabled ? 1 : 0,
            JSON.stringify(r.filters),
            JSON.stringify(r.targets),
            r.stop ? 1 : 0,
            r.fallback ? 1 : 0,
            r.discordRoleIds ? JSON.stringify(r.discordRoleIds) : null,
            r.ast ? JSON.stringify(r.ast) : null,
            now,
            now,
          ),
      );
    }

    return statements;
  }

  function groupStatements(groups: Group[], existingGroupIds: string[]): D1PreparedStatement[] {
    const now = Date.now();
    const newGroupIds = new Set(groups.map((g) => g.id));
    const toDelete = existingGroupIds.filter((id) => !newGroupIds.has(id));

    const statements: D1PreparedStatement[] = [];

    // Delete routes only when a group is actually removed. Group renames move
    // routes before calling saveGroups, so the new group id is no longer in
    // this list and the routes survive the group update.
    for (const groupId of toDelete) {
      statements.push(db.prepare("DELETE FROM d1_routes WHERE group_id = ?").bind(groupId));
    }

    // Then delete the groups themselves
    for (const groupId of toDelete) {
      statements.push(db.prepare("DELETE FROM d1_groups WHERE id = ?").bind(groupId));
    }

    // Finally, upsert all groups (INSERT OR REPLACE)
    for (const g of groups) {
      statements.push(
        db
          .prepare(
            `INSERT INTO d1_groups (id, name, data, version, created_at, updated_at)
             VALUES (?, ?, ?, 1, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               data = excluded.data,
               updated_at = excluded.updated_at`,
          )
          .bind(g.id, g.name, JSON.stringify(g), now, now),
      );
    }

    return statements;
  }

  async function seedRoutesToD1(routes: Route[]): Promise<void> {
    if (routes.length === 0) return;
    await db.batch(routeStatements(routes));
  }

  async function seedGroupsToD1(groups: Group[]): Promise<void> {
    if (groups.length === 0) return;
    // When seeding, there are no existing groups to delete
    await db.batch(groupStatements(groups, []));
  }

  async function syncRoutesToKV(routes: Route[], ttl: number): Promise<void> {
    try {
      await kv.put(KV_ROUTES_KEY, JSON.stringify(routes), { expirationTtl: ttl });
    } catch (err) {
      log.warn({ err }, "Failed to sync routes to KV cache");
    }
  }

  async function syncGroupsToKV(groups: Group[], ttl: number): Promise<void> {
    try {
      await kv.put(KV_GROUPS_KEY, JSON.stringify(groups), { expirationTtl: ttl });
    } catch (err) {
      log.warn({ err }, "Failed to sync groups to KV cache");
    }
  }

  return {
    async loadRoutes(): Promise<Route[]> {
      if (routesCache && Date.now() < routesCache.expiresAt) {
        return routesCache.routes;
      }

      let routes: Route[] = [];
      try {
        routes = await loadRoutesFromD1();
        if (routes.length > 0) {
          syncRoutesToKV(routes, KV_CACHE_TTL).catch(() => undefined);
        } else {
          routes = await loadRoutesFromKV();
          if (routes.length > 0) {
            seedRoutesToD1(routes).catch((err) =>
              log.warn({ err }, "Failed to seed routes from KV to D1"),
            );
          }
        }
      } catch (err) {
        log.warn({ err }, "D1 routes unavailable, falling back to KV");
        routes = await loadRoutesFromKV();
      }

      routesCache = { routes, expiresAt: Date.now() + CACHE_TTL };
      return routes;
    },

    async saveRoutes(routes: Route[]): Promise<void> {
      try {
        await db.batch(routeStatements(routes));
        await syncRoutesToKV(routes, KV_CACHE_TTL);
      } catch (err) {
        log.warn({ err }, "D1 routes unavailable, falling back to KV");
        await syncRoutesToKV(routes, 0);
      }
      routesCache = null;
    },

    async loadGroups(): Promise<Group[]> {
      if (groupsCache && Date.now() < groupsCache.expiresAt) {
        return groupsCache.groups;
      }

      let groups: Group[] = [];
      try {
        groups = await loadGroupsFromD1();
        if (groups.length > 0) {
          syncGroupsToKV(groups, KV_CACHE_TTL).catch(() => undefined);
        } else {
          groups = await loadGroupsFromKV();
          if (groups.length > 0) {
            seedGroupsToD1(groups).catch((err) =>
              log.warn({ err }, "Failed to seed groups from KV to D1"),
            );
          }
        }
      } catch (err) {
        log.warn({ err }, "D1 groups unavailable, falling back to KV");
        groups = await loadGroupsFromKV();
      }

      groupsCache = { groups, expiresAt: Date.now() + CACHE_TTL };
      return groups;
    },

    async saveGroups(groups: Group[]): Promise<void> {
      try {
        // Load existing group IDs to properly handle deletions
        const existing = await loadGroupsFromD1();
        const existingIds = existing.map((g) => g.id);
        await db.batch(groupStatements(groups, existingIds));
        await syncGroupsToKV(groups, KV_CACHE_TTL);
      } catch (err) {
        log.warn({ err }, "D1 groups unavailable, falling back to KV");
        await syncGroupsToKV(groups, 0);
      }
      groupsCache = null;
    },

    invalidateCache(): void {
      routesCache = null;
      groupsCache = null;
    },
  };
}
