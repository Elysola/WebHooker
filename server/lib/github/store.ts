import { idempotencyStore, recordStatement, unrecordedGuard } from "../lib/idempotency";
import { canUseD1, isMissingTable } from "../storage/d1";

interface StoredToken {
  userId: string;
  accessToken: string;
  expiresAt: number;
  /**
   * Valid only while D1 records it as the user's live token (see
   * `markLive`). Unset on tokens saved before that record existed, or
   * without the D1 table: those follow the revocation records alone.
   */
  live?: boolean;
}

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Tokens are revoked (on removal and rotation) in the idempotency store (D1)
 * as well as deleted from KV, whose deletes take a while to reach every
 * location: a revoked token must stop authenticating at once.
 */
function revokedTokenKey(tokenHash: string): string {
  return `token-revoked:${tokenHash}`;
}

/**
 * The user's live token, in D1. KV can hand a node a stale copy of the user's
 * token, so a removal or rotation working from that copy would miss the
 * newer token: dropping every live record of the user covers it whatever
 * copy was read.
 */
function liveTokenKey(userId: string, tokenHash: string): string {
  return `${liveTokenPrefix(userId)}${tokenHash}`;
}

function liveTokenPrefix(userId: string): string {
  return `token-live:${userId}:`;
}

/** Statement dropping the user's live records (all, or all but `keep`). */
function dropLive(db: D1Database, userId: string, keep = ""): D1PreparedStatement {
  // A range over the prefix (`;` follows `:`), never a LIKE pattern.
  return db
    .prepare("DELETE FROM dedup_keys WHERE key >= ? AND key < ? AND key <> ?")
    .bind(liveTokenPrefix(userId), `token-live:${userId};`, keep);
}

/**
 * Record `tokenHash` as the user's only live token, in one D1 batch. Returns
 * false where the D1 table does not exist yet (the token then follows the
 * revocation records alone).
 */
async function markLive(
  db: D1Database,
  userId: string,
  tokenHash: string,
  ttlSeconds: number,
): Promise<boolean> {
  const now = Date.now();
  const key = liveTokenKey(userId, tokenHash);
  try {
    await db.batch([
      dropLive(db, userId, key),
      db
        .prepare(
          `INSERT INTO dedup_keys (key, claimed_at, expires_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             claimed_at = excluded.claimed_at, expires_at = excluded.expires_at`,
        )
        .bind(key, now, now + ttlSeconds * 1000),
    ]);
    return true;
  } catch (err) {
    if (isMissingTable(err)) return false;
    throw err;
  }
}

/** Whether a stored token may still be used (expiry aside). */
async function usable(
  db: D1Database | undefined,
  kv: KVNamespace,
  t: StoredToken,
  tokenHash: string,
): Promise<boolean> {
  if (!db) return true;
  const claims = idempotencyStore(db, kv);
  if (await claims.has(revokedTokenKey(tokenHash))) return false;
  if (t.live && !(await claims.has(liveTokenKey(t.userId, tokenHash)))) return false;
  return true;
}

async function revokeToken(db: D1Database, kv: KVNamespace, t: StoredToken): Promise<void> {
  const ttl = Math.max(60, Math.ceil((t.expiresAt - Date.now()) / 1000));
  await idempotencyStore(db, kv).claim(revokedTokenKey(await hashToken(t.accessToken)), ttl);
}

export async function saveToken(
  kv: KVNamespace,
  userId: string,
  accessToken: string,
  expiresInSeconds: number,
  db?: D1Database,
): Promise<void> {
  const token: StoredToken = {
    userId,
    accessToken,
    expiresAt: Date.now() + expiresInSeconds * 1000,
  };
  const ttl = Math.max(Math.floor(expiresInSeconds * 0.9), 60);
  const tokenHash = await hashToken(accessToken);
  // Rotation: the previous token's reverse index must stop resolving to this
  // user, or the old token would keep acting with the new one.
  // A failed read aborts the rotation: the old token must be revoked, and
  // "none" cannot be assumed.
  const previous = await kv.get<StoredToken>(`token:${userId}`, "json");
  const rotated = previous?.accessToken && previous.accessToken !== accessToken;
  // Revoked before it is overwritten: should this fail, the old token is
  // still on record and a retry revokes it then.
  if (rotated && db) await revokeToken(db, kv, previous);
  // The only live token from here on — whichever older one some node's KV
  // still shows.
  if (db && canUseD1(db) && (await markLive(db, userId, tokenHash, expiresInSeconds))) {
    token.live = true;
  }
  await kv.put(`token:${userId}`, JSON.stringify(token), { expirationTtl: ttl });

  await kv.put(`token-reverse:${tokenHash}`, userId, { expirationTtl: ttl });
  if (rotated) await kv.delete(`token-reverse:${await hashToken(previous.accessToken)}`);
}

/** Where tokens are read from: KV alone, or KV with D1 (revocations honored). */
export type TokenSource = KVNamespace | { KV: KVNamespace; DB?: D1Database };

function sourceOf(source: TokenSource): { kv: KVNamespace; db?: D1Database } {
  return "KV" in source ? { kv: source.KV, db: source.DB } : { kv: source };
}

export async function getToken(source: TokenSource, userId: string): Promise<string | null> {
  const { kv, db } = sourceOf(source);
  const raw = await kv.get(`token:${userId}`, "json");
  if (!raw) return null;
  const t = raw as StoredToken;
  if (Date.now() >= t.expiresAt) {
    await kv.delete(`token:${userId}`);
    return null;
  }
  // Revoked or no longer live, even where KV still holds it (writes and
  // deletes take a while to spread).
  if (!(await usable(db, kv, t, await hashToken(t.accessToken)))) return null;
  return t.accessToken;
}

export async function removeToken(kv: KVNamespace, userId: string, db?: D1Database): Promise<void> {
  // First, and whatever KV shows here: a newer token than the copy read below
  // stops too.
  if (db && canUseD1(db)) {
    try {
      await dropLive(db, userId).run();
    } catch (err) {
      if (!isMissingTable(err)) throw err;
    }
  }
  const raw = await kv.get(`token:${userId}`, "json");
  if (raw) {
    const t = raw as StoredToken;
    if (db) await revokeToken(db, kv, t);
    const tokenHash = await hashToken(t.accessToken);
    await kv.delete(`token-reverse:${tokenHash}`);
  }
  await kv.delete(`token:${userId}`);
}

/**
 * The GitHub user whose *current* stored token is `accessToken`. The reverse
 * index only narrows the lookup; the stored token must match too, so a token
 * that was rotated, revoked or expired never authenticates (even while a stale
 * reverse key is still around).
 */
export async function findUserIdByToken(
  kv: KVNamespace,
  accessToken: string,
  db?: D1Database,
): Promise<string | null> {
  const tokenHash = await hashToken(accessToken);
  if (db && (await idempotencyStore(db, kv).has(revokedTokenKey(tokenHash)))) return null;
  const userId = await kv.get(`token-reverse:${tokenHash}`, "text");
  if (!userId) return null;
  const stored = await kv.get<StoredToken>(`token:${userId}`, "json");
  if (!stored || Date.now() >= stored.expiresAt) return null;
  if ((await hashToken(stored.accessToken)) !== tokenHash) return null;
  if (!(await usable(db, kv, stored, tokenHash))) return null;
  return userId;
}

export type LinkPlatform = "discord" | "telegram" | "feishu";

const LINK_TABLES: Record<LinkPlatform, { table: string; column: string }> = {
  discord: { table: "discord_links", column: "discord_user_id" },
  telegram: { table: "telegram_links", column: "telegram_user_id" },
  feishu: { table: "feishu_links", column: "feishu_user_id" },
};

/** Statement linking a chat account to a GitHub account (for a batch). */
export function linkStatement(
  db: D1Database,
  platform: LinkPlatform,
  chatUserId: string,
  githubUserId: string,
): D1PreparedStatement {
  const { table, column } = LINK_TABLES[platform];
  return db
    .prepare(`INSERT OR REPLACE INTO ${table} (${column}, github_user_id) VALUES (?, ?)`)
    .bind(chatUserId, githubUserId);
}

/** Statement removing a chat account's link (for a batch). */
export function unlinkStatement(
  db: D1Database,
  platform: LinkPlatform,
  chatUserId: string,
): D1PreparedStatement {
  const { table, column } = LINK_TABLES[platform];
  return db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).bind(chatUserId);
}

/**
 * Unlink as a bot command: the command's "done" record (`done`) commits in
 * the same D1 transaction, so an unlink that went through — even one whose
 * answer was lost — is never run again by a redelivery (which by then could
 * remove a link made since).
 */
export async function unlinkAsCommand(
  env: { DB: D1Database; KV: KVNamespace },
  platform: LinkPlatform,
  chatUserId: string,
  done?: { key: string; ttl: number },
): Promise<void> {
  if (!done || !canUseD1(env.DB)) {
    await unlinkStatement(env.DB, platform, chatUserId).run();
    return;
  }
  try {
    await env.DB.batch([
      // Done already (another run took over this command after ours outlived
      // its claim): nothing is removed — the link may be a new one by now.
      unrecordedGuard(env.DB, done.key),
      unlinkStatement(env.DB, platform, chatUserId),
      recordStatement(env.DB, done.key, done.ttl),
    ]);
  } catch (err) {
    // Recorded — committed here after all (its answer lost), or by another
    // run before: done either way.
    if (
      !(await idempotencyStore(env.DB, env.KV)
        .has(done.key)
        .catch(() => false))
    )
      throw err;
  }
}

/**
 * Link a Discord user id to a GitHub user id so that bot commands can act
 * as that GitHub account. The actual OAuth token lives under `token:{githubUserId}`.
 */
export async function saveDiscordLink(
  db: D1Database,
  discordUserId: string,
  githubUserId: string,
): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO discord_links (discord_user_id, github_user_id) VALUES (?, ?)")
    .bind(discordUserId, githubUserId)
    .run();
}

export async function getDiscordLink(
  db: D1Database,
  discordUserId: string,
): Promise<string | null> {
  const { results } = await db
    .prepare("SELECT github_user_id FROM discord_links WHERE discord_user_id = ?")
    .bind(discordUserId)
    .all<{ github_user_id: string }>();
  return results[0]?.github_user_id ?? null;
}

export async function removeDiscordLink(db: D1Database, discordUserId: string): Promise<void> {
  await db.prepare("DELETE FROM discord_links WHERE discord_user_id = ?").bind(discordUserId).run();
}

export async function saveTelegramLink(
  db: D1Database,
  telegramUserId: string,
  githubUserId: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT OR REPLACE INTO telegram_links (telegram_user_id, github_user_id) VALUES (?, ?)",
    )
    .bind(telegramUserId, githubUserId)
    .run();
}

export async function getTelegramLink(
  db: D1Database,
  telegramUserId: string,
): Promise<string | null> {
  const { results } = await db
    .prepare("SELECT github_user_id FROM telegram_links WHERE telegram_user_id = ?")
    .bind(telegramUserId)
    .all<{ github_user_id: string }>();
  return results[0]?.github_user_id ?? null;
}

export async function removeTelegramLink(db: D1Database, telegramUserId: string): Promise<void> {
  await db
    .prepare("DELETE FROM telegram_links WHERE telegram_user_id = ?")
    .bind(telegramUserId)
    .run();
}

export async function saveFeishuLink(
  db: D1Database,
  feishuUserId: string,
  githubUserId: string,
): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO feishu_links (feishu_user_id, github_user_id) VALUES (?, ?)")
    .bind(feishuUserId, githubUserId)
    .run();
}

export async function getFeishuLink(db: D1Database, feishuUserId: string): Promise<string | null> {
  const { results } = await db
    .prepare("SELECT github_user_id FROM feishu_links WHERE feishu_user_id = ?")
    .bind(feishuUserId)
    .all<{ github_user_id: string }>();
  return results[0]?.github_user_id ?? null;
}

export async function removeFeishuLink(db: D1Database, feishuUserId: string): Promise<void> {
  await db.prepare("DELETE FROM feishu_links WHERE feishu_user_id = ?").bind(feishuUserId).run();
}
