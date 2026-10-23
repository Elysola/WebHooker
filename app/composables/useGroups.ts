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

  /** Apply a write's result locally; a load that started earlier must not land. */
  function settle(next: Group[]): void {
    request++;
    loading.value = false;
    groups.value = next;
  }

  /** Reload after a refused write (409): someone changed the group meanwhile. */
  async function guard<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (isConflict(err)) void load();
      throw err;
    }
  }

  /**
   * Update one group. Its `revision` (from the last load) travels along, so an
   * edit made from a stale copy is refused instead of reverting newer changes.
   */
  async function update(group: Group): Promise<Group> {
    const data = await guard(() =>
      apiFetch<{ group: Group }>(`/admin/api/groups/${encodeURIComponent(group.id)}`, {
        method: "PUT",
        body: JSON.stringify({ group }),
      }),
    );
    settle(groups.value.map((g) => (g.id === data.group.id ? data.group : g)));
    return data.group;
  }

  /** Create one group (super admins). */
  async function create(group: Group): Promise<Group> {
    const data = await apiFetch<{ group: Group }>("/admin/api/groups", {
      method: "POST",
      body: JSON.stringify({ group }),
    });
    settle([...groups.value.filter((g) => g.id !== data.group.id), data.group]);
    return data.group;
  }

  /**
   * Delete one group with its routes. `revision` (the group) and
   * `routesRevision` (its routes) are what the deletion was confirmed on: if
   * either changed meanwhile, the server refuses (409) instead of deleting
   * something nobody saw.
   */
  async function remove(
    id: string,
    revision?: string,
    routesRevision?: string,
    version?: number | null,
  ): Promise<void> {
    const query = new URLSearchParams();
    if (revision) query.set("revision", revision);
    if (routesRevision) query.set("routesRevision", routesRevision);
    if (version != null) query.set("version", String(version));
    const qs = query.toString();
    await guard(() =>
      apiFetch(`/admin/api/groups/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`, {
        method: "DELETE",
      }),
    );
    settle(groups.value.filter((g) => g.id !== id));
  }

  /**
   * Rename a group; routes, webhook secret and invites follow automatically.
   * `revision` is the group's revision the rename was decided on.
   */
  async function rename(oldId: string, newId: string, revision?: string): Promise<Group> {
    const data = await guard(() =>
      apiFetch<{ group: Group }>(`/admin/api/groups/${encodeURIComponent(oldId)}/rename`, {
        method: "PUT",
        body: JSON.stringify({ newId, revision }),
      }),
    );
    // Show the group under its new id right away (a later step may still fail).
    settle(groups.value.map((g) => (g.id === oldId ? data.group : g)));
    return data.group;
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
    update,
    create,
    remove,
    rename,
  };
}
