import type { Env, Group, GroupMember, GroupRole } from "../types";
import { identityEntryMatches, isAdminUser } from "./session";
import { getConfigStore } from "../config";
import { idempotencyStore, unrecordedGuard } from "../lib/idempotency";
import { ConfigConflictError } from "../storage/config-store";
import { canUseD1 } from "../storage/d1";
import type {
  GroupMutation,
  GuardedWrite,
  LifecycleStatements,
  LoadOptions,
} from "../storage/config-store";

/**
 * Normalizes a group's member list. Groups stored with the legacy `adminIds`
 * field (or with neither field) get their admins as role "owner" members, so
 * every existing group keeps full control after the member-model migration.
 * Never mutates the input; returns a fresh array.
 */
export function normalizeGroupMembers(group: Group): GroupMember[] {
  const members = group.members;
  if (Array.isArray(members) && members.length > 0) {
    const seen = new Set<string>();
    const out: GroupMember[] = [];
    for (const m of members) {
      const login = String(m?.login ?? "").trim();
      if (!login || seen.has(login.toLowerCase())) continue;
      const role: GroupRole = m?.role === "admin" || m?.role === "viewer" ? m.role : "owner";
      seen.add(login.toLowerCase());
      const userId = typeof m?.userId === "string" && /^\d+$/.test(m.userId) ? m.userId : "";
      out.push(userId ? { login, role, userId } : { login, role });
    }
    return out;
  }
  // Legacy path: adminIds → owners.
  const seen = new Set<string>();
  const out: GroupMember[] = [];
  for (const a of group.adminIds ?? []) {
    const login = a.trim();
    if (!login || seen.has(login.toLowerCase())) continue;
    seen.add(login.toLowerCase());
    out.push({ login, role: "owner" });
  }
  return out;
}

export async function loadGroups(kv: KVNamespace, opts?: LoadOptions): Promise<Group[]> {
  return getConfigStore(kv).loadGroups(opts);
}

/**
 * Replace the full group set (super-admin bulk write): groups left out are
 * deleted with their routes and fragments, only changed groups are rewritten.
 */
export async function saveGroups(kv: KVNamespace, groups: Group[]): Promise<void> {
  await getConfigStore(kv).saveGroups(groups);
}

/** Insert a group unless its id is taken; true when it was created. */
export async function createGroup(kv: KVNamespace, group: Group): Promise<boolean> {
  return getConfigStore(kv).createGroup(group);
}

/**
 * Atomically read-modify-write one group. `mutate` gets the current stored
 * group and returns the replacement, or null to keep it unchanged.
 */
export async function updateGroup(
  kv: KVNamespace,
  id: string,
  mutate: GroupMutation,
  opts?: Pick<GuardedWrite<Group>, "guards" | "after">,
): Promise<Group | null> {
  return getConfigStore(kv).updateGroup(id, mutate, opts);
}

/** Delete one group with its routes and filter fragments. */
export async function deleteGroup(
  kv: KVNamespace,
  id: string,
  opts?: GuardedWrite<Group> & { extra?: LifecycleStatements; version?: number },
): Promise<void> {
  await getConfigStore(kv).deleteGroup(id, opts);
}

/** Move a group (with its routes and fragments) to a new id atomically. */
export async function renameGroup(
  kv: KVNamespace,
  from: string,
  to: string,
  opts?: GuardedWrite<Group> & { extra?: LifecycleStatements; transform?: (g: Group) => Group },
): Promise<Group> {
  return getConfigStore(kv).renameGroup(from, to, opts);
}

/** Kept for callers that reset state between tests; the store owns its caches. */
export function invalidateGroupsCache(): void {}

/** Whether any entry names the user: all-digit entries are user ids, others logins. */
export function identityMatches(ids: string[], userId: string, login: string): boolean {
  return ids.some((id) => identityEntryMatches(id, userId, login));
}

/**
 * Whether a member entry is this user. A member bound to a GitHub user id is
 * that account only — a login can be renamed and then claimed by someone
 * else, an id never changes. Unbound entries match like `identityMatches`.
 */
export function memberMatches(member: GroupMember, userId: string, login: string): boolean {
  if (member.userId) return member.userId === userId;
  return identityEntryMatches(member.login, userId, login);
}

/**
 * A guard statement that aborts its transaction unless the user holds one of
 * `roles` in group `gid` as stored at that moment. Member entries match the
 * way `memberMatches` does: a bound entry by user id, an all-digit one by
 * user id, any other by `login` (pass "" to match by id only); groups still
 * on legacy `adminIds` count those as owners.
 */
export function memberRoleStatement(
  db: D1Database,
  gid: string,
  userId: string,
  login: string,
  roles: GroupRole[],
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM (SELECT id, CASE WHEN json_valid(data) THEN data ELSE '{}' END AS data FROM d1_groups) g, json_each(g.data, '$.members') m
         WHERE g.id = ? AND json_extract(m.value, '$.role') IN (${roles.map(() => "?").join(", ")})
           AND (json_extract(m.value, '$.userId') = ?
             OR (json_extract(m.value, '$.userId') IS NULL AND (
               (json_extract(m.value, '$.login') NOT GLOB '*[^0-9]*'
                 AND json_extract(m.value, '$.login') = ?)
               OR (json_extract(m.value, '$.login') GLOB '*[^0-9]*'
                 AND lower(json_extract(m.value, '$.login')) = lower(?)))))
       ) OR (? IN (${roles.map(() => "?").join(", ")}) AND EXISTS (
         SELECT 1 FROM (SELECT id, CASE WHEN json_valid(data) THEN data ELSE '{}' END AS data FROM d1_groups) g, json_each(g.data, '$.adminIds') a
         WHERE g.id = ? AND coalesce(json_array_length(g.data, '$.members'), 0) = 0
           AND ((a.value NOT GLOB '*[^0-9]*' AND a.value = ?)
             OR (a.value GLOB '*[^0-9]*' AND lower(a.value) = lower(?)))
       )) THEN 1 ELSE json('role revoked') END AS ok`,
    )
    .bind(gid, ...roles, userId, userId, login, "owner", ...roles, gid, userId, login);
}

/**
 * Carry the user ids already bound to members over to a submitted member
 * list (matched by login): clients edit logins and roles, never the binding.
 */
export function carryMemberIds(next: Group, prev: Group | undefined): Group {
  if (!prev || !Array.isArray(next.members)) return next;
  const bound = new Map(
    normalizeGroupMembers(prev)
      .filter((m) => m.userId)
      .map((m) => [m.login.toLowerCase(), m.userId!]),
  );
  if (bound.size === 0) return next;
  return {
    ...next,
    members: next.members.map((m) => {
      const userId = bound.get(m.login.trim().toLowerCase());
      return userId ? { ...m, userId } : m;
    }),
  };
}

/**
 * Bind the signed-in user's id to the member entries that name them only by
 * login, so a later owner of that login (after a rename) never inherits the
 * membership. Best-effort; each group is a compare-and-swap.
 */
export async function bindMemberIds(
  kv: KVNamespace,
  groups: Group[],
  userId: string,
  login: string,
): Promise<void> {
  const unbound = (g: Group): boolean =>
    normalizeGroupMembers(g).some(
      (m) => !m.userId && !/^\d+$/.test(m.login) && memberMatches(m, userId, login),
    );
  for (const group of groups.filter(unbound)) {
    await updateGroup(kv, group.id, (g) => {
      if (!unbound(g)) return null;
      const members = normalizeGroupMembers(g).map((m) =>
        !m.userId && !/^\d+$/.test(m.login) && memberMatches(m, userId, login)
          ? { ...m, userId }
          : m,
      );
      return { ...g, members };
    });
  }
}

export function isGroupAdmin(group: Group, userId: string, login: string): boolean {
  return identityMatches(group.adminIds ?? [], userId, login);
}

/**
 * The user's role in a group, derived from normalized members. Legacy
 * `adminIds` groups resolve to "owner" for every listed admin.
 */
export function memberRole(group: Group, userId: string, login: string): GroupRole | undefined {
  const member = normalizeGroupMembers(group).find((m) => memberMatches(m, userId, login));
  return member?.role;
}

/**
 * Whether an event originating from `owners` (org/user logins) is allowed into
 * this group. A group with no owner restriction accepts everything.
 */
export function groupAcceptsOwners(group: Group, owners: string[]): boolean {
  const restrict = (group.owners ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (restrict.length === 0) return true;
  const seen = owners.map((s) => s.trim().toLowerCase()).filter(Boolean);
  return seen.some((o) => restrict.includes(o));
}

/**
 * Whether an event from a webhook `provider` (source platform: github, gitea,
 * ...) is allowed into this group. A group with no provider restriction
 * accepts every provider. Events without a provider are treated as github.
 */
export function groupAcceptsProvider(group: Group, provider?: string): boolean {
  const allowed = (group.providers ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length === 0) return true;
  return allowed.includes(provider ?? "github");
}

/**
 * Whether an event from a GitHub App `installationId` is allowed into this
 * group. A group bound to an installation only accepts events from that
 * installation (hard tenant isolation). Unbound groups accept everything here
 * (their access is governed by `owners`/`providers` instead).
 */
export function groupAcceptsInstallation(group: Group, installationId?: number): boolean {
  if (group.installationId == null) return true;
  return installationId != null && group.installationId === installationId;
}

/**
 * Whether the group may receive an event that arrived on the legacy global
 * endpoint (`POST /webhook`). Isolated groups (self-service personal groups)
 * only take events from their own `/webhook/{groupId}` ingress, unless a super
 * admin bound them to a source: a GitHub App installation or an `owners` list.
 */
/**
 * Whether a group is isolated. Personal groups (`u-{userId}`) created before
 * the flag existed count as isolated too, unless a super admin explicitly set
 * `isolated: false`.
 */
export function isIsolated(group: Group): boolean {
  return group.isolated ?? /^u-\d+$/.test(group.id);
}

export function groupAcceptsGlobalIngress(group: Group): boolean {
  const isolated = isIsolated(group);
  if (!isolated) return true;
  return group.installationId != null || (group.owners ?? []).some((o) => o.trim().length > 0);
}

/**
 * Auto-provision a GitHub App installation on `installation.created`:
 * 1. No-op when a group is already bound to this installation id.
 * 2. Otherwise bind every unbound group whose `owners` match the installing
 *    account login (so existing org groups light up automatically).
 * 3. Otherwise create a dedicated `inst-{installationId}` group bound to the
 *    installation. Returns the group that now owns the installation.
 *
 * Every write is an atomic create-if-absent or compare-and-swap update, so
 * concurrent deliveries converge on the same group without a lock.
 */
/** An automatic installation binding is remembered as long as delivery state (7 days). */
const AUTO_BOUND_TTL_SECONDS = 7 * 86400;

export async function ensureInstallationGroup(
  kv: KVNamespace,
  installationId: number,
  accountLogin: string,
  db?: D1Database,
): Promise<Group | null> {
  // Each automatic binding is recorded (per installation and group) in the
  // transaction that makes it: a retry binds the groups an earlier attempt
  // did not reach, never again one it bound — an admin may have undone that.
  const claims = db ? idempotencyStore(db, kv) : null;
  const boundKey = (g: Group): string =>
    `installation-bound:${installationId}:${g.instance ?? g.id}`;
  const groups = await loadGroups(kv, { fresh: true });
  // Already bound somewhere (an earlier attempt): the matching groups still
  // unbound are bound all the same — that attempt may have failed midway.
  const existing = groups.find((g) => g.installationId === installationId);

  const login = accountLogin.trim().toLowerCase();
  const candidates = groups.filter(
    (g) =>
      g.installationId == null &&
      login.length > 0 &&
      (g.owners ?? []).some((o) => o.trim().toLowerCase() === login),
  );
  let bound: Group | null = null;
  for (const candidate of candidates) {
    if (claims && (await claims.has(boundKey(candidate)))) continue;
    const key = boundKey(candidate);
    const now = Date.now();
    // Re-checked on the group as it is at the write: the same group (not one
    // that took over the id), still unbound, still owned by this account —
    // an `owners` list cleared meanwhile must not be reopened by a binding.
    const updated = await updateGroup(
      kv,
      candidate.id,
      (g) =>
        g.instance === candidate.instance &&
        g.installationId == null &&
        login.length > 0 &&
        (g.owners ?? []).some((o) => o.trim().toLowerCase() === login)
          ? { ...g, installationId }
          : null,
      db && canUseD1(db)
        ? {
            // Checked again at the write: an attempt that read before another
            // one bound (and an admin unbound) the group never binds it again.
            guards: (d): D1PreparedStatement[] => [unrecordedGuard(d, key)],
            // Recorded only when the binding was written (the statement before).
            after: (d): D1PreparedStatement[] => [
              d
                .prepare(
                  `INSERT INTO dedup_keys (key, claimed_at, expires_at) SELECT ?, ?, ? WHERE changes() > 0
                   ON CONFLICT(key) DO UPDATE SET
                     claimed_at = excluded.claimed_at, expires_at = excluded.expires_at`,
                )
                .bind(key, now, now + AUTO_BOUND_TTL_SECONDS * 1000),
            ],
          }
        : undefined,
    ).catch((err: unknown) => {
      // Refused at the write (bound before by another attempt, or still
      // contended): this group is left as it is.
      if (err instanceof ConfigConflictError) return null;
      throw err;
    });
    if (updated?.installationId === installationId) {
      bound ??= updated;
      // Without D1 transactions, recorded right after (best effort).
      if (claims && !(db && canUseD1(db))) await claims.claim(key, AUTO_BOUND_TTL_SECONDS);
    }
  }
  if (existing) return existing;
  if (bound) return bound;

  const gid = `inst-${installationId}`;
  const group: Group = {
    id: gid,
    name: accountLogin.trim() || `Installation ${installationId}`,
    adminIds: [],
    installationId,
  };
  if (await createGroup(kv, group)) {
    // As stored (with the instance the server gave it), for its audit.
    return (await loadGroups(kv, { fresh: true })).find((g) => g.id === gid) ?? group;
  }
  // The id exists already: only a group already bound to this installation
  // (a concurrent delivery) is used. An unbound group that merely carries the
  // name is never bound — its members did not prove they own the installation.
  const current = (await loadGroups(kv, { fresh: true })).find((g) => g.id === gid);
  return current?.installationId === installationId ? current : null;
}

export interface AccessScope {
  isSuper: boolean;
  /** Groups the user may view. When isSuper, this is every group. */
  groups: Group[];
  /** Ids of accessible groups, for quick membership checks. */
  groupIds: Set<string>;
  /** The user's role per accessible group (absent for super admins). */
  roles: Map<string, GroupRole>;
}

export function resolveScope(
  env: Env,
  groups: Group[],
  userId: string,
  login: string,
): AccessScope {
  const isSuper = isAdminUser(env, userId, login);
  const visible = isSuper ? groups : groups.filter((g) => memberRole(g, userId, login) != null);
  const roles = new Map<string, GroupRole>();
  for (const g of visible) {
    const role = memberRole(g, userId, login);
    if (role) roles.set(g.id, role);
  }
  return {
    isSuper,
    groups: visible,
    groupIds: new Set(visible.map((g) => g.id)),
    roles,
  };
}

/** The user's role in a group, or undefined when they have no access. */
export function roleAt(scope: AccessScope, groupId: string): GroupRole | undefined {
  if (scope.isSuper) return "owner";
  return scope.roles.get(groupId);
}

/** Role hierarchy: viewer < admin < owner. */
const ROLE_RANK: Record<GroupRole, number> = { viewer: 1, admin: 2, owner: 3 };

export function roleAtLeast(role: GroupRole | undefined, min: GroupRole): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** owner | admin can edit routes; viewers are read-only. */
export function canEditRoutes(scope: AccessScope, groupId: string): boolean {
  return roleAtLeast(roleAt(scope, groupId), "admin");
}

/** Only owners (and super admins) may manage a group's settings and members. */
export function canEditGroup(scope: AccessScope, groupId: string): boolean {
  return roleAtLeast(roleAt(scope, groupId), "owner");
}

/** True if the user is a super admin or manages at least one group. */
export function hasAnyAccess(scope: AccessScope): boolean {
  return scope.isSuper || scope.groups.length > 0;
}
