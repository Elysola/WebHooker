import type { Group } from "../types";
import { updateGroup } from "./groups";

/**
 * Per-group webhook tenant secrets. A group can opt into its own webhook
 * ingress (`POST /webhook/{groupId}`) with an independent secret, so SaaS
 * users can configure their own GitHub/Gitea/custom webhooks without sharing
 * (or even knowing) the operator's global secrets.
 *
 * Secrets are keyed by the group's immutable `instance`: a rename keeps the
 * secret without moving anything, and a group re-created under a former id
 * never inherits the old group's secret. A secret stored before instances
 * existed (`tenant:{groupId}`) is still read — only by the group that had that
 * id back then (`legacyId`) — until the secret is regenerated or removed. It is
 * never copied over: a lazy copy could race a rotation and resurrect the old
 * secret.
 */
type TenantGroup = Pick<Group, "id" | "instance" | "legacyId" | "webhookSecret">;

const LEGACY_KEY = (groupId: string): string => `tenant:${groupId}`;
const INSTANCE_KEY = (instance: string): string => `tenant:i:${instance}`;

function keyOf(group: TenantGroup): string {
  return group.instance ? INSTANCE_KEY(group.instance) : LEGACY_KEY(group.id);
}

/** 32 random bytes → 64 hex chars. */
export function generateTenantSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The group's webhook secret, or null when it has none. Read errors propagate:
 * a failed read must never pass for "no secret".
 */
export async function getTenantSecret(kv: KVNamespace, group: TenantGroup): Promise<string | null> {
  // Stored with the group (how secrets are written now); KV keys are read for
  // secrets set before that.
  // "" is an explicit "none" (removed): no older KV copy counts then.
  if (group.webhookSecret != null) return group.webhookSecret || null;
  const secret = await kv.get(keyOf(group), "text");
  // Only the group that had the id before instances may use a pre-instance
  // secret — not a group created since, nor one renamed to that id.
  if (secret || !group.instance || !group.legacyId) return secret;
  return kv.get(LEGACY_KEY(group.legacyId), "text");
}

/**
 * The pre-instance key the group's secret may still be found under. Keys
 * under its current id are left alone: they may belong to the group that had
 * that id before instances (now under another id).
 */
function legacyKeys(group: TenantGroup): string[] {
  return group.legacyId ? [LEGACY_KEY(group.legacyId)] : [];
}

/** Generate (or regenerate) the group's webhook secret. */
export async function setTenantSecret(kv: KVNamespace, group: TenantGroup): Promise<string> {
  const secret = generateTenantSecret();
  await kv.put(keyOf(group), secret);
  // The new secret replaces the group's pre-instance one.
  if (group.instance) for (const key of legacyKeys(group)) await kv.delete(key);
  return secret;
}

/**
 * Generate (or regenerate) the group's webhook secret, stored with the group
 * in a compare-and-swap: `check` sees the group as it is at that moment and
 * may throw (e.g. the writer is no longer an owner), so a request authorized
 * earlier can never overwrite a later rotation. Older KV copies are dropped.
 * Null when the group does not exist.
 */
export async function rotateTenantSecret(
  kv: KVNamespace,
  groupId: string,
  check: (current: Group) => void,
): Promise<string | null> {
  const secret = generateTenantSecret();
  const saved = await updateGroup(kv, groupId, (g) => {
    check(g);
    return { ...g, webhookSecret: secret };
  });
  if (!saved) return null;
  await deleteTenantSecret(kv, saved).catch(() => undefined);
  return secret;
}

/** Remove the group's webhook secret (the same compare-and-swap as rotation). */
export async function removeTenantSecret(
  kv: KVNamespace,
  groupId: string,
  check: (current: Group) => void,
): Promise<boolean> {
  const saved = await updateGroup(kv, groupId, (g) => {
    check(g);
    return { ...g, webhookSecret: null };
  });
  if (!saved) return false;
  await deleteTenantSecret(kv, saved);
  return true;
}

/** Drop the KV copies of a group's secret (from before secrets lived with the group). */
export async function deleteTenantSecret(kv: KVNamespace, group: TenantGroup): Promise<void> {
  await kv.delete(keyOf(group));
  for (const key of legacyKeys(group)) await kv.delete(key);
}
