import type { SendRecord } from "~/types";

export function useSendLogs() {
  const { needLogin } = useAuthState();
  const logs = ref<SendRecord[]>([]);
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
      let url = `/admin/api/logs?limit=${limit}`;
      if (groupId) url += `&groupId=${encodeURIComponent(groupId)}`;
      const data = await apiFetch<{ logs?: SendRecord[] }>(url);
      if (mine === request) logs.value = data.logs ?? [];
    } catch (err) {
      if (mine === request && !needLogin.value)
        error.value = err instanceof Error ? err.message : String(err);
    } finally {
      if (mine === request) loading.value = false;
    }
  }

  async function loadById(id: number): Promise<SendRecord | null> {
    const data = await apiFetch<{ log?: SendRecord }>(`/admin/api/logs/${id}`);
    return data.log ?? null;
  }

  return { logs, loading, needLogin, error, load, loadById };
}
