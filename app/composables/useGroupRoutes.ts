import type { Route } from "~/types";

export function useGroupRoutesApi() {
  const { needLogin } = useAuthState();
  const routes = ref<Route[]>([]);
  const loading = ref(false);
  const error = ref("");
  /** Group whose routes are shown; responses for any other group are dropped. */
  const groupId = ref<string | null>(null);
  /** Group whose routes were last loaded (or saved) successfully. */
  const loadedId = ref<string | null>(null);
  /**
   * Server revision of the shown routes. Every save sends it back, so a save
   * built on a list someone else has changed meanwhile is refused (409)
   * instead of overwriting their change.
   */
  let revision: string | undefined;
  // Bumped by every load/clear, so only the latest request may land.
  let request = 0;

  /**
   * The shown routes are the group's real routes. Saving replaces a group's
   * whole route list, so a write is only safe from here — never from the
   * empty list of a load still running or one that failed.
   */
  const ready = computed(() => !!groupId.value && loadedId.value === groupId.value && !error.value);

  async function load(id: string): Promise<void> {
    const mine = ++request;
    if (groupId.value !== id) {
      routes.value = [];
      loadedId.value = null;
      revision = undefined;
    }
    groupId.value = id;
    loading.value = true;
    error.value = "";
    needLogin.value = false;
    try {
      const data = await apiFetch<{ routes?: Route[]; revision?: string }>(
        `/admin/api/groups/${encodeURIComponent(id)}/routes`,
      );
      if (mine !== request) return;
      routes.value = data.routes ?? [];
      revision = data.revision;
      loadedId.value = id;
    } catch (err) {
      if (mine === request && !needLogin.value)
        error.value = err instanceof Error ? err.message : String(err);
    } finally {
      if (mine === request) loading.value = false;
    }
  }

  /** Forget the shown group (its page was left); late responses are ignored. */
  function clear(): void {
    request++;
    groupId.value = null;
    loadedId.value = null;
    routes.value = [];
    revision = undefined;
    loading.value = false;
    error.value = "";
  }

  async function save(id: string, next: Route[]): Promise<void> {
    let data: { routes?: Route[]; revision?: string };
    try {
      data = await apiFetch<{ routes?: Route[]; revision?: string }>(
        `/admin/api/groups/${encodeURIComponent(id)}/routes`,
        {
          method: "PUT",
          body: JSON.stringify({
            routes: next,
            revision: groupId.value === id ? revision : undefined,
          }),
        },
      );
    } catch (err) {
      // Someone changed the routes meanwhile: show theirs, nothing was written.
      if (isConflict(err) && groupId.value === id) void load(id);
      throw err;
    }
    // The page may have moved on to another group while the request ran.
    if (groupId.value !== id) return;
    // What was just written is the newest state: a load of this group that
    // started earlier may return the old routes, so it must not land.
    request++;
    loading.value = false;
    error.value = "";
    routes.value = data.routes ?? next;
    revision = data.revision;
    loadedId.value = id;
  }

  return { routes, loading, needLogin, error, groupId, ready, load, clear, save };
}
