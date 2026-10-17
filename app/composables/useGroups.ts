import type { Group, GroupRole } from "~/types";

export function useGroupsApi() {
  const { needLogin } = useAuthState();
  const groups = ref<Group[]>([]);
  const isSuper = ref(false);
  /** groupId → role of the signed-in user (absent for super admins). */
  const roles = ref<Record<string, GroupRole>>({});
  const loading = ref(false);
  const error = ref("");
  /** A load has succeeded: an id missing from `groups` really is unknown. */
  const loaded = ref(false);
  // Bumped by every load and save, so only the latest request may land: a
  // load that started before a save must not bring back the old groups.
  let request = 0;

  function roleOf(groupId: string): GroupRole | undefined {
    return isSuper.value ? "owner" : roles.value[groupId];
  }

  function canEditGroup(groupId: string): boolean {
    const r = roleOf(groupId);
    return isSuper.value || r === "owner";
  }

  function canEditRoutes(groupId: string): boolean {
    const r = roleOf(groupId);
    return isSuper.value || r === "owner" || r === "admin";
  }

  async function load(): Promise<void> {
    const mine = ++request;
    loading.value = true;
    error.value = "";
    needLogin.value = false;
    try {
      const data = await apiFetch<{
        groups?: Group[];
        isSuper?: boolean;
        roles?: Record<string, GroupRole>;
      }>("/admin/api/groups");
      if (mine !== request) return;
      groups.value = data.groups ?? [];
      isSuper.value = data.isSuper ?? false;
      roles.value = data.roles ?? {};
      loaded.value = true;
    } catch (err) {
      if (mine === request && !needLogin.value)
        error.value = err instanceof Error ? err.message : String(err);
    } finally {
      if (mine === request) loading.value = false;
    }
  }

  async function save(next: Group[]): Promise<void> {
    await apiFetch("/admin/api/groups", {
      method: "PUT",
      body: JSON.stringify({ groups: next }),
    });
    request++;
    loading.value = false;
    groups.value = next;
  }

  /** Rename a group; routes, webhook secret and invites follow automatically. */
  async function rename(oldId: string, newId: string): Promise<void> {
    await apiFetch(`/admin/api/groups/${encodeURIComponent(oldId)}/rename`, {
      method: "PUT",
      body: JSON.stringify({ newId }),
    });
  }

  return {
    groups,
    isSuper,
    roles,
    roleOf,
    canEditGroup,
    canEditRoutes,
    loading,
    loaded,
    needLogin,
    error,
    load,
    save,
    rename,
  };
}
