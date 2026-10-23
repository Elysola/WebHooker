import type { H3Event } from "h3";
import {
  getHeader,
  getQuery,
  readBody,
  sendRedirect,
  setResponseHeader,
  setResponseStatus,
} from "h3";
import type {
  Config,
  Env,
  Route,
  RouteTarget,
  Group,
  GroupMember,
  GroupRole,
  ForgeSource,
  Filter,
  FilterNode,
} from "../types";
import { loadConfigSnapshot, loadRoutes, saveGroupRoutes } from "../config";
import {
  ConfigConflictError,
  groupVersion,
  type LifecycleStatements,
} from "../storage/config-store";
import { canUseD1 } from "../storage/d1";
import { getToken } from "../github/store";
import { resolveGitHubUserId } from "../github/oauth";
import { loadFragments, saveGroupFragments, type NamedFragment } from "../fragments";
import {
  evaluateFilterNode,
  explainFilterNode,
  filterNodeWellFormed,
  filterPatternsUsable,
  regexSafetyIssue,
} from "../events/filter-ast";
import {
  authLogin,
  getAdminSession,
  destroyAdminSession,
  clearAdminCookie,
  isDebugMode,
} from "./session";
import {
  loadGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  renameGroup,
  carryMemberIds,
  memberMatches,
  memberRole,
  memberRoleStatement,
  roleAtLeast,
  isIsolated,
  normalizeGroupMembers,
} from "./groups";
import {
  deleteLifecycle,
  isGroupIdRetired,
  recordGroupRename,
  renameLifecycle,
  retireGroupId,
} from "./group-lifecycle";
import {
  requireAnyAccess,
  currentAuth,
  requireGroup,
  requireGroupRole,
  roleAt,
  canEditRoutes,
  clientIp,
  type GroupAccess,
} from "./auth";
import { getSendLog, getSendLogById, getSendLogByDelivery, type GroupScope } from "../lib/send-log";
import { getDeliveryMetrics } from "../observability/metrics";
import { getAuditLog, recordAudit } from "../lib/audit";
import {
  createInvite,
  listInvites,
  revokeInvite,
  getInvite,
  acceptInvite,
  migrateInvites,
  deleteGroupInvites,
  INVITE_LIFETIME_MS,
} from "./invites";
import {
  getTenantSecret,
  rotateTenantSecret,
  removeTenantSecret,
  deleteTenantSecret,
} from "./tenants";
import { cfEnv } from "../cf";
import { log } from "../lib/log";
import { MAX_ROLE_MENTIONS } from "../drivers/discord/render";
import { destinationOf } from "../drivers";

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
/** Discord snowflake: anything else could inject text or mentions into `content`. */
const SNOWFLAKE_RE = /^\d{15,25}$/;
const HOST_RE =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;

/** Key of a route within the whole configuration: ids are unique per group. */
function routeKey(groupId: string | undefined, id: string): string {
  return `${groupId ?? ""}\u0000${id}`;
}

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
  // One kind per node (a leaf, or a single all/any/not), all the way down.
  if (!filterNodeWellFormed(node)) return `${label} mixes condition kinds or is malformed`;
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
  // A keyword condition always searches the payload (`eq`, the default):
  // any other operator would be saved and silently ignored.
  if (n.type === "keyword" && n.op !== undefined && n.op !== "eq") {
    return `${label}.op is not supported for keyword filters`;
  }
  if ((n.op as string) !== "exists" && !isValidMatch(n.match)) {
    return `${label} needs a match value`;
  }
  // `exists` reads no value; one given anyway must still be one the stored
  // schema accepts, or the saved route could not be read back.
  if ((n.op as string) === "exists" && n.match !== undefined && !isValidMatch(n.match)) {
    return `${label}.match must be omitted (or a value) for exists`;
  }
  if ((n.op as string) !== "exists") {
    const patterns = Array.isArray(n.match) ? (n.match as string[]) : [n.match as string];
    for (const p of patterns) {
      // Only where the matcher reads a regex: `regex`, or a `/…/` value of an
      // equality / keyword condition (`contains` & co. compare literally).
      const op = n.type === "keyword" ? "keyword" : ((n.op as string | undefined) ?? "eq");
      const wrapped = p.length >= 2 && p.startsWith("/") && p.endsWith("/");
      const source =
        op === "regex"
          ? p
          : wrapped && ["eq", "in", "ne", "keyword"].includes(op)
            ? p.slice(1, -1)
            : null;
      const issue = source !== null ? regexSafetyIssue(source) : null;
      if (issue) return `${label} has an unsafe regex ${JSON.stringify(p)}: ${issue}`;
    }
    // Read back, the route must run exactly as saved (e.g. no glob over the
    // length the matcher compiles).
    if (!filterPatternsUsable(n as unknown as Filter)) {
      return `${label} has a pattern that cannot be used (too long or invalid)`;
    }
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
export function validateRoutes(
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
    const prev = unchanged?.get(routeKey(r.groupId as string | undefined, r.id));
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
        !r.discordRoleIds.every((d) => typeof d === "string" && SNOWFLAKE_RE.test(d)))
    ) {
      return {
        ok: false,
        error: `route "${r.id}".discordRoleIds must be a list of Discord role ids`,
      };
    }
    // Saved, more could never be sent: the message would exceed Discord's
    // content and allowed-mention limits.
    if (r.discordRoleIds && new Set(r.discordRoleIds).size > MAX_ROLE_MENTIONS) {
      return {
        ok: false,
        error: `route "${r.id}" mentions more than ${MAX_ROLE_MENTIONS} Discord roles`,
      };
    }
    if (!Array.isArray(r.filters)) {
      return { ok: false, error: `route "${r.id}".filters must be an array` };
    }
    if (r.fallback !== true && r.filters.length === 0 && r.ast === undefined) {
      return { ok: false, error: `route "${r.id}" needs at least one filter` };
    }
    for (let j = 0; j < r.filters.length; j++) {
      const f = r.filters[j] as Record<string, unknown> | null;
      // The flat list holds plain conditions only (all/any/not belong in
      // `ast`): stored otherwise, the route could not be read back.
      if (f && typeof f === "object" && ("all" in f || "any" in f || "not" in f)) {
        return { ok: false, error: `route "${r.id}" filter[${j}] must be a plain condition` };
      }
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
      // The same destination twice would get every message twice.
      const destinations = new Set<string>();
      for (let j = 0; j < rawTargets.length; j++) {
        const t = rawTargets[j] as Record<string, unknown>;
        if (!t || typeof t !== "object") {
          return { ok: false, error: `route "${r.id}".targets[${j}] is not an object` };
        }
        const result = validateTarget(`route "${r.id}".targets[${j}]`, t);
        if (!result.ok) return result;
        const destination = destinationOf(result.target);
        if (destinations.has(destination)) {
          return { ok: false, error: `route "${r.id}".targets[${j}] repeats another target` };
        }
        destinations.add(destination);
        normalized.push(result.target);
      }
      (r as Record<string, unknown>).targets = normalized;
    } else {
      return { ok: false, error: `route "${r.id}" needs a targets array` };
    }
  }
  return { ok: true, routes: routes as Route[] };
}

/**
 * Discord ids are snowflakes (digits); the check rules out everything that
 * could change the meaning of a URL path (`/`, `.`, `%`, ...).
 */
const DISCORD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Canonical only (no leading zeros, no "-0": Telegram reads `-0100` as
 * `-100`) and within the range chat ids actually use — a longer number wraps
 * around in Telegram's 64-bit parsing and could land on any chat.
 */
const TELEGRAM_CHAT_ID_RE = /^(?:0|-?[1-9]\d{0,14})$/;

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
    // A topic is a message thread id: a positive 32-bit integer, written one
    // way only (`01` or `1e0` would name topic 1 again, `abc` none at all).
    const topic = typeof target.topicId === "string" ? target.topicId.trim() : "";
    if (
      platform === "telegram" &&
      topic &&
      !(/^[1-9]\d{0,9}$/.test(topic) && Number(topic) <= 2_147_483_647)
    ) {
      return { ok: false, error: `${label}.topicId must be a topic id (a positive integer)` };
    }
    // Telegram also takes a public chat's `@username`, a second name for the
    // same chat: only the numeric id is accepted, so the cross-group channel
    // check compares one spelling per chat.
    if (platform === "telegram" && !TELEGRAM_CHAT_ID_RE.test(target.chatId.trim())) {
      return { ok: false, error: `${label}.chatId must be a numeric Telegram chat id` };
    }
  } else {
    if (typeof target.channelId !== "string" || target.channelId.trim().length === 0)
      return { ok: false, error: `${label}.channelId is required` };
    if (target.threadId !== undefined && typeof target.threadId !== "string") {
      return { ok: false, error: `${label}.threadId must be a string` };
    }
    // One canonical spelling per channel (Discord ids are snowflakes): the
    // cross-group channel check and the delivery ledger compare these
    // strings, so no alias (`x/../123`, `%31...`) may stand for a channel.
    for (const field of ["channelId", "threadId"] as const) {
      const id = target[field];
      // A snowflake has no leading zeros either: `0123` would be read as `123`.
      if (
        typeof id === "string" &&
        id.trim() &&
        (!DISCORD_ID_RE.test(id.trim()) || /^0\d/.test(id.trim()))
      ) {
        return { ok: false, error: `${label}.${field} must be a Discord id` };
      }
    }
  }
  return {
    ok: true,
    target: {
      platform,
      channelId: platform === "discord" ? (target.channelId as string).trim() : undefined,
      threadId:
        platform === "discord"
          ? (target.threadId as string | undefined)?.trim() || undefined
          : undefined,
      chatId:
        platform === "telegram" || platform === "feishu"
          ? (target.chatId as string).trim()
          : undefined,
      topicId:
        platform === "telegram"
          ? (target.topicId as string | undefined)?.trim() || undefined
          : undefined,
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
        !g.providers.every(
          (p) => typeof p === "string" && ["github", "gitea", "custom"].includes(p),
        ))
    ) {
      return {
        ok: false,
        error: `group "${g.id}".providers must be a list of "github" | "gitea" | "custom"`,
      };
    }
    if (g.installationId !== undefined && g.installationId !== null) {
      if (typeof g.installationId !== "number" || !Number.isInteger(g.installationId)) {
        return { ok: false, error: `group "${g.id}".installationId must be an integer` };
      }
    } else {
      delete g.installationId;
    }
    if (g.isolated !== undefined && typeof g.isolated !== "boolean") {
      return { ok: false, error: `group "${g.id}".isolated must be a boolean` };
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
  return { ok: true, groups: (groups as Record<string, unknown>[]).map(sanitizeGroup) };
}

/** Keep only the known group fields (in a stable order); drops `revision` and junk. */
function sanitizeGroup(g: Record<string, unknown>): Group {
  const out: Record<string, unknown> = {};
  for (const key of GROUP_FIELDS) {
    if (g[key] !== undefined) out[key] = g[key];
  }
  return out as unknown as Group;
}

const GROUP_FIELDS = [
  "id",
  "name",
  "adminIds",
  "members",
  "owners",
  "providers",
  "installationId",
  "isolated",
  "emoji",
  "forgeSources",
  "lang",
  "logTarget",
] as const;

/** Fields only super admins may change: they bound where a group's events come from. */
function keepSuperOnlyFields(next: Group, prev: Group | undefined): Group {
  const out: Group = { ...next };
  delete out.owners;
  delete out.installationId;
  delete out.isolated;
  if (prev?.owners !== undefined) out.owners = prev.owners;
  if (prev?.installationId !== undefined) out.installationId = prev.installationId;
  if (prev?.isolated !== undefined) out.isolated = prev.isolated;
  return sanitizeGroup(out as unknown as Record<string, unknown>);
}

/** Opaque content revision: equal revisions mean equal stored data. */
/** JSON with object keys sorted: equal data hashes equal whatever the key order. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

async function revisionOf(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(value)));
  return Array.from(new Uint8Array(digest).slice(0, 12))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Revision of a route list over the stored fields only, independent of key order or absent optionals. */
function routesRevision(routes: Route[]): Promise<string> {
  return revisionOf(
    routes.map((r) => ({
      id: r.id,
      groupId: r.groupId ?? "",
      name: r.name,
      enabled: !!r.enabled,
      filters: r.filters ?? [],
      targets: r.targets ?? [],
      stop: !!r.stop,
      fallback: !!r.fallback,
      discordRoleIds: r.discordRoleIds ?? null,
      ast: r.ast ?? null,
    })),
  );
}

/**
 * Groups as clients see them: the editable fields plus a revision. Server-owned
 * identity (`instance`, `legacyId`, ...) never leaves the server, and so can
 * never come back in a submission either.
 */
async function withRevisions(groups: Group[]): Promise<Group[]> {
  return Promise.all(
    groups.map(async (g) => {
      const shown = sanitizeGroup({ ...g });
      return { ...shown, revision: await groupRevision(g) };
    }),
  );
}

/**
 * A group's revision: the fields clients see, plus its instance hashed in
 * (never shown) — a view of a deleted group never confirms a write to a later
 * group that reused its id, however alike the two look.
 */
function groupRevision(g: Group, instance = g.instance): Promise<string> {
  return revisionOf({ group: sanitizeGroup({ ...g }), instance: instance ?? null });
}

function submittedRevision(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function ownerCount(members: GroupMember[]): number {
  return members.filter((m) => m.role === "owner").length;
}

/** The platform channels a target posts into (a Discord thread is a channel too). */
function targetChannels(t: RouteTarget): string[] {
  const platform = t.platform ?? "discord";
  const ids = platform === "discord" ? [t.channelId, t.threadId] : [t.chatId];
  return ids.filter((id): id is string => !!id).map((id) => `${platform}:${id}`);
}

/**
 * A statement that aborts its transaction while a group outside `allowed`
 * delivers to `channel` (`platform:id`) through a route or its log target.
 * Run inside the write itself, it makes "the channel is free" hold at commit:
 * D1 transactions are serialized, so of two groups claiming one new channel
 * at once, the second sees the first's committed rows and fails.
 */
export function channelFreeGuard(
  db: D1Database,
  channel: string,
  allowed: string[],
): D1PreparedStatement {
  const sep = channel.indexOf(":");
  const platform = channel.slice(0, sep);
  const id = channel.slice(sep + 1);
  // One JSON parameter, however many groups: D1 binds at most 100 per statement.
  const notAllowed = "SELECT value FROM json_each(?)";
  return db
    .prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM (SELECT group_id, CASE WHEN json_valid(targets) THEN targets ELSE '[]' END AS targets FROM d1_routes) r, json_each(r.targets) t
         WHERE r.group_id NOT IN (${notAllowed})
           AND coalesce(json_extract(t.value, '$.platform'), 'discord') = ?
           AND ? IN (json_extract(t.value, '$.channelId'), json_extract(t.value, '$.threadId'),
                     json_extract(t.value, '$.chatId'))
       ) OR EXISTS (
         SELECT 1 FROM (SELECT id, CASE WHEN json_valid(data) THEN data ELSE '{}' END AS data FROM d1_groups) g
         WHERE g.id NOT IN (${notAllowed})
           AND json_extract(g.data, '$.logTarget') IS NOT NULL
           AND coalesce(json_extract(g.data, '$.logTarget.platform'), 'discord') = ?
           AND ? IN (json_extract(g.data, '$.logTarget.channelId'),
                     json_extract(g.data, '$.logTarget.threadId'),
                     json_extract(g.data, '$.logTarget.chatId'))
       ) THEN json('channel taken') ELSE 1 END AS ok`,
    )
    .bind(JSON.stringify(allowed), platform, id, JSON.stringify(allowed), platform, id);
}

/**
 * A guard statement that aborts the write unless the signed-in user still
 * holds at least `min` in group `gid` at commit time (super admins need none):
 * a request authorized before an owner removed the user must not land after.
 * Member entries match the way `memberMatches` does: a bound entry by user id,
 * an all-digit one by user id, any other by (trusted) login; groups still on
 * legacy `adminIds` count those as owners.
 */
export function roleGuard(
  event: H3Event,
  gid: string,
  min: "admin" | "owner",
): LifecycleStatements | undefined {
  const auth = currentAuth(event);
  if (auth.scope.isSuper) return undefined;
  const roles: GroupRole[] = min === "owner" ? ["owner"] : ["owner", "admin"];
  return (db) => [
    memberRoleStatement(db, gid, auth.session.userId, authLogin(auth.session), roles),
  ];
}

/** Both guard lists, in order (either may be absent). */
function bothGuards(
  a: LifecycleStatements | undefined,
  b: LifecycleStatements | undefined,
): LifecycleStatements | undefined {
  if (!a) return b;
  if (!b) return a;
  return (db) => [...a(db), ...b(db)];
}

/** Whether the signed-in user still holds `min` in this (current) group. */
function stillHolds(event: H3Event, group: Group, min: GroupRole): boolean {
  const auth = currentAuth(event);
  if (auth.scope.isSuper) return true;
  return roleAtLeast(memberRole(group, auth.session.userId, authLogin(auth.session)), min);
}

/** A route target (by route id) or the group's log target (`@log`) being written. */
interface TargetRef {
  ref: string;
  target: RouteTarget;
}

/** The targets a group's route list refers to, each tagged with its route. */
function routeTargetRefs(routes: Route[]): TargetRef[] {
  return routes.flatMap((r) => (r.targets ?? []).map((target) => ({ ref: r.id, target })));
}

/**
 * Numeric ids of the Telegram `@username` targets still stored from before
 * only numeric ids were accepted (a username and the chat's id name the same
 * chat). Looked up with the bot; null when the lookup fails.
 */
async function telegramAliases(
  env: Env,
  routes: Route[],
  groups: Group[],
): Promise<Map<string, string | null>> {
  const names = new Set<string>();
  const note = (t: RouteTarget | undefined): void => {
    if (t?.platform === "telegram" && t.chatId?.startsWith("@")) names.add(t.chatId);
  };
  for (const r of routes) for (const t of r.targets ?? []) note(t);
  for (const g of groups) note(g.logTarget);
  const out = new Map<string, string | null>();
  for (const name of names) {
    let id: string | null = null;
    if (env.TELEGRAM_TOKEN) {
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/getChat?chat_id=${encodeURIComponent(name)}`,
          { signal: AbortSignal.timeout(5000) },
        );
        const data = (await res.json().catch(() => null)) as { result?: { id?: number } } | null;
        if (res.ok && typeof data?.result?.id === "number") id = String(data.result.id);
      } catch {
        id = null;
      }
    }
    out.set(name, id);
  }
  return out;
}

/**
 * Whether a non-super writer may point group `gid` at these targets. The bot
 * posts with the operator's credentials, so a tenant must not aim it at a
 * channel another group already delivers to — that channel belongs to someone
 * else — unless the writer may edit that group's routes as well. A channel
 * already shared before this write (older data) stays allowed only where it
 * already was — the same route, or the log target — so an unchanged save never
 * fails but the sharing never grows. `issue` explains a refusal now; `guards`
 * re-check, inside the write, that unshared channels are still unshared.
 */
async function foreignTargetIssue(
  event: H3Event,
  gid: string,
  refs: TargetRef[],
  snapshot?: { config: Config; groups: Group[] },
): Promise<{ issue: string | null; guards?: LifecycleStatements; keepsShared?: boolean }> {
  const auth = currentAuth(event);
  if (auth.scope.isSuper) return { issue: null };
  const env = cfEnv(event);
  // The caller's own fresh read when it has one (one snapshot per request).
  const { config, groups } = snapshot ?? (await loadConfigSnapshot(env, { fresh: true }));
  const routes = config.routes;
  // One spelling per chat: stored usernames are compared by their chat id —
  // only needed when this write delivers to Telegram (a lookup per stored
  // username is a request to the Bot API; other platforms' channels never
  // compare with Telegram ones).
  const aliases = refs.some(({ target }) => target.platform === "telegram")
    ? await telegramAliases(env, routes, groups)
    : new Map<string, string | null>();
  const unresolved = [...aliases.values()].some((id) => id === null);
  // Stored ids from before the stricter check are read the way Telegram
  // reads them (leading zeros dropped, wrapped to 64 bits).
  const channelsOf = (t: RouteTarget): string[] =>
    targetChannels(t).map((c) => {
      const name = c.startsWith("telegram:@") ? c.slice("telegram:".length) : null;
      const id = name ? aliases.get(name) : null;
      if (id) return `telegram:${id}`;
      const numeric = /^telegram:(-?\d+)$/.exec(c);
      return numeric ? `telegram:${BigInt.asIntN(64, BigInt(numeric[1]!)).toString()}` : c;
    });
  // A destination within a channel (a Telegram topic, a Discord thread).
  const placeOf = (t: RouteTarget): string => t.topicId ?? t.threadId ?? "";
  const channelsOfGroup = (g: Group): Set<string> => {
    const out = new Set<string>();
    for (const r of routes) {
      if (r.groupId === g.id)
        for (const t of r.targets ?? []) channelsOf(t).forEach((c) => out.add(c));
    }
    if (g.logTarget) channelsOf(g.logTarget).forEach((c) => out.add(c));
    return out;
  };
  // Where this group already delivers: `{route id | @log}|{channel}|{place}`.
  const ownRefs = new Set<string>();
  const addOwn = (ref: string, t: RouteTarget): void =>
    channelsOf(t).forEach((c) => ownRefs.add(`${ref}|${c}|${placeOf(t)}`));
  for (const r of routes) {
    if (r.groupId !== gid) continue;
    for (const t of r.targets ?? []) addOwn(r.id, t);
  }
  const self = groups.find((g) => g.id === gid);
  if (self?.logTarget) addOwn("@log", self.logTarget);

  // Channels this write delivers to.
  const written = new Set(refs.flatMap(({ target }) => channelsOf(target)));
  // Other groups let through because the writer may edit them too — exactly
  // those whose channels this write touches, and each re-checked at commit
  // (the same set the commit-time channel check exempts, nothing more).
  const vouching = groups.filter(
    (g) =>
      g.id !== gid &&
      canEditRoutes(auth.scope, g.id) &&
      [...channelsOfGroup(g)].some((c) => written.has(c)),
  );
  const allowed = [gid, ...vouching.map((g) => g.id)];
  const others = groups.filter((g) => !allowed.includes(g.id)).map(channelsOfGroup);
  const guarded = new Set<string>();
  let keepsShared = false;
  for (const { ref, target } of refs) {
    for (const channel of channelsOf(target)) {
      const kept = ownRefs.has(`${ref}|${channel}|${placeOf(target)}`);
      // A legacy username that cannot be resolved might be this very chat.
      if (unresolved && channel.startsWith("telegram:") && !kept) {
        return { issue: "Telegram targets cannot be verified right now; try again later" };
      }
      if (!others.some((set) => set.has(channel))) guarded.add(channel);
      else if (!kept) {
        return { issue: `target ${channel} is already used by another group` };
      } else keepsShared = true;
    }
  }
  // A kept shared channel is allowed only because the reference is still
  // there: the caller must commit against the version this check saw
  // (`keepsShared`), so a reference removed meanwhile is not restored.
  if (guarded.size === 0 && vouching.length === 0) return { issue: null, keepsShared };
  return {
    issue: null,
    keepsShared,
    guards: (db) => [
      ...[...guarded].map((c) => channelFreeGuard(db, c, allowed)),
      ...vouching.flatMap((g) => roleGuard(event, g.id, "admin")?.(db) ?? []),
    ],
  };
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
  const session = await getAdminSession(env.KV, getHeader(event, "cookie"), env.DB);
  if (session) {
    await recordAudit(env.DB, {
      ts: Date.now(),
      actorId: session.userId,
      actorLogin: session.login,
      action: "session.logout",
      ip: clientIp(event),
    });
  }
  await destroyAdminSession(env.KV, getHeader(event, "cookie"), env.DB);
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
  const session = await getAdminSession(env.KV, getHeader(event, "cookie"), env.DB);
  if (!session) {
    await sendRedirect(
      event,
      `/auth/github?redirect=${encodeURIComponent(`/admin/invite?token=${token}`)}`,
    );
    return;
  }
  const result = await acceptInvite(env, token, session.userId, session.login, authLogin(session));
  if (result.ok) {
    await recordAudit(env.DB, {
      ts: Date.now(),
      actorId: session.userId,
      actorLogin: session.login,
      action: "invite.accept",
      targetType: "group",
      targetId: result.groupId,
      groupId: result.groupId,
      groupInstance: result.groupInstance,
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
    groups: await withRevisions(auth.scope.groups),
    roles,
  };
}

/** Revision of a whole group list (ids and contents), for the bulk write. */
async function listRevision(groups: Group[]): Promise<string> {
  const withRev = await withRevisions(groups);
  return revisionOf(withRev.map((g) => [g.id, g.revision]).sort());
}

/** GET /admin/api/groups */
export async function adminApiGroupsGet(event: H3Event): Promise<Record<string, unknown>> {
  const auth = await requireAnyAccess(event);
  const roles: Record<string, GroupRole> = {};
  for (const g of auth.scope.groups) {
    const role = roleAt(auth.scope, g.id);
    if (role) roles[g.id] = role;
  }
  return {
    groups: await withRevisions(auth.scope.groups),
    revision: await listRevision(auth.scope.groups),
    isSuper: auth.scope.isSuper,
    roles,
  };
}

/** Audit a group create / update by comparing it with its previous version. */
async function auditGroupChange(
  event: H3Event,
  prev: Group | undefined,
  next: Group,
): Promise<void> {
  const env = cfEnv(event);
  const auth = currentAuth(event);
  const base = {
    ts: Date.now(),
    actorId: auth.session.userId,
    actorLogin: auth.session.login,
    targetType: "group",
    targetId: next.id,
    groupId: next.id,
    groupInstance: next.instance,
    ip: clientIp(event),
  };
  if (!prev) {
    await recordAudit(env.DB, { ...base, action: "group.create" });
    return;
  }
  const fields: string[] = [];
  if (prev.name !== next.name) fields.push("name");
  if (prev.emoji !== next.emoji) fields.push("emoji");
  if (prev.lang !== next.lang) fields.push("lang");
  if (!deepEqual(prev.logTarget, next.logTarget)) fields.push("logTarget");
  if (!deepEqual(prev.providers ?? [], next.providers ?? [])) fields.push("providers");
  if (!deepEqual(prev.forgeSources ?? [], next.forgeSources ?? [])) fields.push("forgeSources");
  if (prev.installationId !== next.installationId) fields.push("installationId");
  if (prev.isolated !== next.isolated) fields.push("isolated");
  if (!deepEqual(prev.owners ?? [], next.owners ?? [])) fields.push("owners");
  if (!deepEqual(normalizeGroupMembers(prev), normalizeGroupMembers(next))) fields.push("members");
  if (fields.length > 0) {
    await recordAudit(env.DB, { ...base, action: "group.update", detail: { fields } });
  }
}

/**
 * Bind members added by login to the account that holds the login right now
 * (looked up with the editor's own GitHub token): a login can later be
 * renamed away and claimed by someone else, a user id never changes. Members
 * already in `current` keep their binding (carried over by login); without a
 * token, or when GitHub does not answer, a member stays unbound and is bound
 * on its own first sign-in instead.
 */
async function bindNewMembers(event: H3Event, next: Group, current?: Group): Promise<Group> {
  if (!Array.isArray(next.members)) return next;
  const known = new Set(normalizeGroupMembers(current ?? next).map((m) => m.login.toLowerCase()));
  const fresh = next.members.filter(
    (m) =>
      !m.userId && !/^\d+$/.test(m.login) && (!current || !known.has(m.login.trim().toLowerCase())),
  );
  if (fresh.length === 0) return next;
  const env = cfEnv(event);
  const token = await getToken(env, currentAuth(event).session.userId).catch(() => null);
  if (!token) return next;
  const ids = new Map<string, string>();
  for (const m of fresh) {
    const id = await resolveGitHubUserId(token, m.login.trim());
    if (id) ids.set(m.login.trim().toLowerCase(), id);
  }
  if (ids.size === 0) return next;
  return {
    ...next,
    members: next.members.map((m) => {
      const id = m.userId ? undefined : ids.get(m.login.trim().toLowerCase());
      return id ? { ...m, userId: id } : m;
    }),
  };
}

/** A non-super owner may not leave a group without an owner. */
function ownershipError(event: H3Event, g: Group): string | null {
  const auth = currentAuth(event);
  if (auth.scope.isSuper) return null;
  const members = normalizeGroupMembers(g);
  const stillMine = members.some(
    (m) => m.role === "owner" && memberMatches(m, auth.session.userId, authLogin(auth.session)),
  );
  if (!stillMine && ownerCount(members) < 1) {
    return `group "${g.id}" would be left without an owner by you`;
  }
  return null;
}

class OwnershipError extends Error {}

/**
 * Delete a group. Its configuration rows, history ownership and a retired-id
 * marker commit in one D1 transaction. The KV side (webhook secret, invites)
 * follows best-effort: both are bound to the group's immutable instance, so
 * anything left behind can never be used by a later group with the same id.
 */
async function removeGroup(
  env: Env,
  id: string,
  expect?: (current: Group) => void | Promise<void>,
  version?: number,
): Promise<void> {
  let removed: Group | undefined;
  await deleteGroup(env.KV, id, {
    version,
    // Runs after `expect`, so the checked group's instance is known.
    extra: (db) => deleteLifecycle(id, removed?.instance, removed?.legacyId)(db),
    expect: async (current) => {
      await expect?.(current);
      removed = current;
    },
  });
  await retireGroupId(env, id);
  if (removed) {
    await deleteTenantSecret(env.KV, removed).catch((err) =>
      log.warn({ err, id }, "Failed to delete the webhook secret of a deleted group"),
    );
  }
  await deleteGroupInvites(env.KV, id, removed);
}

/** Group ids the system assigns (installation and personal groups); only super admins may claim them. */
function reservedGroupId(id: string): boolean {
  return /^(inst|u)-/.test(id);
}

/**
 * Create a group; false when the id is taken. A new group gets a new
 * instance, so nothing a former group with this id left behind applies to it.
 */
async function createFreshGroup(env: Env, group: Group): Promise<boolean> {
  return createGroup(env.KV, group);
}

/** Map a storage failure to a response (409 for a lost concurrent update). */
function writeError(event: H3Event, err: unknown, what: string): Record<string, unknown> {
  if (err instanceof OwnershipError) return respondError(event, 403, err.message);
  if (err instanceof ConfigConflictError) {
    return respondError(event, 409, `The ${what} changed meanwhile; reload and try again`);
  }
  log.error({ err }, `Failed to save ${what}`);
  return respondError(event, 500, `Failed to save ${what}`);
}

/**
 * PUT /admin/api/groups — bulk write (legacy API). Super admins replace the
 * whole set; owners may change and delete only groups they own (other groups
 * may be echoed back unchanged). Only groups that differ from the stored ones
 * are written, one row each. Concurrency guards for clients that send the
 * revisions they loaded: a group echoed back unedited is never written (so a
 * stale copy cannot revert someone else's change), an edited group must still
 * be at its loaded revision, and the list `revision` (when sent) must match,
 * so groups created or changed meanwhile are never dropped or overwritten.
 */
export async function adminApiGroupsPut(event: H3Event): Promise<Record<string, unknown>> {
  const auth = await requireAnyAccess(event);
  const env = cfEnv(event);
  const body = await readJsonBody(event);
  if (!body) return respondError(event, 400, "Invalid JSON body");
  const loadedRevisions = new Map<string, string>();
  if (Array.isArray(body["groups"])) {
    for (const raw of body["groups"] as Array<Record<string, unknown> | null>) {
      const rev = submittedRevision(raw?.["revision"]);
      if (rev && typeof raw?.["id"] === "string") loadedRevisions.set(raw["id"], rev);
    }
  }
  const result = validateGroups(body["groups"]);
  if (!result.ok) return respondError(event, 400, result.error);

  const existing = await loadGroups(env.KV, { fresh: true });
  const listRev = submittedRevision(body["revision"]);
  if (listRev) {
    const visible = auth.scope.isSuper
      ? existing
      : existing.filter((g) => auth.scope.groupIds.has(g.id));
    if ((await listRevision(visible)) !== listRev) {
      return respondError(event, 409, "The groups changed meanwhile; reload and try again");
    }
  }
  const prevById = new Map(existing.map((g) => [g.id, g]));
  const submittedIds = new Set(result.groups.map((g) => g.id));
  const writable = new Set<string>();
  if (auth.scope.isSuper) {
    for (const g of [...existing, ...result.groups]) writable.add(g.id);
  } else {
    for (const [gid, role] of auth.scope.roles) if (role === "owner") writable.add(gid);
  }

  const upserts: Group[] = [];
  const logTargetGuards = new Map<string, LifecycleStatements>();
  for (const submitted of result.groups) {
    const prev = prevById.get(submitted.id);
    // Member id bindings are server-owned: kept for members still listed,
    // looked up for members added now.
    const g = await bindNewMembers(event, carryMemberIds(submitted, prev), prev);
    if (!writable.has(g.id)) {
      // A visible group the user cannot write is fine as long as it is unchanged.
      if (prev && deepEqual(sanitizeGroup({ ...prev }), g)) continue;
      return respondError(event, 403, `group "${g.id}" is outside your ownership`);
    }
    const loaded = loadedRevisions.get(g.id);
    if (loaded && prev) {
      // Unedited since it was loaded: not a change, whatever is stored now.
      if ((await groupRevision(g, prev.instance)) === loaded) continue;
      if ((await groupRevision(prev)) !== loaded) {
        return respondError(event, 409, `group "${g.id}" changed meanwhile; reload and try again`);
      }
    }
    const next = auth.scope.isSuper ? g : keepSuperOnlyFields(g, prev);
    const ownerIssue = ownershipError(event, next);
    if (ownerIssue) return respondError(event, 403, ownerIssue);
    if (next.logTarget) {
      const check = await foreignTargetIssue(event, next.id, [
        { ref: "@log", target: next.logTarget },
      ]);
      if (check.issue) return respondError(event, 403, check.issue);
      if (check.guards) logTargetGuards.set(next.id, check.guards);
    }
    if (!prev && (await isGroupIdRetired(env, g.id))) {
      return respondError(event, 409, `group id "${g.id}" was used recently; pick another id`);
    }
    if (!prev || !deepEqual(sanitizeGroup({ ...prev }), next)) upserts.push(next);
  }
  const deletions = existing.filter((g) => writable.has(g.id) && !submittedIds.has(g.id));

  const audited = async (g: Group): Promise<void> => {
    await recordAudit(env.DB, {
      ts: Date.now(),
      actorId: auth.session.userId,
      actorLogin: auth.session.login,
      action: "group.delete",
      targetType: "group",
      targetId: g.id,
      ip: clientIp(event),
    });
  };
  try {
    for (const g of deletions) {
      // Deletes only the group as it was when the decision was made — and
      // only an empty one: this request carries no view of the group's routes,
      // so it can never vouch for deleting them.
      await removeGroup(env, g.id, async (current) => {
        if (!stillHolds(event, current, "owner")) throw new OwnershipError("Forbidden");
        if (!deepEqual(sanitizeGroup({ ...current }), sanitizeGroup({ ...g }))) {
          throw new ConfigConflictError();
        }
        // Unreadable route rows count too: they would be deleted unseen.
        const { config } = await loadConfigSnapshot(env, { fresh: true });
        if (
          config.routes.some((r) => r.groupId === g.id) ||
          config.unreadableGroups?.includes(g.id) ||
          // Strictly read: a fragment that cannot be parsed (or a failed
          // read) still counts — it was never shown for confirmation.
          (await loadFragments(env.DB, g.id, true).then(
            (fragments) => fragments.length > 0,
            () => true,
          ))
        ) {
          throw new ConfigConflictError();
        }
      });
      await audited(g);
    }
    for (const g of upserts) {
      const prev = prevById.get(g.id);
      let saved: Group | null = g;
      if (!prev) {
        if (!(await createFreshGroup(env, g))) throw new ConfigConflictError();
        // As stored (with its server-assigned instance), for its audit.
        saved = (await loadGroups(env.KV, { fresh: true })).find((s) => s.id === g.id) ?? g;
      } else {
        // Each write still requires the group as it was decided on above.
        saved = await updateGroup(
          env.KV,
          g.id,
          (current) => {
            if (!stillHolds(event, current, "owner")) throw new OwnershipError("Forbidden");
            if (!deepEqual(sanitizeGroup({ ...current }), sanitizeGroup({ ...prev }))) {
              throw new ConfigConflictError();
            }
            return g;
          },
          { guards: logTargetGuards.get(g.id) },
        );
        // Deleted meanwhile: the change was not written.
        if (!saved) throw new ConfigConflictError();
      }
      // Audited as stored (with its real instance), never as submitted.
      await auditGroupChange(event, prev, saved ?? g);
    }
  } catch (err) {
    return writeError(event, err, "groups");
  }
  log.info({ updated: upserts.length, deleted: deletions.length }, "Groups updated via admin UI");
  return { ok: true, count: result.groups.length };
}

/** POST /admin/api/groups — create one group (super admins). */
export async function adminGroupCreate(event: H3Event): Promise<Record<string, unknown>> {
  const auth = await requireAnyAccess(event);
  const env = cfEnv(event);
  if (!auth.scope.isSuper) return respondError(event, 403, "Forbidden");
  const body = await readJsonBody(event);
  if (!body) return respondError(event, 400, "Invalid JSON body");
  const result = validateGroups([body["group"]]);
  if (!result.ok) return respondError(event, 400, result.error);
  // Members added by login are bound to their accounts, as on every update.
  const group = await bindNewMembers(event, result.groups[0]!);
  if (await isGroupIdRetired(env, group.id)) {
    return respondError(event, 409, `group id "${group.id}" was used recently; pick another id`);
  }
  let created: boolean;
  try {
    created = await createFreshGroup(env, group);
  } catch (err) {
    return writeError(event, err, "group");
  }
  if (!created) return respondError(event, 409, `group id "${group.id}" already exists`);
  // What was stored (with its server-assigned instance): audited under that
  // instance, and returned so its revision matches the next update.
  const stored = (await loadGroups(env.KV, { fresh: true })).find((g) => g.id === group.id);
  await auditGroupChange(event, undefined, stored ?? group);
  const [withRev] = await withRevisions([stored ?? group]);
  return { ok: true, group: withRev };
}

/**
 * PUT /admin/api/groups/:groupId — update one group (owners). A submitted
 * `revision` must match the stored group, so an edit made from a stale copy is
 * refused (409) instead of silently reverting someone else's change.
 */
export async function adminGroupUpdate(
  event: H3Event,
  groupId: string,
): Promise<Record<string, unknown>> {
  const auth = await requireAnyAccess(event);
  const env = cfEnv(event);
  const access = requireGroupRole(event, groupId, "owner");
  if (!access.ok) return accessError(event, access);
  const body = await readJsonBody(event);
  if (!body) return respondError(event, 400, "Invalid JSON body");
  const raw = body["group"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return respondError(event, 400, "Missing group object");
  }
  const revision = submittedRevision((raw as Record<string, unknown>)["revision"]);
  const result = validateGroups([{ ...(raw as Record<string, unknown>), id: groupId }]);
  if (!result.ok) return respondError(event, 400, result.error);
  const submitted = await bindNewMembers(event, result.groups[0]!, access.group);
  const logTargetCheck = submitted.logTarget
    ? await foreignTargetIssue(event, groupId, [{ ref: "@log", target: submitted.logTarget }])
    : { issue: null };
  if (logTargetCheck.issue) return respondError(event, 403, logTargetCheck.issue);
  // Keeping a shared log channel was allowed for the group as authorized:
  // the write must still find it so, even without a client revision.
  const baseRevision =
    revision ??
    ("keepsShared" in logTargetCheck && logTargetCheck.keepsShared
      ? await groupRevision(access.group)
      : undefined);

  let prev: Group | undefined;
  let saved: Group | null;
  try {
    saved = await updateGroup(
      env.KV,
      groupId,
      async (current) => {
        if (baseRevision && (await groupRevision(current)) !== baseRevision) {
          throw new ConfigConflictError();
        }
        // Still an owner of the group as it is now (the write is a CAS on it).
        if (!stillHolds(event, current, "owner")) throw new OwnershipError("Forbidden");
        prev = current;
        const own = carryMemberIds(submitted, current);
        const next = auth.scope.isSuper ? own : keepSuperOnlyFields(own, current);
        const ownerIssue = ownershipError(event, next);
        if (ownerIssue) throw new OwnershipError(ownerIssue);
        return deepEqual(sanitizeGroup({ ...current }), next) ? null : next;
      },
      { guards: logTargetCheck.guards },
    );
  } catch (err) {
    if (err instanceof OwnershipError) return respondError(event, 403, err.message);
    return writeError(event, err, "group");
  }
  if (!saved) return respondError(event, 404, "Group not found");
  if (prev) await auditGroupChange(event, prev, saved);
  const [withRev] = await withRevisions([saved]);
  return { ok: true, group: withRev };
}

/** DELETE /admin/api/groups/:groupId — delete one group with its routes (owners). */
export async function adminGroupDelete(
  event: H3Event,
  groupId: string,
): Promise<Record<string, unknown>> {
  const auth = await requireAnyAccess(event);
  const env = cfEnv(event);
  const access = requireGroupRole(event, groupId, "owner");
  if (!access.ok) return accessError(event, access);
  // What the deletion was confirmed on. Checked inside the delete: the group
  // row's version is guarded, and every route write bumps it.
  const query = getQuery(event);
  const revision = submittedRevision(query["revision"]);
  const routesRev = submittedRevision(query["routesRevision"]);
  if (!revision || !routesRev) {
    return respondError(event, 400, "revision and routesRevision are required");
  }
  const versionParam = Number(query["version"]);
  const version = Number.isInteger(versionParam) && versionParam > 0 ? versionParam : undefined;
  if (canUseD1(env.DB) && version === undefined) {
    return respondError(event, 400, "version is required");
  }
  try {
    await removeGroup(
      env,
      groupId,
      async (current) => {
        if (!stillHolds(event, current, "owner")) throw new OwnershipError("Forbidden");
        if ((await groupRevision(current)) !== revision) {
          throw new ConfigConflictError();
        }
        const { config } = await loadConfigSnapshot(env, { fresh: true });
        // A route nobody could see was never confirmed for deletion.
        if (config.unreadableGroups?.includes(groupId)) throw new ConfigConflictError();
        const routes = config.routes.filter((r) => r.groupId === groupId);
        if ((await routesRevision(routes)) !== routesRev) throw new ConfigConflictError();
      },
      version,
    );
  } catch (err) {
    return writeError(event, err, "group");
  }
  // Not filed under the group: a later group reusing the id must not see it.
  await recordAudit(env.DB, {
    ts: Date.now(),
    actorId: auth.session.userId,
    actorLogin: auth.session.login,
    action: "group.delete",
    targetType: "group",
    targetId: groupId,
    ip: clientIp(event),
  });
  log.info({ groupId }, "Group deleted via admin UI");
  return { ok: true };
}

/** GET /admin/api/routes — every visible route, plus each group's list `revisions`. */
export async function adminApiRoutesGet(event: H3Event): Promise<Record<string, unknown>> {
  const auth = await requireAnyAccess(event);
  const env = cfEnv(event);
  const all = await loadRoutes(env.KV, { fresh: true });
  const routes = auth.scope.isSuper
    ? all
    : all.filter((r) => r.groupId != null && auth.scope.groupIds.has(r.groupId));
  const revisions: Record<string, string> = {};
  for (const g of auth.scope.groups) {
    revisions[g.id] = await routesRevision(routes.filter((r) => r.groupId === g.id));
  }
  return { routes, revisions };
}

/**
 * PUT /admin/api/routes — bulk write (legacy API). Each affected group's
 * routes are replaced in their own guarded transaction, and only for groups
 * the caller may edit. With `revisions` (as returned by GET), a group whose
 * list comes back unedited is left alone, a group the client never loaded is
 * not touched, and an edited group must still be at its loaded revision.
 * Without them, a group is only rewritten if nobody changed it while this
 * request ran.
 */
export async function adminApiRoutesPut(event: H3Event): Promise<Record<string, unknown>> {
  const auth = await requireAnyAccess(event);
  const env = cfEnv(event);
  const body = await readJsonBody(event);
  if (!body) return respondError(event, 400, "Invalid JSON body");
  const rawRevisions = body["revisions"];
  const revisions =
    rawRevisions && typeof rawRevisions === "object" && !Array.isArray(rawRevisions)
      ? (rawRevisions as Record<string, unknown>)
      : undefined;
  // One fresh read for the whole request: the target checks below use it too.
  const snapshot = await loadConfigSnapshot(env, { fresh: true });
  const existing = snapshot.config.routes;
  const unchanged = new Map(existing.map((r) => [routeKey(r.groupId, r.id), r]));
  const result = validateRoutes(body["routes"], unchanged);
  if (!result.ok) return respondError(event, 400, result.error);

  const groupIds = new Set(auth.groups.map((g) => g.id));
  const writable = new Set<string>();
  for (const gid of groupIds) {
    const role = roleAt(auth.scope, gid);
    if (role === "owner" || role === "admin") writable.add(gid);
  }
  const byGroup = (list: Route[]): Map<string, Route[]> => {
    const out = new Map<string, Route[]>();
    for (const r of list) {
      const gid = r.groupId ?? "";
      out.set(gid, [...(out.get(gid) ?? []), r]);
    }
    return out;
  };
  const next = byGroup(result.routes);
  const current = byGroup(existing);
  for (const [gid, list] of next) {
    if (!writable.has(gid)) {
      if (!groupIds.has(gid)) return respondError(event, 400, `group "${gid}" does not exist`);
      return respondError(event, 403, `route "${list[0]!.id}" is outside your groups`);
    }
  }

  const plan: Array<{
    gid: string;
    routes: Route[];
    base: string;
    guards?: LifecycleStatements;
  }> = [];
  for (const gid of writable) {
    const submitted = next.get(gid) ?? [];
    const loaded = revisions ? submittedRevision(revisions[gid]) : undefined;
    if (revisions) {
      if (!loaded && !next.has(gid)) continue; // never loaded, nothing sent
      if (loaded && (await routesRevision(submitted)) === loaded) continue; // unedited
    }
    const stored = current.get(gid) ?? [];
    if ((await routesRevision(submitted)) === (await routesRevision(stored))) continue;
    const targets = await foreignTargetIssue(event, gid, routeTargetRefs(submitted), snapshot);
    if (targets.issue) return respondError(event, 403, targets.issue);
    plan.push({
      gid,
      routes: submitted,
      base: loaded ?? (await routesRevision(stored)),
      guards: targets.guards,
    });
  }

  try {
    for (const { gid, routes, base, guards } of plan) {
      await saveGroupRoutes(env.KV, gid, routes, {
        guards: bothGuards(roleGuard(event, gid, "admin"), guards),
        expect: async (stored) => {
          if ((await routesRevision(stored)) !== base) throw new ConfigConflictError();
        },
      });
    }
  } catch (err) {
    return writeError(event, err, "routes");
  }
  const count = plan.reduce((n, p) => n + p.routes.length, 0);
  await recordAudit(env.DB, {
    ts: Date.now(),
    actorId: auth.session.userId,
    actorLogin: auth.session.login,
    action: "routes.update",
    targetType: "routes",
    targetId: "all",
    detail: { groups: plan.map((p) => p.gid), count },
    ip: clientIp(event),
  });
  log.info({ groups: plan.length }, "Routes updated via admin UI");
  return { ok: true, count: result.routes.length };
}

/** The groups whose history a reader may see: one group, theirs, or all (super). */
function visibleScope(event: H3Event, groupId: string | undefined): GroupScope {
  const auth = currentAuth(event);
  if (groupId) return groupId;
  return auth.scope.isSuper ? undefined : [...auth.scope.groupIds];
}

/** GET /admin/api/logs */
export async function adminApiLogs(event: H3Event): Promise<Record<string, unknown>> {
  const auth = await requireAnyAccess(event);
  const env = cfEnv(event);
  const query = getQuery(event);
  const limit = Math.min(Math.max(Number(String(query["limit"] ?? "50")) || 50, 1), 100);
  const filterGroupId = String(query["groupId"] ?? "") || undefined;
  if (filterGroupId && !auth.scope.isSuper && !auth.scope.groupIds.has(filterGroupId)) {
    return respondError(event, 403, "Forbidden");
  }
  const logs = await getSendLog(env.DB, limit, visibleScope(event, filterGroupId));
  return { logs };
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
  // Read before the routes: a write landing in between makes the version
  // newer than what is shown, so a deletion confirmed on this view fails.
  const version = canUseD1(env.DB) ? await groupVersion(env.DB, groupId) : null;
  const { config } = await loadConfigSnapshot(env, { fresh: true });
  const routes = config.routes.filter((r) => r.groupId === groupId);
  return {
    group: sanitizeGroup({ ...access.group }),
    routes,
    revision: await routesRevision(routes),
    // The group's version (routes, fragments, settings): a deletion is
    // confirmed on it.
    version,
    // Stored routes not listed (unreadable): a save must repair them explicitly.
    unreadable: config.unreadableGroups?.includes(groupId) === true,
  };
}

/**
 * PUT /admin/api/groups/:groupId/routes — replace one group's routes. A
 * submitted `revision` (from the last load or save) must still match the
 * stored list; otherwise someone changed the routes meanwhile and the write is
 * refused (409) instead of reverting their change.
 */
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
  // One fresh read for the whole request: the target check below uses it too.
  const snapshot = await loadConfigSnapshot(env, { fresh: true });
  const current = snapshot.config.routes.filter((r) => r.groupId === groupId);
  const revision = submittedRevision(body["revision"]);
  const unchanged = new Map(current.map((r) => [routeKey(r.groupId, r.id), r]));
  const result = validateRoutes(scoped, unchanged);
  if (!result.ok) return respondError(event, 400, result.error);
  const targets = await foreignTargetIssue(
    event,
    groupId,
    routeTargetRefs(result.routes),
    snapshot,
  );
  if (targets.issue) return respondError(event, 403, targets.issue);
  // Keeping a shared channel was allowed for the routes as just read: the
  // write must still find them so, even when the client sent no revision.
  const base = revision ?? (targets.keepsShared ? await routesRevision(current) : undefined);

  let saved: Route[];
  try {
    // The revision is checked against the stored routes inside the guarded
    // write, so two saves from the same revision cannot both succeed.
    saved = await saveGroupRoutes(env.KV, groupId, result.routes, {
      guards: bothGuards(roleGuard(event, groupId, "admin"), targets.guards),
      // An explicit repair: replace routes that can no longer be read.
      discardUnreadable: body["discardUnreadable"] === true,
      expect: async (stored) => {
        if (base && (await routesRevision(stored)) !== base) {
          throw new ConfigConflictError();
        }
      },
    });
  } catch (err) {
    return writeError(event, err, "routes");
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
    groupInstance: access.group.instance,
    detail: { count: result.routes.length },
    ip: clientIp(event),
  });
  log.info({ groupId, count: result.routes.length }, "Group routes updated via admin UI");
  return {
    ok: true,
    count: result.routes.length,
    routes: saved,
    revision: await routesRevision(saved),
  };
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
  const expiresAt = Date.now() + INVITE_LIFETIME_MS;
  const token = await createInvite(env.KV, {
    groupId,
    role,
    expiresAt,
    createdBy: auth.session.login,
    note: typeof note === "string" && note.trim() ? note.trim() : undefined,
    groupInstance: access.group.instance,
    // Who vouches for it: checked again when it is used.
    issuer: auth.scope.isSuper
      ? { super: true }
      : { userId: auth.session.userId, login: authLogin(auth.session) },
  });
  await recordAudit(env.DB, {
    ts: Date.now(),
    actorId: auth.session.userId,
    actorLogin: auth.session.login,
    action: "invite.create",
    targetType: "group",
    targetId: groupId,
    groupId,
    groupInstance: access.group.instance,
    detail: { role },
    ip: clientIp(event),
  });
  return {
    ok: true,
    token,
    url: `/admin/invite?token=${token}`,
    expiresAt,
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
  const invites = await listInvites(env.KV, groupId, access.group);
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
  // The group that issued it, under whatever id it has now (the invite may
  // still name a former id); never another group that took over that id.
  const groups = currentAuth(event).groups;
  const issuer = invite.groupInstance
    ? groups.find((g) => g.instance === invite.groupInstance)?.id
    : groups.find((g) => g.legacyId === invite.groupId)?.id;
  if (!issuer) return respondError(event, 403, "Forbidden");
  const access = requireGroupRole(event, issuer, "owner");
  if (!access.ok) return respondError(event, 403, "Forbidden");
  try {
    // Still an owner when the revocation commits (checked in its transaction).
    await revokeInvite(env.KV, token, env.DB, roleGuard(event, issuer, "owner"));
  } catch (err) {
    // A guard aborts its transaction with a JSON error ("malformed JSON").
    if (/role revoked|malformed JSON/i.test(String(err)))
      return respondError(event, 403, "Forbidden");
    throw err;
  }
  const auth = currentAuth(event);
  await recordAudit(env.DB, {
    ts: Date.now(),
    actorId: auth.session.userId,
    actorLogin: auth.session.login,
    action: "invite.revoke",
    targetType: "group",
    targetId: issuer,
    groupId: issuer,
    groupInstance: invite.groupInstance,
    ip: clientIp(event),
  });
  return { ok: true };
}

/**
 * PUT /admin/api/groups/:groupId/rename — move a group to a new id. The group,
 * its routes and its fragments move in one transaction; its history, webhook
 * secret and invites follow, deliveries queued under the old id are redirected,
 * and the old id stays retired for a while so no other group inherits them.
 */
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
  const revision = submittedRevision(body["revision"]);
  const auth = currentAuth(event);
  if (reservedGroupId(newId) && !auth.scope.isSuper) {
    return respondError(event, 400, "ids starting with inst- or u- are reserved");
  }
  const existing = await loadGroups(env.KV, { fresh: true });
  if (existing.some((g) => g.id === newId)) {
    return respondError(event, 400, `group id "${newId}" already exists`);
  }
  if (await isGroupIdRetired(env, newId)) {
    return respondError(event, 409, `group id "${newId}" was used recently; pick another id`);
  }
  const routeCount = (await loadRoutes(env.KV, { fresh: true })).filter(
    (r) => r.groupId === groupId,
  ).length;

  let renamed: Group;
  try {
    renamed = await renameGroup(env.KV, groupId, newId, {
      // Checked against the row the copy is taken from, inside the guarded
      // transaction: a concurrent change makes the rename fail, not revert it.
      expect: async (current) => {
        // Still an owner of the group as it is now (checked inside the guarded write).
        if (!stillHolds(event, current, "owner")) throw new OwnershipError("Forbidden");
        if (revision && (await groupRevision(current)) !== revision) {
          throw new ConfigConflictError();
        }
      },
      extra: renameLifecycle(groupId, newId),
      // The id no longer marks a personal group: keep its isolation explicit.
      transform: (g) => ({ ...g, isolated: g.isolated ?? (isIsolated(g) || undefined) }),
    });
  } catch (err) {
    if (err instanceof ConfigConflictError) return writeError(event, err, "group");
    log.error({ err }, "Failed to rename group");
    return respondError(event, 500, "Failed to rename group");
  }

  await recordGroupRename(env, groupId, newId).catch((err) =>
    log.warn({ err, from: groupId, to: newId }, "Failed to record group rename"),
  );
  await retireGroupId(env, groupId);
  // The secret is keyed by instance and follows the group by itself; invites
  // are accepted by instance too — moving the index only keeps them listed.
  await migrateInvites(env.KV, groupId, newId, renamed);

  await recordAudit(env.DB, {
    ts: Date.now(),
    actorId: auth.session.userId,
    actorLogin: auth.session.login,
    action: "group.rename",
    targetType: "group",
    targetId: newId,
    groupId: newId,
    groupInstance: renamed?.instance,
    detail: { from: groupId, to: newId, routes: routeCount },
    ip: clientIp(event),
  });
  log.info({ from: groupId, to: newId }, "Group renamed via admin UI");
  const [withRev] = await withRevisions([renamed]);
  return { ok: true, id: newId, group: withRev, revision: withRev!.revision };
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
    hasSecret: (await getTenantSecret(env.KV, access.group)) != null,
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
  let secret: string | null;
  try {
    // Only by someone who is an owner when the new secret is committed.
    secret = await rotateTenantSecret(env.KV, groupId, (current) => {
      if (!stillHolds(event, current, "owner")) throw new OwnershipError("Forbidden");
    });
  } catch (err) {
    return writeError(event, err, "webhook secret");
  }
  if (!secret) return respondError(event, 404, "Group not found");
  const auth = currentAuth(event);
  await recordAudit(env.DB, {
    ts: Date.now(),
    actorId: auth.session.userId,
    actorLogin: auth.session.login,
    action: "webhook.secret.regenerate",
    targetType: "group",
    targetId: groupId,
    groupId,
    groupInstance: access.group.instance,
    ip: clientIp(event),
  });
  return { ok: true, url: webhookUrl(event, groupId), secret, hasSecret: true };
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
  try {
    const removed = await removeTenantSecret(env.KV, groupId, (current) => {
      if (!stillHolds(event, current, "owner")) throw new OwnershipError("Forbidden");
    });
    if (!removed) return respondError(event, 404, "Group not found");
  } catch (err) {
    return writeError(event, err, "webhook secret");
  }
  const auth = currentAuth(event);
  await recordAudit(env.DB, {
    ts: Date.now(),
    actorId: auth.session.userId,
    actorLogin: auth.session.login,
    action: "webhook.secret.delete",
    targetType: "group",
    targetId: groupId,
    groupId,
    groupInstance: access.group.instance,
    ip: clientIp(event),
  });
  return { ok: true };
}

/** GET /admin/api/audit */
export async function adminAudit(event: H3Event): Promise<Record<string, unknown>> {
  const auth = await requireAnyAccess(event);
  const env = cfEnv(event);
  const query = getQuery(event);
  const limit = Math.min(Math.max(Number(String(query["limit"] ?? "50")) || 50, 1), 200);
  const groupId = String(query["groupId"] ?? "") || undefined;
  if (groupId && !auth.scope.isSuper && !auth.scope.groupIds.has(groupId)) {
    return respondError(event, 403, "Forbidden");
  }
  const audit = await getAuditLog(env.DB, { groupId: visibleScope(event, groupId), limit });
  return { audit };
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
  // Every aggregate (not only the failure list) is computed over the groups
  // the reader may see; nobody but a super admin gets global totals.
  const metrics = await getDeliveryMetrics(env.DB, visibleScope(event, groupId));
  return { metrics };
}

/** GET /admin/api/delivery/:deliveryId */
export async function adminApiDelivery(
  event: H3Event,
  deliveryId: string,
): Promise<Record<string, unknown>> {
  const auth = await requireAnyAccess(event);
  const env = cfEnv(event);
  const rows = await getSendLogByDelivery(env.DB, deliveryId);
  // One delivery can fan out to several groups: show the reader their part.
  // A delivery id is chosen by its sender, so two senders (two groups'
  // endpoints) may use the same one: `?groupId=` narrows it to one group.
  const only = getQuery(event)["groupId"];
  const attempts = (
    auth.scope.isSuper
      ? rows
      : rows.filter((r) => r.groupId != null && auth.scope.groupIds.has(r.groupId))
  ).filter((r) => typeof only !== "string" || !only || r.groupId === only);
  if (attempts.length === 0) return respondError(event, 404, "Delivery not found");
  return { deliveryId, attempts };
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
  let fragments: NamedFragment[];
  try {
    fragments = await loadFragments(env.DB, groupId);
  } catch (err) {
    log.error({ err, groupId }, "Failed to load fragments");
    return respondError(event, 500, "Failed to load fragments");
  }
  return {
    group: sanitizeGroup({ ...access.group }),
    fragments,
    revision: await revisionOf(fragments),
  };
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

  let saved: NamedFragment[];
  try {
    const revision = submittedRevision(body["revision"]);
    saved = await saveGroupFragments(env.DB, groupId, result.fragments, {
      guards: roleGuard(event, groupId, "admin"),
      expect: async (stored) => {
        if (revision && (await revisionOf(stored)) !== revision) throw new ConfigConflictError();
      },
    });
  } catch (err) {
    return writeError(event, err, "fragments");
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
    groupInstance: access.group.instance,
    detail: { count: result.fragments.length },
    ip: clientIp(event),
  });
  return {
    ok: true,
    count: result.fragments.length,
    fragments: saved,
    revision: await revisionOf(saved),
  };
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
