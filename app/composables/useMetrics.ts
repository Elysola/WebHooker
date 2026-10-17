import type { DeliveryMetrics } from "~/types";

export function useMetrics() {
  const { needLogin } = useAuthState();
  const metrics = ref<DeliveryMetrics | null>(null);
  const loading = ref(false);
  const error = ref("");
  // Bumped by every load, so only the latest request may land: Overview
  // (all groups) and Stats (maybe one group) share this state.
  let request = 0;

  async function load(groupId?: string): Promise<void> {
    const mine = ++request;
    loading.value = true;
    error.value = "";
    needLogin.value = false;
    try {
      const qs = groupId ? `?groupId=${encodeURIComponent(groupId)}` : "";
      const data = await apiFetch<{ metrics?: DeliveryMetrics }>(`/admin/api/metrics${qs}`);
      if (mine === request) metrics.value = data.metrics ?? null;
    } catch (err) {
      if (mine === request && !needLogin.value)
        error.value = err instanceof Error ? err.message : String(err);
    } finally {
      if (mine === request) loading.value = false;
    }
  }

  return { metrics, loading, error, load };
}
