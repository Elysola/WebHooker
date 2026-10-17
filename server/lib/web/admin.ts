import type { H3Event } from "h3";
import {
  getHeader,
  getQuery,
  readBody,
  sendRedirect,
  setResponseHeader,
  setResponseStatus,
} from "h3";
import type { Route, Group, GroupMember, GroupRole, ForgeSource, FilterNode } from "../types";
import { loadRoutes, saveRoutes } from "../config";
import { loadFragments, saveFragments, type NamedFragment } from "../fragments";
import { evaluateFilterNode, explainFilterNode } from "../events/filter-ast";
import { getAdminSession, destroyAdminSession, clearAdminCookie, isDebugMode } from "./session";
import { saveGroups, loadGroups, identityMatches, normalizeGroupMembers } from "./groups";
import {
  requireAnyAccess,
  currentAuth,
  requireGroup,
  requireGroupRole,
  roleAt,
  clientIp,
  type GroupAccess,
} from "./auth";
import { getSendLog, getSendLogById, getSendLogByDelivery } from "../lib/send-log";
import { getDeliveryMetrics } from "../observability/metrics";
import { getAuditLog, recordAudit } from "../lib/audit";
import {
  createInvite,
  listInvites,
  revokeInvite,
  getInvite,
  acceptInvite,
  migrateInvites,
} from "./invites";
import { getTenantSecret, setTenantSecret, deleteTenantSecret } from "./tenants";
import { cfEnv } from "../cf";
import { log } from "../lib/log";

const VALID_FILTER_TYPES = new Set([
  "event",
  "repo",
  "actor",
  "action",
  "branch",
  "keyword",
  "field",
]);
const VALID_OPS = new Set([
  "eq",
  "ne",
  "contains",
  "startsWith",
  "endsWith",
  "regex",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "exists",
]);
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const HOST_RE =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;

function isValidMatch(match: unknown): match is string | string[] {
  if (typeof match === "string") return match.trim().length > 0;
  if (Array.isArray(match))
    return match.length > 0 && match.every((m) => typeof m === "string" && m.trim().length > 0);
  return false;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
  }
  return false;
}

function validateFilterNode(node: unknown, label: string): string | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return `${label} must be an object`;
  }
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.all)) {
    if (n.all.length === 0) return `${label}.all must not be empty`;
    for (let i = 0; i < n.all.length; i++) {
      const err = validateFilterNode(n.all[i], `${label}.all[${i}]`);
      if (err) return err;
    }
    return null;
  }
  if (Array.isArray(n.any)) {
    if (n.any.length === 0) return `${label}.any must not be empty`;
    for (let i = 0; i < n.any.length; i++) {
      const err = validateFilterNode(n.any[i], `${label}.any[${i}]`);
      if (err) return err;
    }
    return null;
  }
  if (n.not !== undefined) return validateFilterNode(n.not, `${label}.not`);
  if (!VALID_FILTER_TYPES.has(n.type as string)) {
    return `${label} has unknown type`;
  }
  if (n.type === "field" && (typeof n.path !== "string" || n.path.trim().length === 0)) {
    return `${label}.path is required for field filters`;
  }
  if (n.path !== undefined && typeof n.path !== "string") {
    return `${label}.path must be a string`;
  }
  if (n.op !== undefined && !VALID_OPS.has(n.op as string)) {
    return `${label}.op is invalid`;
  }
  if ((n.op as string) !== "exists" && !isValidMatch(n.match)) {
    return `${label} needs a match value`;
  }
  if (n.exclude !== undefined && typeof n.exclude !== "boolean") {
    return `${label}.exclude must be a boolean`;
  }
  return null;
}

/**
 * Validates the submitted routes. Routes that are byte-for-byte identical to an
 * entry in `unchanged` (keyed by id) skip the full content check, so a pre-existing
 * incomplete route can never block edits to a different route. Only new or modified
 * routes are fully validated. Structural checks (id shape, uniqueness) still run for all.
 */
function validateRoutes(
  routes: unknown,
  unchanged?: Map<string, Route>,
): { ok: true; routes: Route[] } | { ok: false; error: string } {
  if (!Array.isArray(routes)) return { ok: false, error: "routes must be an array" };
  if (routes.length > 200) return { ok: false, error: "too many routes" };

  const seenByGroup = new Map<string, Set<string>>();
  for (let i = 0; i < routes.length; i++) {
    const r = routes[i] as Record<string, unknown>;
    if (!r || typeof r !== "object") return { ok: false, error: `route[${i}] is not an object` };
    if (typeof r.id !== "string" || !ID_RE.test(r.id)) {
      return { ok: false, error: `route[${i}].id is invalid` };
    }
    const gid = (r.groupId as string) ?? "__nogroup__";
    let groupSeen = seenByGroup.get(gid);
    if (!groupSeen) {
      groupSeen = new Set();
      seenByGroup.set(gid, groupSeen);
    }
    if (groupSeen.has(r.id)) {
      return { ok: false, error: `duplicate route id "${r.id}" in group "${gid}"` };
    }
    groupSeen.add(r.id);
    // Skip full validation for routes that are unchanged from what is stored.
    const prev = unchanged?.get(r.id);
    if (prev && deepEqual(r, prev)) continue;
    if (typeof r.name !== "string" || r.name.trim().length === 0) {
      return { ok: false, error: `route "${r.id}" needs a name` };
    }
    if (typeof r.groupId !== "string" || r.groupId.trim().length === 0) {
      return { ok: false, error: `route "${r.id}" needs a group` };
    }
    if (typeof r.enabled !== "boolean")
      return { ok: false, error: `route "${r.id}".enabled must be boolean` };
    if (r.fallback !== undefined && typeof r.fallback !== "boolean") {
      return { ok: false, error: `route "${r.id}".fallback must be a boolean` };
    }
    if (r.stop !== undefined && typeof r.stop !== "boolean") {
      return { ok: false, error: `route "${r.id}".stop must be a boolean` };
    }
    if (
      r.discordRoleIds !== undefined &&
      (!Array.isArray(r.discordRoleIds) ||
        !r.discordRoleIds.every((d) => typeof d === "string" && d.trim().length > 0))
    ) {
      return { ok: false, error: `route "${r.id}".discordRoleIds must be a list of strings` };
    }
    if (!Array.isArray(r.filters)) {
      return { ok: false, error: `route "${r.id}".filters must be an array` };
    }
    if (r.fallback !== true && r.filters.length === 0 && r.ast === undefined) {
      return { ok: false, error: `route "${r.id}" needs at least one filter` };
    }
    for (let j = 0; j < r.filters.length; j++) {
      const err = validateFilterNode(r.filters[j], `route "${r.id}" filter[${j}]`);
      if (err) return { ok: false, error: err };
    }
    if (r.ast !== undefined) {
      const err = validateFilterNode(r.ast, `route "${r.id}".ast`);
      if (err) return { ok: false, error: err };
    }
    const rawTarget = r.target as Record<string, unknown> | undefined;
    const rawTargets = r.targets as unknown;
    if (rawTargets === undefined && rawTarget && typeof rawTarget === "object") {
      const legacy = validateTarget(`route "${r.id}"`, rawTarget);
      if (!legacy.ok) return legacy;
      (r as Record<string, unknown>).targets = [legacy.target];
      delete (r as Record<string, unknown>).target;
    } else if (Array.isArray(rawTargets)) {
      if (rawTargets.length === 0) {
        return { ok: false, error: `route "${r.id}" needs at least one target` };
      }
      const normalized: Route["targets"] = [];
      for (let j = 0; j < rawTargets.length; j++) {
        const t = rawTargets[j] as Record<string, unknown>;
        if (!t || typeof t !== "object") {
          return { ok: false, error: `route "${r.id}".targets[${j}] is not an object` };
        }
        const result = validateTarget(`route "${r.id}".targets[${j}]`, t);
        if (!result.ok) return result;
        normalized.push(result.target);
      }
      (r as Record<string, unknown>).targets = normalized;
    } else {
      return { ok: false, error: `route "${r.id}" needs a targets array` };
    }
  }
  return { ok: true, routes: routes as Route[] };
}

function validateTarget(
  label: string,
  target: Record<string, unknown>,
): { ok: true; target: Route["targets"][number] } | { ok: false; error: string } {
  const platform = target.platform === undefined ? "discord" : target.platform;
  if (platform !== "discord" && platform !== "telegram" && platform !== "feishu") {
    return { ok: false, error: `${label}.platform must be "discord", "telegram" or "feishu"` };
  }
  if (platform === "telegram" || platform === "feishu") {
    if (typeof target.chatId !== "string" || target.chatId.trim().length === 0)
      return { ok: false, error: `${label}.chatId is required` };
    if (target.topicId !== undefined && typeof target.topicId !== "string") {
      return { ok: false, error: `${label}.topicId must be a string` };
    }
  } else {
    if (typeof target.channelId !== "string" || target.channelId.trim().length === 0)
      return { ok: false, error: `${label}.channelId is required` };
    if (target.threadId !== undefined && typeof target.threadId !== "string") {
      return { ok: false, error: `${label}.threadId must be a string` };
    }
  }
  return {
    ok: true,
    target: {
      platform,
      channelId: platform === "discord" ? (target.channelId as string) : undefined,
      threadId: platform === "discord" ? ((target.threadId as string) ?? undefined) : undefined,
      chatId:
        platform === "telegram" || platform === "feishu" ? (target.chatId as string) : undefined,
      topicId: platform === "telegram" ? ((target.topicId as string) ?? undefined) : undefined,
    },
  };
}

function validateMembers(
  g: Record<string, unknown>,
  gid: string,
): { ok: true; members: GroupMember[] } | { ok: false; error: string } {
  const raw = g.members;
  if (raw === undefined || raw === null) {
    // Legacy payload without members: derive owners from adminIds.
    const adminIds = g.adminIds;
    if (!Array.isArray(adminIds)) {
      return { ok: false, error: `group "${gid}" needs a members list` };
    }
    if (!adminIds.every((a) => typeof a === "string" && a.trim().length > 0)) {
      return { ok: false, error: `group "${gid}".adminIds must be a list of strings` };
    }
    const members: GroupMember[] = [];
    const seen = new Set<string>();
    for (const a of adminIds as string[]) {
      const login = a.trim();
      if (!login || seen.has(login.toLowerCase())) continue;
      seen.add(login.toLowerCase());
      members.push({ login, role: "owner" });
    }
    return { ok: true, members };
  }
  if (!Array.isArray(raw)) return { ok: false, error: `group "${gid}".members must be an array` };
  const seen = new Set<string>();
  const members: GroupMember[] = [];
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i] as Record<string, unknown>;
    if (!m || typeof m !== "object")
      return { ok: false, error: `group "${gid}".members[${i}] is not an object` };
    const login = typeof m.login === "string" ? m.login.trim() : "";
    if (!login) return { ok: false, error: `group "${gid}".members[${i}].login is required` };
    const role = m.role;
    if (role !== "owner" && role !== "admin" && role !== "viewer") {
      return {
        ok: false,
        error: `group "${gid}".members[${i}].role must be "owner" | "admin" | "viewer"`,
      };
    }
    if (seen.has(login.toLowerCase())) {
      return { ok: false, error: `group "${gid}" has duplicate member "${login}"` };
    }
    seen.add(login.toLowerCase());
    members.push({ login, role });
  }
  if (members.length > 0 && !members.some((m) => m.role === "owner")) {
    return { ok: false, error: `group "${gid}" needs at least one owner` };
  }
  return { ok: true, members };
}

export function validateGroups(
  groups: unknown,
): { ok: true; groups: Group[] } | { ok: false; error: string } {
  if (!Array.isArray(groups)) return { ok: false, error: "groups must be an array" };
  if (groups.length > 100) return { ok: false, error: "too many groups" };

  const seen = new Set<string>();
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i] as Record<string, unknown>;
    if (!g || typeof g !== "object") return { ok: false, error: `group[${i}] is not an object` };
    if (typeof g.id !== "string" || !ID_RE.test(g.id)) {
      return { ok: false, error: `group[${i}].id is invalid` };
    }
    if (seen.has(g.id)) return { ok: false, error: `duplicate group id "${g.id}"` };
    seen.add(g.id);
    if (typeof g.name !== "string" || g.name.trim().length === 0) {
      return { ok: false, error: `group "${g.id}" needs a name` };
    }
    const mres = validateMembers(g, g.id);
    if (!mres.ok) return mres;
    // `members` is the single source of truth; adminIds stays in sync so
    // legacy consumers (isGroupAdmin, older UI) keep working.
    g.members = mres.members;
    g.adminIds = mres.members.filter((m) => m.role === "owner").map((m) => m.login);
    if (
      g.owners !== undefined &&
      (!Array.isArray(g.owners) ||
        !g.owners.every((o) => typeof o === "string" && o.trim().length > 0))
    ) {
      return { ok: false, error: `group "${g.id}".owners must be a list of strings` };
    }
    if (
      g.providers !== undefined &&
      (!Array.isArray(g.providers) ||
        !g.providers.every((p) => typeof p === "string" && ["github", "gitea"].includes(p)))
    ) {
      return {
        ok: false,
        error: `group "${g.id}".providers must be a list of "github" | "gitea"`,
      };
    }
    if (g.installationId !== undefined && g.installationId !== null) {
      if (typeof g.installationId !== "number" || !Number.isInteger(g.installationId)) {
        return { ok: false, error: `group "${g.id}".installationId must be an integer` };
      }
    } else {
      delete g.installationId;
    }
    if (g.emoji !== undefined && typeof g.emoji !== "boolean") {
      return { ok: false, error: `group "${g.id}".emoji must be a boolean` };
    }
    if (g.forgeSources !== undefined && g.forgeSources !== null) {
      if (!Array.isArray(g.forgeSources)) {
        return { ok: false, error: `group "${g.id}".forgeSources must be an array` };
      }
      if (g.forgeSources.length > 20) {
        return { ok: false, error: `group "${g.id}".forgeSources: too many sources` };
      }
      const seen = new Set<string>();
      const normalized: ForgeSource[] = [];
      for (let i = 0; i < g.forgeSources.length; i++) {
        const s = g.forgeSources[i] as Record<string, unknown>;
        if (!s || typeof s !== "object") {
          return { ok: false, error: `group "${g.id}".forgeSources[${i}] is not an object` };
        }
        if (typeof s.host !== "string" || !HOST_RE.test(s.host)) {
          return {
            ok: false,
            error: `group "${g.id}".forgeSources[${i}].host must be a valid hostname`,
          };
        }
        if (s.type !== "github" && s.type !== "gitea") {
          return {
            ok: false,
            error: `group "${g.id}".forgeSources[${i}].type must be "github" | "gitea"`,
          };
        }
        if (s.name !== undefined && (typeof s.name !== "string" || s.name.length > 50)) {
          return {
            ok: false,
            error: `group "${g.id}".forgeSources[${i}].name must be a string`,
          };
        }
        const key = `${s.type}:${s.host.toLowerCase()}`;
        if (seen.has(key)) {
          return { ok: false, error: `group "${g.id}".forgeSources has a duplicate source` };
        }
        seen.add(key);
        normalized.push({
          host: s.host.trim(),
          type: s.type,
          ...(s.name !== undefined && s.name.trim() ? { name: s.name.trim() } : {}),
        });
      }
      g.forgeSources = normalized;
    } else {
      delete g.forgeSources;
    }
    if (g.lang !== undefined && typeof g.lang !== "string") {
      return { ok: false, error: `group "${g.id}".lang must be a string` };
    }
    if (g.logTarget !== undefined && g.logTarget !== null) {
      if (typeof g.logTarget !== "object" || Array.isArray(g.logTarget)) {
        return { ok: false, error: `group "${g.id}".logTarget must be an object` };
      }
      const tgt = validateTarget(
        `group "${g.id}".logTarget`,
        g.logTarget as Record<string, unknown>,
      );
      if (!tgt.ok) return tgt;
      g.logTarget = tgt.target;
    } else {
      delete g.logTarget;
    }
  }
  return { ok: true, groups: groups as Group[] };
}

function ownerCount(members: GroupMember[]): number {
  return members.filter((m) => m.role === "owner").length;
}

function respondError(event: H3Event, status: number, error: string): Record<string, unknown> {
  setResponseStatus(event, status);
  return { error };
}

function accessError(
  event: H3Event,
  access: Extract<GroupAccess, { ok: false }>,
): Record<string, unknown> {
  return respondError(
    event,
    access.status,
    access.status === 404 ? "Group not found" : "Forbidden",
  );
}

/**
 * Read a JSON body, returning null when it is not valid JSON. h3's readBody
 * only parses `application/json` bodies; tolerate clients that omit the
 * Content-Type header (curl, older UI) by JSON-parsing the raw string.
 */
async function readJsonBody(event: H3Event): Promise<Record<string, unknown> | null> {
  try {
    const body = await readBody(event);
    if (typeof body === "string") {
      try {
        return JSON.parse(body) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return (body ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function webhookUrl(event: H3Event, groupId: string): string {
  const env = cfEnv(event);
  const origin = env.BASE_URL ?? getRequestOrigin(event);
  return `${origin.replace(/\/$/, "")}/webhook/${groupId}`;
}

function getRequestOrigin(event: H3Event): string {
  const proto = getHeader(event, "x-forwarded-proto") ?? "https";
  const host = getHeader(event, "host") ?? "localhost";
  return `${proto}://${host}`;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** GET /admin/login */
export async function adminLogin(event: H3Event): Promise<void> {
  if (isDebugMode(cfEnv(event))) {
    await sendRedirect(event, "/admin");
    return;
  }
  await sendRedirect(event, "/auth/github?redirect=/admin");
}

/** GET /admin/logout */
export async function adminLogout(event: H3Event): Promise<void> {
  const env = cfEnv(event);
  const session = await getAdminSession(env.KV, getHeader(event, "cookie"));
  if (session) {
    await recordAudit(env.DB, {
      ts: Date.now(),
      actorId: session.userId,
      actorLogin: session.login,
      action: "session.logout",
      ip: clientIp(event),
    });
  }
  await destroyAdminSession(env.KV, getHeader(event, "cookie"));
  setResponseHeader(event, "Set-Cookie", clearAdminCookie());
  await sendRedirect(event, "/admin");
}

/** GET /admin/invite?token=… */
export async function adminInvite(event: H3Event): Promise<void> {
  const env = cfEnv(event);
  const token = String(getQuery(event)["token"] ?? "");
  if (!token) {
    await sendRedirect(event, "/admin");
    return;
  }
  const session = await getAdminSession(env.KV, getHeader(event, "cookie"));
  if (!session) {
    await sendRedirect(
      event,
      `/auth/github?redirect=${encodeURIComponent(`/admin/invite?token=${token}`)}`,
    );
    return;
  }
  const result = await acceptInvite(env.KV, token, session.userId, session.login);
  if (result.ok) {
    await recordAudit(env.DB, {
      ts: Date.now(),
      actorId: session.userId,
      actorLogin: session.login,
      action: "invite.accept",
      targetType: "group",
      targetId: result.groupId,
      groupId: result.groupId,
      detail: { role: result.role },
      ip: clientIp(event),
    });
  }
  await sendRedirect(event, `/admin?invite=${result.ok ? "ok" : result.reason}`);
}

/** GET /admin/api/me */
export async function adminApiMe(event: H3Event): Promise<Record<string, unknown>> {
  const auth = await requireAnyAccess(event);
  const roles: Record<string, GroupRole> = {};
  for (const g of auth.scope.groups) {
    const role = roleAt(auth.scope, g.id);
    if (role) roles[g.id] = role;
  }
  return {
    login: auth.session.login,
    userId: auth.session.userId,
    isSuper: auth.scope.isSuper,
    groups: auth.scope.groups,
    roles,
  };
}

/** GET /admin/api/groups */
export async function adminApiGroupsGet(event: H3Event): Promise<Record<string, unknown>> {
  const auth = await requireAnyAccess(event);
  const roles: Record<string, GroupRole> = {};
  for (const g of auth.scope.groups) {
    const role = roleAt(auth.scope, g.id);
    if (role) roles[g.id] = role;
  }
  return { groups: auth.scope.groups, isSuper: auth.scope.isSuper, roles };
}

/** PUT /admin/api/groups */
export async function adminApiGroupsPut(event: H3Event): Promise<Record<string, unknown>> {
  const auth = await requireAnyAccess(event);
  const env = cfEnv(event);
  const body = await readJsonBody(event);
  if (!body) return respondError(event, 400, "Invalid JSON body");
  const result = validateGroups(body["groups"]);
  if (!result.ok) return respondError(event, 400, result.error);

  const existing = await loadGroups(env.KV);
  const prevById = new Map(existing.map((g) => [g.id, g]));
  let nextAll: Group[];

  if (auth.scope.isSuper) {
    // Super admins see and submit every group: full replace.
    nextAll = result.groups;
  } else {
    // Owners may only write groups they own. Preserve every other group and
    // never let a submission drop the last owner of a group.
    const mine = new Set<string>();
    for (const [gid, role] of auth.scope.roles) {
      if (role === "owner") mine.add(gid);
    }
    for (const g of result.groups) {
      if (!mine.has(g.id)) {
        return respondError(event, 403, `group "${g.id}" is outside your ownership`);
      }
      const members = g.members ?? normalizeGroupMembers(g);
      const stillMine = members.some(
        (m) =>
          m.role === "owner" && identityMatches([m.login], auth.session.userId, auth.session.login),
      );
      const otherOwner = ownerCount(members) > 1;
      if (!stillMine && !otherOwner) {
        return respondError(event, 403, `group "${g.id}" would be left without an owner by you`);
      }
    }
    nextAll = [
      ...existing.filter((g) => !mine.has(g.id)),
      ...result.groups.map((g) => {
        const prev = prevById.get(g.id);
        if (prev && prev.owners !== undefined && g.owners === undefined) {
          // Owners cannot edit the `owners` scope; keep the stored value.
          return { ...g, owners: prev.owners };
        }
        return g;
      }),
    ];
  }

  // Audit every create / update / delete.
  const prevGroups = existing;
  const nextById = new Map(nextAll.map((g) => [g.id, g]));
  const actor = { actorId: auth.session.userId, actorLogin: auth.session.login };
  for (const g of nextAll) {
    const prev = prevById.get(g.id);
    if (!prev) {
      await recordAudit(env.DB, {
        ts: Date.now(),
        ...actor,
        action: "group.create",
        targetType: "group",
        targetId: g.id,
        groupId: g.id,
        ip: clientIp(event),
      });
      continue;
    }
    const fields: string[] = [];
    if (prev.name !== g.name) fields.push("name");
    if (prev.emoji !== g.emoji) fields.push("emoji");
    if (prev.lang !== g.lang) fields.push("lang");
    if (!deepEqual(prev.logTarget, g.logTarget)) fields.push("logTarget");
    if (!deepEqual(prev.providers ?? [], g.providers ?? [])) fields.push("providers");
    if (prev.installationId !== g.installationId) fields.push("installationId");
    if (!deepEqual(prev.owners ?? [], g.owners ?? [])) fields.push("owners");
    if (!deepEqual(prev.members ?? normalizeGroupMembers(prev), g.members)) fields.push("members");
    if (fields.length > 0) {
      await recordAudit(env.DB, {
        ts: Date.now(),
        ...actor,
        action: "group.update",
        targetType: "group",
        targetId: g.id,
        groupId: g.id,
        detail: { fields },
        ip: clientIp(event),
      });
    }
  }
  for (const g of prevGroups) {
    if (!nextById.has(g.id)) {
      await recordAudit(env.DB, {
        ts: Date.now(),
        ...actor,
        action: "group.delete",
        targetType: "group",
        targetId: g.id,
        groupId: g.id,
        ip: clientIp(event),
      });
      await deleteTenantSecret(env.KV, g.id).catch(() => undefined);
    }
  }

  try {
    await saveGroups(env.KV, nextAll);
  } catch (err) {
    log.error({ err }, "Failed to save groups");
    return respondError(event, 500, "Failed to save groups");
  }
  log.info({ count: nextAll.length }, "Groups updated via admin UI");
  return { ok: true, count: nextAll.length };
}

/** GET /admin/api/routes */
export async function adminApiRoutesGet(event: H3Event): Promise<Record<string, unknown>> {
  const auth = await requireAnyAccess(event);
  const env = cfEnv(event);
  const all = await loadRoutes(env.KV);
  const routes = auth.scope.isSuper
    ? all
    : all.filter((r) => r.groupId != null && auth.scope.groupIds.has(r.groupId));
  return { routes };
}

/** PUT /admin/api/routes */
export async function adminApiRoutesPut(event: H3Event): Promise<Record<string, unknown>> {
  const auth = await requireAnyAccess(event);
  const env = cfEnv(event);
  const body = await readJsonBody(event);
  if (!body) return respondError(event, 400, "Invalid JSON body");
  const existing = await loadRoutes(env.KV);
  const unchanged = new Map(existing.map((r) => [r.id, r]));
  const result = validateRoutes(body["routes"], unchanged);
  if (!result.ok) return respondError(event, 400, result.error);

  let nextAll: Route[];

  if (auth.scope.isSuper) {
    // Super admins see and submit every route: full replace.
    nextAll = result.routes;
  } else {
    // Owners and admins may only write routes inside groups they manage.
    // Reject any submitted route that targets a group they cannot edit,
    // then splice their groups' routes in place while preserving all others.
    const writable = new Set<string>();
    for (const [gid, role] of auth.scope.roles) {
      if (role === "owner" || role === "admin") writable.add(gid);
    }
    for (const r of result.routes) {
      if (!r.groupId || !writable.has(r.groupId)) {
        return respondError(event, 403, `route "${r.id}" is outside your groups`);
      }
    }
    nextAll = [
      ...existing.filter((r) => !(r.groupId != null && writable.has(r.groupId))),
      ...result.routes,
    ];
  }

  try {
    await saveRoutes(env.KV, nextAll);
  } catch (err) {
    log.error({ err }, "Failed to save routes");
    return respondError(event, 500, "Failed to save routes");
  }
  await recordAudit(env.DB, {
    ts: Date.now(),
    actorId: auth.session.userId,
    actorLogin: auth.session.login,
    action: "routes.update",
    targetType: "routes",
    targetId: "all",
    detail: { count: nextAll.length },
    ip: clientIp(event),
  });
  log.info({ count: nextAll.length }, "Routes updated via admin UI");
  return { ok: true, count: nextAll.length };
}

/** GET /admin/api/logs */
export async function adminApiLogs(event: H3Event): Promise<Record<string, unknown>> {
  const auth = await requireAnyAccess(event);
  const env = cfEnv(event);
  const query = getQuery(event);
  const limit = Math.min(Math.max(Number(String(query["limit"] ?? "50")), 1), 100);
  const filterGroupId = String(query["groupId"] ?? "") || undefined;
  const allLogs = await getSendLog(env.DB, 200);
  const allowed = auth.scope.isSuper
    ? allLogs
    : allLogs.filter((l) => l.groupId != null && auth.scope.groupIds.has(l.groupId));
  const logs = filterGroupId ? allowed.filter((l) => l.groupId === filterGroupId) : allowed;
  return { logs: logs.slice(0, limit) };
}

/** GET /admin/api/logs/:id */
export async function adminApiLogsById(
  event: H3Event,
  id: number,
): Promise<Record<string, unknown>> {
  const auth = await requireAnyAccess(event);
  const env = cfEnv(event);
  if (!Number.isInteger(id) || id <= 0) return respondError(event, 400, "Invalid log id");
  const entry = await getSendLogById(env.DB, id);
  if (!entry) return respondError(event, 404, "Log entry not found");
  if (!auth.scope.isSuper) {
    if (!entry.groupId || !auth.scope.groupIds.has(entry.groupId)) {
      return respondError(event, 403, "Forbidden");
    }
  }
  return { log: entry };
}

/** GET /admin/api/groups/:groupId/routes */
export async function adminGroupRoutesGet(
  event: H3Event,
  groupId: string,
): Promise<Record<string, unknown>> {
  await requireAnyAccess(event);
  const env = cfEnv(event);
  const access = requireGroup(event, groupId);
  if (!access.ok) return accessError(event, access);
  const all = await loadRoutes(env.KV);
  return { group: access.group, routes: all.filter((r) => r.groupId === groupId) };
}

/** PUT /admin/api/groups/:groupId/routes */
export async function adminGroupRoutesPut(
  event: H3Event,
  groupId: string,
): Promise<Record<string, unknown>> {
  await requireAnyAccess(event);
  const env = cfEnv(event);
  const access = requireGroupRole(event, groupId, "admin");
  if (!access.ok) return accessError(event, access);

  const body = await readJsonBody(event);
  if (!body) return respondError(event, 400, "Invalid JSON body");

  // Force every submitted route into this group so the client never has to
  // carry a groupId; the path parameter is the single source of truth.
  const submitted = body["routes"];
  const scoped = Array.isArray(submitted)
    ? submitted.map((r) => ({ ...(r as Record<string, unknown>), groupId }))
    : submitted;
  const existing = await loadRoutes(env.KV);
  const unchanged = new Map(existing.map((r) => [r.id, r]));
  const result = validateRoutes(scoped, unchanged);
  if (!result.ok) return respondError(event, 400, result.error);

  // Replace only this group's routes; every other group is preserved untouched.
  const others = existing.filter((r) => r.groupId !== groupId);
  const nextAll = [...others, ...result.routes];

  try {
    await saveRoutes(env.KV, nextAll);
  } catch (err) {
    log.error({ err }, "Failed to save routes");
    return respondError(event, 500, "Failed to save routes");
  }
  const auth = currentAuth(event);
  await recordAudit(env.DB, {
    ts: Date.now(),
    actorId: auth.session.userId,
    actorLogin: auth.session.login,
    action: "group.routes.update",
    targetType: "group",
    targetId: groupId,
    groupId,
    detail: { count: result.routes.length },
    ip: clientIp(event),
  });
  log.info({ groupId, count: result.routes.length }, "Group routes updated via admin UI");
  return { ok: true, count: result.routes.length };
}

/** POST /admin/api/groups/:groupId/invites */
export async function adminGroupInvitesPost(
  event: H3Event,
  groupId: string,
): Promise<Record<string, unknown>> {
  await requireAnyAccess(event);
  const env = cfEnv(event);
  const access = requireGroupRole(event, groupId, "owner");
  if (!access.ok) return accessError(event, access);

  const body = await readJsonBody(event);
  if (!body) return respondError(event, 400, "Invalid JSON body");
  const role = body["role"];
  if (role !== "admin" && role !== "viewer") {
    return respondError(event, 400, 'role must be "admin" or "viewer"');
  }
  const note = body["note"];
  const auth = currentAuth(event);
  const token = await createInvite(env.KV, {
    groupId,
    role,
    expiresAt: Date.now() + 7 * 86400_000,
    createdBy: auth.session.login,
    note: typeof note === "string" && note.trim() ? note.trim() : undefined,
  });
  await recordAudit(env.DB, {
    ts: Date.now(),
    actorId: auth.session.userId,
    actorLogin: auth.session.login,
    action: "invite.create",
    targetType: "group",
    targetId: groupId,
    groupId,
    detail: { role },
    ip: clientIp(event),
  });
  return {
    ok: true,
    token,
    url: `/admin/invite?token=${token}`,
    expiresAt: Date.now() + 7 * 86400_000,
  };
}

/** GET /admin/api/groups/:groupId/invites */
export async function adminGroupInvitesGet(
  event: H3Event,
  groupId: string,
): Promise<Record<string, unknown>> {
  await requireAnyAccess(event);
  const env = cfEnv(event);
  const access = requireGroupRole(event, groupId, "owner");
  if (!access.ok) return accessError(event, access);
  const invites = await listInvites(env.KV, groupId);
  return { invites };
}

/** DELETE /admin/api/invites/:token */
export async function adminInviteDelete(
  event: H3Event,
  token: string,
): Promise<Record<string, unknown>> {
  await requireAnyAccess(event);
  const env = cfEnv(event);
  const invite = await getInvite(env.KV, token);
  if (!invite) return respondError(event, 404, "Invite not found");
  const access = requireGroupRole(event, invite.groupId, "owner");
  if (!access.ok) return respondError(event, 403, "Forbidden");
  await revokeInvite(env.KV, token);
  const auth = currentAuth(event);
  await recordAudit(env.DB, {
    ts: Date.now(),
    actorId: auth.session.userId,
    actorLogin: auth.session.login,
    action: "invite.revoke",
    targetType: "group",
    targetId: invite.groupId,
    groupId: invite.groupId,
    ip: clientIp(event),
  });
  return { ok: true };
}

/** PUT /admin/api/groups/:groupId/rename */
export async function adminGroupRename(
  event: H3Event,
  groupId: string,
): Promise<Record<string, unknown>> {
  await requireAnyAccess(event);
  const env = cfEnv(event);
  const access = requireGroupRole(event, groupId, "owner");
  if (!access.ok) return accessError(event, access);

  const body = await readJsonBody(event);
  if (!body) return respondError(event, 400, "Invalid JSON body");
  const newId = String(body["newId"] ?? "").trim();
  if (!ID_RE.test(newId)) return respondError(event, 400, "newId is invalid");
  if (newId === groupId) {
    return respondError(event, 400, "newId must differ from the current id");
  }
  const auth = currentAuth(event);
  const existing = await loadGroups(env.KV);
  if (existing.some((g) => g.id === newId)) {
    return respondError(event, 400, `group id "${newId}" already exists`);
  }

  // Re-point routes before saving the renamed group. The D1 group writer removes
  // routes belonging to group ids that disappear; doing this in the opposite
  // order would delete the old group's routes before they can be moved.
  const routes = await loadRoutes(env.KV);
  const touched = routes.filter((r) => r.groupId === groupId);
  if (touched.length > 0) {
    await saveRoutes(
      env.KV,
      routes.map((r) => (r.groupId === groupId ? { ...r, groupId: newId } : r)),
    );
  }

  const next = existing.map((g) => (g.id === groupId ? { ...g, id: newId } : g));
  try {
    await saveGroups(env.KV, next);
  } catch (err) {
    log.error({ err }, "Failed to save groups on rename");
    return respondError(event, 500, "Failed to save groups");
  }

  // Re-point fragments, the tenant webhook secret and pending invites.
  const fragments = await loadFragments(env.DB);
  const touchedFragments = fragments.filter((f) => f.groupId === groupId);
  if (touchedFragments.length > 0) {
    await saveFragments(
      env.DB,
      fragments.map((f) => (f.groupId === groupId ? { ...f, groupId: newId } : f)),
    );
  }
  const secret = await getTenantSecret(env.KV, groupId);
  if (secret) {
    await env.KV.put(`tenant:${newId}`, secret);
    await env.KV.delete(`tenant:${groupId}`);
  }
  await migrateInvites(env.KV, groupId, newId);

  await recordAudit(env.DB, {
    ts: Date.now(),
    actorId: auth.session.userId,
    actorLogin: auth.session.login,
    action: "group.rename",
    targetType: "group",
    targetId: newId,
    groupId: newId,
    detail: { from: groupId, to: newId, routes: touched.length },
    ip: clientIp(event),
  });
  log.info({ from: groupId, to: newId }, "Group renamed via admin UI");
  return { ok: true, id: newId };
}

/** GET /admin/api/groups/:groupId/webhook */
export async function adminGroupWebhookGet(
  event: H3Event,
  groupId: string,
): Promise<Record<string, unknown>> {
  await requireAnyAccess(event);
  const env = cfEnv(event);
  const access = requireGroupRole(event, groupId, "owner");
  if (!access.ok) return accessError(event, access);
  return {
    url: webhookUrl(event, groupId),
    hasSecret: (await getTenantSecret(env.KV, groupId)) != null,
  };
}

/** POST /admin/api/groups/:groupId/webhook/regenerate */
export async function adminGroupWebhookRegenerate(
  event: H3Event,
  groupId: string,
): Promise<Record<string, unknown>> {
  await requireAnyAccess(event);
  const env = cfEnv(event);
  const access = requireGroupRole(event, groupId, "owner");
  if (!access.ok) return accessError(event, access);
  const secret = await setTenantSecret(env.KV, groupId);
  const auth = currentAuth(event);
  await recordAudit(env.DB, {
    ts: Date.now(),
    actorId: auth.session.userId,
    actorLogin: auth.session.login,
    action: "webhook.secret.regenerate",
    targetType: "group",
    targetId: groupId,
    groupId,
    ip: clientIp(event),
  });
  return { ok: true, url: webhookUrl(event, groupId), secret };
}

/** DELETE /admin/api/groups/:groupId/webhook */
export async function adminGroupWebhookDelete(
  event: H3Event,
  groupId: string,
): Promise<Record<string, unknown>> {
  await requireAnyAccess(event);
  const env = cfEnv(event);
  const access = requireGroupRole(event, groupId, "owner");
  if (!access.ok) return accessError(event, access);
  await deleteTenantSecret(env.KV, groupId);
  const auth = currentAuth(event);
  await recordAudit(env.DB, {
    ts: Date.now(),
    actorId: auth.session.userId,
    actorLogin: auth.session.login,
    action: "webhook.secret.delete",
    targetType: "group",
    targetId: groupId,
    groupId,
    ip: clientIp(event),
  });
  return { ok: true };
}

/** GET /admin/api/audit */
export async function adminAudit(event: H3Event): Promise<Record<string, unknown>> {
  const auth = await requireAnyAccess(event);
  const env = cfEnv(event);
  const query = getQuery(event);
  const limit = Math.min(Math.max(Number(String(query["limit"] ?? "50")), 1), 200);
  const groupId = String(query["groupId"] ?? "") || undefined;
  if (groupId && !auth.scope.isSuper && !auth.scope.groupIds.has(groupId)) {
    return respondError(event, 403, "Forbidden");
  }
  const entries = await getAuditLog(env.DB, { groupId, limit });
  const visible = auth.scope.isSuper
    ? entries
    : entries.filter((e) => e.groupId != null && auth.scope.groupIds.has(e.groupId));
  return { audit: visible };
}

/** GET /admin/api/metrics */
export async function adminApiMetrics(event: H3Event): Promise<Record<string, unknown>> {
  const auth = await requireAnyAccess(event);
  const env = cfEnv(event);
  const query = getQuery(event);
  const groupId = String(query["groupId"] ?? "") || undefined;
  if (groupId && !auth.scope.isSuper && !auth.scope.groupIds.has(groupId)) {
    return respondError(event, 403, "Forbidden");
  }
  const metrics = await getDeliveryMetrics(env.DB, groupId);
  if (auth.scope.isSuper) return { metrics };
  return {
    metrics: {
      ...metrics,
      recentFailures: metrics.recentFailures.filter(
        (f) => f.groupId != null && auth.scope.groupIds.has(f.groupId),
      ),
    },
  };
}

/** GET /admin/api/delivery/:deliveryId */
export async function adminApiDelivery(
  event: H3Event,
  deliveryId: string,
): Promise<Record<string, unknown>> {
  const auth = await requireAnyAccess(event);
  const env = cfEnv(event);
  const rows = await getSendLogByDelivery(env.DB, deliveryId);
  if (rows.length === 0) return respondError(event, 404, "Delivery not found");
  if (
    !auth.scope.isSuper &&
    rows.some((r) => r.groupId == null || !auth.scope.groupIds.has(r.groupId))
  ) {
    return respondError(event, 403, "Forbidden");
  }
  return { deliveryId, attempts: rows };
}

function validateFragments(
  fragments: unknown,
  groupId: string,
): { ok: true; fragments: NamedFragment[] } | { ok: false; error: string } {
  if (!Array.isArray(fragments)) return { ok: false, error: "fragments must be an array" };
  if (fragments.length > 200) return { ok: false, error: "too many fragments" };
  const seen = new Set<string>();
  const out: NamedFragment[] = [];
  for (let i = 0; i < fragments.length; i++) {
    const f = fragments[i] as Record<string, unknown>;
    if (!f || typeof f !== "object") return { ok: false, error: `fragment[${i}] is not an object` };
    if (typeof f.id !== "string" || !ID_RE.test(f.id)) {
      return { ok: false, error: `fragment[${i}].id is invalid` };
    }
    if (seen.has(f.id)) return { ok: false, error: `duplicate fragment id "${f.id}"` };
    seen.add(f.id);
    if (typeof f.name !== "string" || f.name.trim().length === 0) {
      return { ok: false, error: `fragment "${f.id}" needs a name` };
    }
    const err = validateFilterNode(f.node, `fragment "${f.id}".node`);
    if (err) return { ok: false, error: err };
    out.push({ id: f.id, groupId, name: f.name, node: f.node as FilterNode });
  }
  return { ok: true, fragments: out };
}

/** GET /admin/api/groups/:groupId/fragments */
export async function adminGroupFragmentsGet(
  event: H3Event,
  groupId: string,
): Promise<Record<string, unknown>> {
  await requireAnyAccess(event);
  const env = cfEnv(event);
  const access = requireGroup(event, groupId);
  if (!access.ok) return accessError(event, access);
  const all = await loadFragments(env.DB);
  return { group: access.group, fragments: all.filter((f) => f.groupId === groupId) };
}

/** PUT /admin/api/groups/:groupId/fragments */
export async function adminGroupFragmentsPut(
  event: H3Event,
  groupId: string,
): Promise<Record<string, unknown>> {
  await requireAnyAccess(event);
  const env = cfEnv(event);
  const access = requireGroupRole(event, groupId, "admin");
  if (!access.ok) return accessError(event, access);

  const body = await readJsonBody(event);
  if (!body) return respondError(event, 400, "Invalid JSON body");

  const submitted = body["fragments"];
  const result = validateFragments(submitted, groupId);
  if (!result.ok) return respondError(event, 400, result.error);

  const existing = await loadFragments(env.DB);
  const others = existing.filter((f) => f.groupId !== groupId);
  const nextAll = [...others, ...result.fragments];

  try {
    await saveFragments(env.DB, nextAll);
  } catch (err) {
    log.error({ err }, "Failed to save fragments");
    return respondError(event, 500, "Failed to save fragments");
  }
  const auth = currentAuth(event);
  await recordAudit(env.DB, {
    ts: Date.now(),
    actorId: auth.session.userId,
    actorLogin: auth.session.login,
    action: "group.fragments.update",
    targetType: "group",
    targetId: groupId,
    groupId,
    detail: { count: result.fragments.length },
    ip: clientIp(event),
  });
  return { ok: true, count: result.fragments.length };
}

/** POST /admin/api/test-match */
export async function adminApiTestMatch(event: H3Event): Promise<Record<string, unknown>> {
  await requireAnyAccess(event);
  const body = await readJsonBody(event);
  if (!body) return respondError(event, 400, "Invalid JSON body");

  const rawNode =
    body["node"] ?? (Array.isArray(body["filters"]) ? { all: body["filters"] } : undefined);
  if (rawNode === undefined) return respondError(event, 400, "Missing filter node");
  const err = validateFilterNode(rawNode, "node");
  if (err) return respondError(event, 400, err);

  const payload = body["payload"];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return respondError(event, 400, "Missing payload object");
  }
  const eventName =
    typeof body["event"] === "string" && body["event"].trim() ? body["event"].trim() : "custom";
  const webhookEvent = { event: eventName, payload: payload as Record<string, unknown> };
  let matched = false;
  try {
    matched = evaluateFilterNode(rawNode as FilterNode, webhookEvent);
  } catch (e) {
    return respondError(event, 400, `Failed to evaluate: ${String(e)}`);
  }
  return { matched, explanation: explainFilterNode(rawNode as FilterNode) };
}
