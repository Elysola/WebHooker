import type { Env, Group } from "../types";
import {
  loadGroups,
  updateGroup,
  memberMatches,
  memberRole,
  memberRoleStatement,
  normalizeGroupMembers,
} from "./groups";
import {
  acceptedKey,
  claimOnce,
  confirmClaim,
  idempotencyStore,
  recordStatement,
} from "../lib/idempotency";
import { canUseD1 } from "../storage/d1";
import { ConfigConflictError } from "../storage/config-store";
import { log } from "../lib/log";

export interface Invite {
  groupId: string;
  /** Invited users can never be owners; only admins or viewers. */
  role: "admin" | "viewer";
  expiresAt: number;
  createdBy: string;
  note?: string;
  /**
   * The invited group's immutable `instance` id. A group later re-created
   * under the same id has another instance, so the invite never admits anyone
   * to it. Absent on invites created before instances existed.
   */
  groupInstance?: string;
  /**
   * Who issued it: a super admin, or a member who must still be an owner of
   * the group when the invite is used — an owner removed meanwhile cannot
   * have it let anyone in. Absent on older invites.
   */
  issuer?: { super: true } | { userId: string; login: string };
}

/** The invite belongs to an earlier group that had the same id. */
class StaleInviteError extends Error {}

/**
 * The login is still on a member entry bound to another account (a member
 * who renamed since). Adding a second entry with that login would be dropped
 * as a duplicate — a "successful" join without access — so the owner must
 * clear the stale entry first.
 */
class MemberConflictError extends Error {}

function revokedKey(token: string): string {
  return `invite-revoked:${token}`;
}

/** How long an invite stays claimed while one acceptance is being processed. */
const INVITE_CLAIM_SECONDS = 120;

/** Invites are valid for seven days; their KV keys live exactly that long. */
export const INVITE_LIFETIME_MS = 7 * 86400_000;
const INDEX_TTL = INVITE_LIFETIME_MS / 1000;

/** KV TTL (seconds) for an invite expiring at `expiresAt` (KV minimum: 60). */
function ttlFor(expiresAt: number): number {
  return Math.max(60, Math.ceil((expiresAt - Date.now()) / 1000));
}

function generateInviteToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function inviteKey(token: string): string {
  return `invite:${token}`;
}

/**
 * Per-group index of invite tokens. Listing pending invites reads this key
 * instead of `kv.list({ prefix })`, which is eventually consistent and can
 * lag behind a fresh write by minutes — the index keeps listing reliable.
 */
function indexKey(groupId: string): string {
  return `invite:group:${groupId}`;
}

/**
 * Tokens of a group's index. A failed read propagates: taken for an empty
 * index, it would be written back without the existing tokens, leaving those
 * invites valid but unlisted (and so impossible to revoke from the console).
 */
async function readIndex(kv: KVNamespace, groupId: string): Promise<string[]> {
  const raw = await kv.get<string[]>(indexKey(groupId), "json");
  return Array.isArray(raw) ? raw : [];
}

async function writeIndex(kv: KVNamespace, groupId: string, tokens: string[]): Promise<void> {
  await kv.put(indexKey(groupId), JSON.stringify(tokens), { expirationTtl: INDEX_TTL });
}

/**
 * Per-invite membership key, written on its own (no read-modify-write): two
 * invites created at once can both lose their index entry to the other's
 * index write, but never their marker. Listing reads both — the index for
 * fresh writes, the markers (an eventually consistent `list`) for durability.
 */
function markerPrefix(groupId: string): string {
  return `invite:by-group:${groupId}:`;
}

function listMarkers(kv: KVNamespace, groupId: string): Promise<string[]> {
  return listPrefix(kv, markerPrefix(groupId));
}

/**
 * Per-invite key under the issuing group's instance: it never moves, so the
 * group finds its invites even when moving them to a new id after a rename
 * failed halfway.
 */
function instancePrefix(instance: string): string {
  return `invite:by-instance:${instance}:`;
}

async function listPrefix(kv: KVNamespace, prefix: string): Promise<string[]> {
  const tokens: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys) {
      if (k.name.startsWith(prefix)) tokens.push(k.name.slice(prefix.length));
    }
    cursor = page.list_complete ? undefined : (page as { cursor?: string }).cursor;
  } while (cursor);
  return tokens;
}

/** Every token listed for a group: by its index, its id markers or its instance markers. */
async function groupTokens(kv: KVNamespace, groupId: string, instance?: string): Promise<string[]> {
  const [indexed, marked, owned] = await Promise.all([
    readIndex(kv, groupId),
    listMarkers(kv, groupId),
    instance ? listPrefix(kv, instancePrefix(instance)) : Promise.resolve([]),
  ]);
  return [...new Set([...indexed, ...marked, ...owned])];
}

/**
 * Write the index without the given tokens — only when it lists any of them:
 * KV writes are the scarcest quota (Workers Free), and an unchanged index
 * needs no rewrite.
 */
async function dropFromIndex(kv: KVNamespace, groupId: string, gone: string[]): Promise<void> {
  const current = await readIndex(kv, groupId);
  const kept = current.filter((t) => !gone.includes(t));
  if (kept.length !== current.length) await writeIndex(kv, groupId, kept);
}

/** Remove every listing link of an invite that is gone (index, id and instance markers). */
async function removeFromIndex(kv: KVNamespace, invite: Invite, token: string): Promise<void> {
  await kv.delete(`${markerPrefix(invite.groupId)}${token}`);
  if (invite.groupInstance) await kv.delete(`${instancePrefix(invite.groupInstance)}${token}`);
  await dropFromIndex(kv, invite.groupId, [token]);
}

export async function createInvite(kv: KVNamespace, invite: Invite): Promise<string> {
  const token = generateInviteToken();
  const ttl = { expirationTtl: ttlFor(invite.expiresAt) };
  await kv.put(inviteKey(token), JSON.stringify(invite), ttl);
  await kv.put(`${markerPrefix(invite.groupId)}${token}`, "1", ttl);
  if (invite.groupInstance) {
    await kv.put(`${instancePrefix(invite.groupInstance)}${token}`, "1", ttl);
  }
  const tokens = await readIndex(kv, invite.groupId);
  tokens.push(token);
  await writeIndex(kv, invite.groupId, tokens);
  return token;
}

/** The invite, or null when it does not exist (any more). Read errors propagate. */
export async function getInvite(kv: KVNamespace, token: string): Promise<Invite | null> {
  const raw = await kv.get<Invite>(inviteKey(token), "json");
  if (!raw) return null;
  if (Date.now() > raw.expiresAt) {
    await kv.delete(inviteKey(token));
    await removeFromIndex(kv, raw, token);
    return null;
  }
  return raw;
}

export async function consumeInvite(kv: KVNamespace, token: string): Promise<void> {
  const raw = await kv.get<Invite>(inviteKey(token), "json");
  await kv.delete(inviteKey(token));
  if (raw) await removeFromIndex(kv, raw, token);
}

/**
 * Whether an invite was issued by this very group, not by an earlier group
 * that had the same id (its index may outlive a failed cleanup). An invite from
 * before instances belongs to the group that had its id back then (`legacyId`).
 */
function issuedBy(
  invite: Invite,
  group: Pick<Group, "instance" | "legacyId"> | undefined,
): boolean {
  if (!group?.instance) return true;
  if (invite.groupInstance) return invite.groupInstance === group.instance;
  return group.legacyId === invite.groupId;
}

/**
 * All pending (unexpired) invites of a group, via the per-group index. With
 * the group given, invites of an earlier group under the same id are left
 * out (and removed): their links must not reach the new group's owners.
 */
export async function listInvites(
  kv: KVNamespace,
  groupId: string,
  group?: Pick<Group, "instance" | "legacyId">,
): Promise<Array<Invite & { token: string }>> {
  // Read errors propagate (the console shows a failure, not "no invites"),
  // and only tokens whose invite is known to be gone are pruned.
  // A pre-instance group may still have invites filed under the id it had
  // back then (a rename whose invite move failed).
  const formerId = group?.legacyId && group.legacyId !== groupId ? group.legacyId : undefined;
  const tokens = [
    ...new Set([
      ...(await groupTokens(kv, groupId, group?.instance)),
      ...(formerId ? await groupTokens(kv, formerId) : []),
    ]),
  ];
  const out: Array<Invite & { token: string }> = [];
  const stale: string[] = [];
  for (const token of tokens) {
    const invite = await getInvite(kv, token);
    // Also the group's own invites still filed under a former id (a rename
    // whose invite move failed): they are usable, so they must be listed.
    const ours =
      invite != null &&
      issuedBy(invite, group) &&
      (invite.groupId === groupId ||
        (group?.instance != null && invite.groupInstance === group.instance) ||
        (formerId != null && !invite.groupInstance && invite.groupId === formerId));
    if (invite && ours) {
      out.push({ ...invite, token });
    } else {
      // Not this group's (gone, or issued by a former holder of the id — which
      // may live on under another id): only the listing link to this id goes;
      // the invite itself is not ours to revoke and expires on its own.
      await kv.delete(`${markerPrefix(groupId)}${token}`);
      // A gone invite's marker under this group's instance goes too, or every
      // later listing would find (and clean up after) it again until it expires.
      if (!invite && group?.instance) {
        await kv.delete(`${instancePrefix(group.instance)}${token}`);
      }
      stale.push(token);
    }
  }
  // Re-read: an invite created meanwhile must stay listed.
  if (stale.length > 0) await dropFromIndex(kv, groupId, stale);
  return out;
}

/**
 * Revoke an invite. With `db`, the revocation is first recorded in the
 * idempotency store (for the invite's lifetime): an acceptance already past
 * its KV read checks it inside its member write, so it cannot still join.
 */
export async function revokeInvite(
  kv: KVNamespace,
  token: string,
  db?: D1Database,
  guards?: (db: D1Database) => D1PreparedStatement[],
): Promise<void> {
  const raw = await kv.get<Invite>(inviteKey(token), "json");
  if (db) {
    const ttl = ttlFor(raw?.expiresAt ?? Date.now() + INVITE_LIFETIME_MS);
    if (guards && canUseD1(db)) {
      // The revocation record commits only while the guards hold (e.g. the
      // revoking owner still is one): a request authorized before a role
      // change can no longer act after it.
      await db.batch([...guards(db), recordStatement(db, revokedKey(token), ttl)]);
    } else {
      await idempotencyStore(db, kv).claim(revokedKey(token), ttl);
    }
  }
  await kv.delete(inviteKey(token));
  if (raw) await removeFromIndex(kv, raw, token);
}

/**
 * Re-point every pending invite of a group to its new id (group rename).
 * Best-effort: a failure leaves the old invites in place (they will be
 * rejected as group-missing after the rename).
 */
export async function migrateInvites(
  kv: KVNamespace,
  from: string,
  to: string,
  group?: Pick<Group, "instance" | "legacyId">,
): Promise<void> {
  try {
    const tokens = await groupTokens(kv, from);
    if (tokens.length === 0) {
      await kv.delete(indexKey(from));
      return;
    }
    const moved: string[] = [];
    for (const token of tokens) {
      const invite = await kv.get<Invite>(inviteKey(token), "json");
      // Only the renamed group's own invites move (a former group's leftovers
      // stay behind); they get its instance, so they keep working under the
      // new id even when they date from before instances.
      if (invite && invite.groupId === from && issuedBy(invite, group)) {
        const groupInstance = invite.groupInstance ?? group?.instance;
        const ttl = { expirationTtl: ttlFor(invite.expiresAt) };
        await kv.put(
          inviteKey(token),
          JSON.stringify({ ...invite, groupId: to, groupInstance }),
          ttl,
        );
        await kv.put(`${markerPrefix(to)}${token}`, "1", ttl);
        if (groupInstance) await kv.put(`${instancePrefix(groupInstance)}${token}`, "1", ttl);
        await kv.delete(`${markerPrefix(from)}${token}`);
        moved.push(token);
      }
    }
    const kept = (await readIndex(kv, to)).filter((t) => !moved.includes(t));
    await kv.put(indexKey(to), JSON.stringify([...kept, ...moved]), {
      expirationTtl: INDEX_TTL,
    });
    await kv.delete(indexKey(from));
  } catch (err) {
    log.warn({ err, from, to }, "Failed to migrate invites on group rename");
  }
}

/** Revoke every pending invite of a deleted group. */
export async function deleteGroupInvites(
  kv: KVNamespace,
  groupId: string,
  group?: Pick<Group, "instance" | "legacyId">,
): Promise<void> {
  const instance = group?.instance;
  try {
    for (const token of await groupTokens(kv, groupId, instance)) {
      // Only the deleted group's own invites are revoked: one listed under
      // its id may have been issued by a group that lives on under another.
      const invite = await kv.get<Invite>(inviteKey(token), "json");
      if (
        invite &&
        issuedBy(invite, group) &&
        (invite.groupId === groupId || (instance != null && invite.groupInstance === instance))
      ) {
        await kv.delete(inviteKey(token));
      }
      await kv.delete(`${markerPrefix(groupId)}${token}`);
      if (instance) await kv.delete(`${instancePrefix(instance)}${token}`);
    }
    await kv.delete(indexKey(groupId));
  } catch (err) {
    log.warn({ err, groupId }, "Failed to delete invites of a removed group");
  }
}

/**
 * Adds the accepting user to the invited group (or upgrades their role when
 * they are already a viewer) and consumes the invite. The invited role is
 * never an owner — ownership stays with the inviter's discretion.
 *
 * The invite is claimed atomically before the membership changes, so two
 * people accepting the same link at once cannot both join; the member write is
 * a compare-and-swap on the group, so it never reverts a concurrent edit.
 */
export async function acceptInvite(
  env: Pick<Env, "KV" | "DB">,
  token: string,
  userId: string,
  login: string,
  /** The login identity checks may use ("" when it is not trusted as this user's). */
  matchLogin = login,
): Promise<
  | { ok: true; groupId: string; groupInstance?: string; role: "admin" | "viewer" }
  | { ok: false; reason: "invalid" | "group-missing" | "conflict" }
> {
  const kv = env.KV;
  const invite = await getInvite(kv, token);
  if (!invite) return { ok: false, reason: "invalid" };

  const claims = idempotencyStore(env.DB, kv);
  const claimKey = `invite-used:${token}`;
  // A short claim while joining, confirmed for the invite's lifetime once
  // used: an attempt that fails and cannot give the claim back blocks the
  // invite for a couple of minutes, not until it expires.
  if ((await claimOnce(claims, claimKey, INVITE_CLAIM_SECONDS)) !== "claimed") {
    return { ok: false, reason: "invalid" };
  }
  if (await claims.has(revokedKey(token))) {
    await claims.release(claimKey).catch(() => undefined);
    return { ok: false, reason: "invalid" };
  }

  let joined = false;
  let joinedId: string | undefined;
  let joinedInstance: string | undefined;
  /** The member who issued the invite is no longer an owner (it is void then). */
  const issuerGone = async (): Promise<boolean> => {
    const by = invite.issuer && "userId" in invite.issuer ? invite.issuer : null;
    if (!by) return false;
    const group = (await loadGroups(kv, { fresh: true })).find((g) =>
      invite.groupInstance ? g.instance === invite.groupInstance : g.legacyId === invite.groupId,
    );
    return !group || memberRole(group, by.userId, by.login) !== "owner";
  };
  try {
    // The invited group is the instance the invite was issued for, under
    // whatever id it has now. An invite from before instances only applies to
    // a group that existed back then, never to one created since.
    const groups = await loadGroups(kv, { fresh: true });
    const target = invite.groupInstance
      ? groups.find((g) => g.instance === invite.groupInstance)
      : groups.find((g) => g.legacyId === invite.groupId);
    // Its group instance is gone for good: the invite can never be used.
    if (!target && invite.groupInstance) throw new StaleInviteError();
    if (!target) return { ok: false, reason: "group-missing" };
    // The invite is confirmed as used in the same transaction that adds the
    // member — only when that write went through (`changes()`: the member
    // update right before; a lost compare-and-swap changes nothing) and the
    // member is there after it: no crash between the two can leave a member
    // added and the invite still open, nor a retried write consume it unused.
    const confirmWithJoin = (db: D1Database): D1PreparedStatement[] => [
      db
        .prepare(
          `INSERT INTO dedup_keys (key, claimed_at, expires_at)
           SELECT ?, ?, ? WHERE changes() > 0 AND EXISTS (
             SELECT 1 FROM (SELECT id, CASE WHEN json_valid(data) THEN data ELSE '{}' END AS data FROM d1_groups) g, json_each(g.data, '$.members') m
             WHERE g.id = ? AND json_extract(m.value, '$.userId') = ?)
           ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at`,
        )
        .bind(acceptedKey(claimKey), Date.now(), invite.expiresAt, target.id, userId),
    ];
    // And it only commits while the invite is unused and not revoked: an
    // earlier acceptance whose answer was lost (its claim given back, its use
    // committed), or a revocation that landed after the KV read, aborts it.
    const issuer = invite.issuer && "userId" in invite.issuer ? invite.issuer : null;
    const unusedGuard = (db: D1Database): D1PreparedStatement[] => [
      db
        .prepare(
          "SELECT CASE WHEN EXISTS (SELECT 1 FROM dedup_keys WHERE key IN (?, ?) AND expires_at > ?) THEN json('invite used') ELSE 1 END AS ok",
        )
        .bind(acceptedKey(claimKey), revokedKey(token), Date.now()),
      ...(issuer
        ? [memberRoleStatement(db, target.id, issuer.userId, issuer.login, ["owner"])]
        : []),
    ];
    const updated = await updateGroup(
      kv,
      target.id,
      (group) => {
        const sameInstance = invite.groupInstance
          ? group.instance === invite.groupInstance
          : group.legacyId === invite.groupId;
        if (!sameInstance) throw new StaleInviteError();
        const members = normalizeGroupMembers(group);
        const idx = members.findIndex((m) => memberMatches(m, userId, matchLogin));
        if (idx >= 0) {
          if (invite.role === "admin" && members[idx]!.role === "viewer") {
            members[idx]!.role = "admin";
          }
          members[idx]!.userId ??= userId;
        } else {
          if (members.some((m) => m.login.toLowerCase() === login.toLowerCase())) {
            throw new MemberConflictError();
          }
          // Bound to the account that accepted, not to its (renamable) login.
          members.push({ login, role: invite.role, userId });
        }
        return {
          ...group,
          members,
          adminIds: members.filter((m) => m.role === "owner").map((m) => m.login),
        };
      },
      { guards: unusedGuard, after: confirmWithJoin },
    );
    joined = updated != null;
    joinedId = updated?.id;
    joinedInstance = updated?.instance;
  } catch (err) {
    // The invite stays usable once the owner resolved the conflict.
    if (err instanceof MemberConflictError) return { ok: false, reason: "conflict" };
    // Used meanwhile (by an acceptance whose answer was lost).
    if (
      err instanceof ConfigConflictError &&
      ((await claims.has(acceptedKey(claimKey))) ||
        (await claims.has(revokedKey(token))) ||
        (await issuerGone()))
    ) {
      return { ok: false, reason: "invalid" };
    }
    if (!(err instanceof StaleInviteError)) throw err;
    await consumeInvite(kv, token);
    return { ok: false, reason: "invalid" };
  } finally {
    if (!joined) await claims.release(claimKey).catch(() => undefined);
  }
  if (!joined) return { ok: false, reason: "group-missing" };
  await confirmClaim(claims, claimKey, ttlFor(invite.expiresAt)).catch((err: unknown) =>
    log.warn({ err }, "Failed to confirm an invite claim"),
  );
  await consumeInvite(kv, token);
  return {
    ok: true,
    groupId: joinedId ?? invite.groupId,
    groupInstance: joinedInstance,
    role: invite.role,
  };
}
