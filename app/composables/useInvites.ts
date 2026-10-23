import type { GroupInvite } from "~/types";

export function useInvitesApi() {
  const loading = ref(false);
  const error = ref("");

  async function create(groupId: string, role: "admin" | "viewer"): Promise<string> {
    loading.value = true;
    error.value = "";
    try {
      const data = await apiFetch<{ url?: string }>(
        `/admin/api/groups/${encodeURIComponent(groupId)}/invites`,
        { method: "POST", body: JSON.stringify({ role }) },
      );
      return data.url ?? "";
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      loading.value = false;
    }
  }

  /** Throws when the list cannot be read: never shown as "no invites". */
  async function list(groupId: string): Promise<GroupInvite[]> {
    loading.value = true;
    error.value = "";
    try {
      const data = await apiFetch<{ invites?: GroupInvite[] }>(
        `/admin/api/groups/${encodeURIComponent(groupId)}/invites`,
      );
      return data.invites ?? [];
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function revoke(token: string): Promise<void> {
    loading.value = true;
    error.value = "";
    try {
      await apiFetch(`/admin/api/invites/${encodeURIComponent(token)}`, { method: "DELETE" });
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      loading.value = false;
    }
  }

  return { loading, error, create, list, revoke };
}
