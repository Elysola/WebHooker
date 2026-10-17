import type { AuditEntry } from "~/types";

export function useAuditApi() {
  const { needLogin } = useAuthState();
  const entries = ref<AuditEntry[]>([]);
  const loading = ref(false);
  const error = ref("");
  // Bumped by every load, so only the latest request may land (an older one,
  // e.g. from the page the user just left, must not overwrite newer data).
  let request = 0;

  async function load(limit = 50, groupId?: string): Promise<void> {
    const mine = ++request;
    loading.value = true;
    error.value = "";
    needLogin.value = false;
    try {
      let url = `/admin/api/audit?limit=${limit}`;
      if (groupId) url += `&groupId=${encodeURIComponent(groupId)}`;
      const data = await apiFetch<{ audit?: AuditEntry[] }>(url);
      if (mine === request) entries.value = data.audit ?? [];
    } catch (err) {
      if (mine === request && !needLogin.value)
        error.value = err instanceof Error ? err.message : String(err);
    } finally {
      if (mine === request) loading.value = false;
    }
  }

  return { entries, loading, needLogin, error, load };
}
