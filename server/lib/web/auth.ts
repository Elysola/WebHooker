import type { H3Event } from "h3";
import { createError, getHeader } from "h3";
import type { Group, GroupRole } from "../types";
import { getAdminSession, isDebugMode, type AdminSession } from "./session";
import {
  loadGroups,
  resolveScope,
  hasAnyAccess,
  canEditGroup,
  canEditRoutes,
  roleAtLeast,
  roleAt,
  type AccessScope,
} from "./groups";
import { findUserIdByToken } from "../github/store";
import { cfEnv } from "../cf";
import { initConfigStore } from "../config";

export interface AuthContext {
  session: AdminSession;
  scope: AccessScope;
  groups: Group[];
}

const AUTH_KEY = "auth";

/** Read the admin session + access scope for a request (null when logged out). */
export async function loadAuth(event: H3Event): Promise<AuthContext | null> {
  const env = cfEnv(event);
  initConfigStore(env);
  const groups = await loadGroups(env.KV);
  if (isDebugMode(env)) {
    const session: AdminSession = { userId: "debug", login: "debug" };
    return { session, scope: resolveScope(env, groups, session.userId, session.login), groups };
  }
  const session = await getAdminSession(env.KV, getHeader(event, "cookie"));
  if (!session) return null;
  const scope = resolveScope(env, groups, session.userId, session.login);
  return { session, scope, groups };
}

/**
 * Authenticate + gate: throws 401 when logged out, 403 when the account has
 * no group access at all. Returns the auth context and caches it on the event.
 */
export async function requireAnyAccess(event: H3Event): Promise<AuthContext> {
  const auth = await loadAuth(event);
  if (!auth) throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  if (!hasAnyAccess(auth.scope)) throw createError({ statusCode: 403, statusMessage: "Forbidden" });
  event.context[AUTH_KEY] = auth;
  return auth;
}

/** The authenticated context; only valid after `requireAnyAccess`. */
export function currentAuth(event: H3Event): AuthContext {
  return event.context[AUTH_KEY] as AuthContext;
}

export type GroupAccess = { ok: true; group: Group } | { ok: false; status: 403 | 404 };

/** Resolves the group and checks the user can at least view it. */
export function requireGroup(event: H3Event, groupId: string): GroupAccess {
  const auth = currentAuth(event);
  const group = auth.groups.find((g) => g.id === groupId);
  if (!group) return { ok: false, status: 404 };
  if (!auth.scope.isSuper && !auth.scope.groupIds.has(groupId)) {
    return { ok: false, status: 403 };
  }
  return { ok: true, group };
}

/** Requires at least `min` role in the group (owner|admin|viewer). */
export function requireGroupRole(event: H3Event, groupId: string, min: GroupRole): GroupAccess {
  const access = requireGroup(event, groupId);
  if (!access.ok) return access;
  const auth = currentAuth(event);
  if (!auth.scope.isSuper && !roleAtLeast(roleAt(auth.scope, groupId), min)) {
    return { ok: false, status: 403 };
  }
  return access;
}

export { canEditGroup, canEditRoutes, roleAt };

/** Best-effort client IP for audit entries (Cloudflare header first). */
export function clientIp(event: H3Event): string | undefined {
  return (
    getHeader(event, "cf-connecting-ip") ??
    getHeader(event, "x-forwarded-for")?.split(",")[0]?.trim()
  );
}

/**
 * Bearer-token auth for machine-to-machine action endpoints: resolves the
 * GitHub userId owning the token, or throws 401.
 */
export async function bearerUserId(event: H3Event): Promise<string> {
  const env = cfEnv(event);
  const auth = getHeader(event, "authorization");
  if (!auth?.startsWith("Bearer "))
    throw createError({ statusCode: 401, statusMessage: "Missing authorization" });
  // Resolves only the user's *current* token: a rotated or revoked one fails.
  const userId = await findUserIdByToken(env.KV, auth.slice(7), env.DB);
  if (!userId) throw createError({ statusCode: 401, statusMessage: "Invalid or expired token" });
  return userId;
}
