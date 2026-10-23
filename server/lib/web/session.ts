import type { Env } from "../types";
import { idempotencyStore } from "../lib/idempotency";

const SESSION_COOKIE = "wh_admin_session";
const SESSION_TTL = 24 * 3600;

export interface AdminSession {
  userId: string;
  login: string;
  /**
   * False when the login was first seen with another GitHub account (a name
   * released by a rename and taken over since): identity checks then match
   * this session by its user id only, never by the login.
   */
  loginTrusted?: boolean;
}

/** The login identity checks may use for this session ("" — by user id only). */
export function authLogin(session: AdminSession): string {
  return session.loginTrusted === false ? "" : session.login;
}

/**
 * Whether `login` belongs to `userId` as far as this deployment knows: the
 * first account seen with a login owns it here (`login-owner:{login}`). A
 * GitHub login can be renamed away and registered by someone else; that
 * newcomer then never inherits what was granted to the login (an admin
 * entry, a member entry not yet bound to an id).
 */
export async function claimLogin(kv: KVNamespace, userId: string, login: string): Promise<boolean> {
  const key = `login-owner:${login.toLowerCase()}`;
  const owner = await kv.get(key);
  if (owner) return owner === userId;
  await kv.put(key, userId);
  // Read back: of two first sign-ins racing, only the one stored wins.
  return (await kv.get(key)) === userId;
}

export function isDebugMode(env: Env): boolean {
  if (env.DEBUG_MODE === "true") return true;
  const anyEnv = env as unknown as Record<string, string | undefined>;
  if (anyEnv["debug_mode"] === "true") return true;
  const proc = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })
    .process;
  if (proc?.env?.NODE_ENV !== "test") {
    if (proc?.env?.DEBUG_MODE === "true" || proc?.env?.debug_mode === "true") return true;
  }
  return false;
}

/**
 * Whether one configured identity names this user. An all-digit entry is a
 * GitHub user id, anything else a login (case-insensitive) — one string is
 * never matched both ways, so a user whose login is digits can never pass for
 * the user with that id.
 */
export function identityEntryMatches(entry: string, userId: string, login: string): boolean {
  const e = entry.trim();
  if (!e) return false;
  if (/^\d+$/.test(e)) return e === userId;
  return e.toLowerCase() === login.toLowerCase();
}

export function isAdminUser(env: Env, userId: string, login: string): boolean {
  if (isDebugMode(env)) return true;
  return (env.ADMIN_USER_IDS ?? "")
    .split(",")
    .some((entry) => identityEntryMatches(entry, userId, login));
}

function generateSessionId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function createAdminSession(
  kv: KVNamespace,
  userId: string,
  login: string,
  loginTrusted = true,
): Promise<string> {
  const sessionId = generateSessionId();
  const session: AdminSession = loginTrusted ? { userId, login } : { userId, login, loginTrusted };
  await kv.put(`session:${sessionId}`, JSON.stringify(session), {
    expirationTtl: SESSION_TTL,
  });
  return sessionId;
}

export function adminCookie(sessionId: string): string {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`;
}

export function clearAdminCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

/**
 * Sessions are revoked in the idempotency store (D1) as well as deleted from
 * KV: a KV delete takes a while to reach every location, and a stolen cookie
 * must stop working at once.
 */
function revokedSessionKey(sessionId: string): string {
  return `session-revoked:${sessionId}`;
}

export async function getAdminSession(
  kv: KVNamespace,
  cookieHeader: string | undefined,
  db?: D1Database,
): Promise<AdminSession | null> {
  const sessionId = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!sessionId) return null;
  const raw = await kv.get<AdminSession>(`session:${sessionId}`, "json");
  if (!raw) return null;
  if (db && (await idempotencyStore(db, kv).has(revokedSessionKey(sessionId)))) return null;
  return raw;
}

export async function destroyAdminSession(
  kv: KVNamespace,
  cookieHeader: string | undefined,
  db?: D1Database,
): Promise<void> {
  const sessionId = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!sessionId) return;
  if (db) await idempotencyStore(db, kv).claim(revokedSessionKey(sessionId), SESSION_TTL);
  await kv.delete(`session:${sessionId}`);
}
