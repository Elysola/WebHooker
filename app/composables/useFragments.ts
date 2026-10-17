import type { NamedFragment } from "~/types";

export function useFragmentsApi() {
  const { needLogin } = useAuthState();
  const fragments = ref<NamedFragment[]>([]);
  const loading = ref(false);
  const saving = ref(false);
  const error = ref("");
  /** Group whose fragments are shown; responses for any other group are dropped. */
  const shownGroupId = ref<string | null>(null);
  /** Group whose fragments were last loaded (or saved) successfully. */
  const loadedGroupId = ref<string | null>(null);
  // Bumped by every load/save, so only the latest request may land.
  let request = 0;

  /**
   * Whether a write may start for `groupId`: the shown list is that group's
   * real fragments and nothing is loading or saving. Saving replaces a group's
   * whole fragment list, so each write must build on the previous one.
   */
  function readyFor(groupId: string): boolean {
    return (
      shownGroupId.value === groupId &&
      loadedGroupId.value === groupId &&
      !error.value &&
      !loading.value &&
      !saving.value
    );
  }

  async function load(groupId: string): Promise<void> {
    const mine = ++request;
    if (shownGroupId.value !== groupId) {
      fragments.value = [];
      loadedGroupId.value = null;
    }
    shownGroupId.value = groupId;
    loading.value = true;
    error.value = "";
    needLogin.value = false;
    try {
      const data = await apiFetch<{ fragments?: NamedFragment[] }>(
        `/admin/api/groups/${encodeURIComponent(groupId)}/fragments`,
      );
      if (mine !== request) return;
      fragments.value = data.fragments ?? [];
      loadedGroupId.value = groupId;
    } catch (err) {
      if (mine === request && !needLogin.value)
        error.value = err instanceof Error ? err.message : String(err);
    } finally {
      if (mine === request) loading.value = false;
    }
  }

  async function save(groupId: string, next: NamedFragment[]): Promise<void> {
    saving.value = true;
    try {
      await apiFetch(`/admin/api/groups/${encodeURIComponent(groupId)}/fragments`, {
        method: "PUT",
        body: JSON.stringify({ fragments: next }),
      });
    } finally {
      saving.value = false;
    }
    if (shownGroupId.value !== groupId) return;
    request++;
    loading.value = false;
    error.value = "";
    fragments.value = next;
    loadedGroupId.value = groupId;
  }

  return { fragments, loading, needLogin, error, readyFor, load, save };
}
