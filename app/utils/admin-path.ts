/** Top-level pages of the admin console. */
export type AdminView = "overview" | "groups" | "logs" | "audit" | "metrics";

const VIEWS: readonly string[] = ["overview", "groups", "logs", "audit", "metrics"];

/**
 * Read the console page from the segments after /admin: `[]` (overview),
 * `["groups"]`, `["groups", groupId]` (that group's routes), `["logs"]`,
 * `["audit"]`, `["metrics"]`. Anything else is no console page (null → 404).
 */
export function parseAdminPath(
  slug: string | string[] | undefined,
): { view: AdminView; groupId: string | null } | null {
  // A trailing slash adds an empty segment.
  const [view, groupId, ...rest] = (Array.isArray(slug) ? slug : slug ? [slug] : []).filter(
    Boolean,
  );
  if (!view) return { view: "overview", groupId: null };
  if (!VIEWS.includes(view) || rest.length) return null;
  // Only groups have sub-pages.
  if (groupId !== undefined && view !== "groups") return null;
  return { view: view as AdminView, groupId: groupId ?? null };
}

export function adminGroupPath(groupId: string): string {
  return `/admin/groups/${encodeURIComponent(groupId)}`;
}
