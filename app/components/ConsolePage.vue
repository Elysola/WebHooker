<template>
  <div class="console-shell">
    <aside class="console-sidebar">
      <NuxtLink class="console-brand" to="/">
        <AppLogo :size="32" />
        <span
          ><strong>WebHooker</strong><small>{{ t("app.tagline") }}</small></span
        >
      </NuxtLink>
      <p class="console-nav-label">{{ t("app.tagline") }}</p>
      <nav class="console-nav">
        <button
          v-for="n in nav"
          :key="n.id"
          class="console-nav-item"
          :class="{ active: n.id === activeNav }"
          @click="switchView(n.id)"
        >
          <component :is="navIcon(n.id)" :size="17" :stroke-width="1.8" />
          {{ n.label }}
        </button>
      </nav>
      <div class="console-sidebar-footer">
        <a href="/admin/logout"><LogOut :size="16" />{{ t("app.signOut") }}</a>
      </div>
    </aside>

    <div class="console-main">
      <header class="console-topbar">
        <div>
          <p class="console-kicker">WebHooker / {{ activeNav }}</p>
          <h1>{{ pageTitle }}</h1>
        </div>
        <div class="console-actions">
          <RcBadge
            v-if="!needLogin && loadingAny"
            variant="soft"
            size="sm"
            dot
            class="console-status"
          >
            {{ t("status.loading") }}
          </RcBadge>
          <RcButton v-if="view === 'overview'" variant="ghost" size="sm" @click="refreshOverview"
            ><RefreshCw :size="15" />{{ t("metrics.refresh") }}</RcButton
          >
          <ThemeToggle />
          <RcButton variant="ghost" size="sm" @click="toggle"
            ><Languages :size="15" />{{ t("app.langToggle") }}</RcButton
          >
          <RcButton
            v-if="!needLogin && selectedGroup && canEditRoutes(selectedGroup.id)"
            @click="openNew"
            ><Plus :size="16" />{{ t("app.newRoute") }}</RcButton
          >
          <RcButton
            v-if="!needLogin && !selectedGroup && view === 'groups' && isSuper"
            @click="openNewGroup"
            ><Plus :size="16" />{{ t("app.newGroup") }}</RcButton
          >
        </div>
      </header>

      <div class="console-mobile-nav">
        <RcTabs
          :model-value="activeNav"
          :items="mobileNav"
          @update:model-value="switchView($event as View)"
        />
      </div>

      <main class="console-content">
        <div v-if="needLogin" class="console-login">
          <RcCard variant="outline" padding="lg" class="console-login-card">
            <template #header><LockKeyhole :size="24" /></template>
            <h2>{{ t("login.title") }}</h2>
            <p>{{ forbidden ? t("login.forbidden") : t("login.prompt") }}</p>
            <a href="/admin/login"
              ><RcButton size="lg"><LogIn :size="17" />{{ t("login.button") }}</RcButton></a
            >
          </RcCard>
        </div>

        <template v-else>
          <AdminHome
            v-if="view === 'overview'"
            :key="refreshKey"
            :groups="groups"
            :logs="logs"
            :metrics="metrics"
            :groups-loading="groupsLoading"
            :logs-loading="logsLoading"
            :metrics-loading="metricsLoading"
          />

          <template v-else-if="selectedGroup">
            <section class="console-context-bar">
              <div>
                <RcButton variant="ghost" size="sm" @click="exitGroup"
                  ><ArrowLeft :size="15" />{{ t("group.back") }}</RcButton
                >
                <p>{{ t("group.routesIn", { name: selectedGroup.name }) }}</p>
              </div>
              <RcBadge :variant="groupRoutesLoading ? 'soft' : 'success'" size="sm" dot>{{
                groupRoutes.length
              }}</RcBadge>
            </section>

            <p v-if="groupRoutesError" class="err">{{ groupRoutesError }}</p>

            <section class="route-list">
              <RouteCard
                v-for="(r, i) in groupRoutes"
                :key="r.id"
                :route="r"
                :at-first="i === 0"
                :at-last="i === groupRoutes.length - 1"
                :readonly="!canEditRoutes(selectedGroup.id)"
                :style="{ animationDelay: i * 45 + 'ms' }"
                @toggle="onToggle"
                @edit="openEdit"
                @delete="onDelete"
                @move="onMove"
              />
            </section>

            <section v-if="!groupRoutesLoading && !groupRoutes.length" class="console-empty">
              <RcEmptyState :title="t('routes.emptyGroup')">
                <RcButton v-if="canEditRoutes(selectedGroup.id)" @click="openNew"
                  ><Plus :size="16" />{{ t("routes.createFirst") }}</RcButton
                >
              </RcEmptyState>
            </section>

            <MembersPanel
              :group="selectedGroup"
              :can-edit="canEditGroup(selectedGroup.id)"
              :saving="savingGroup"
              @save="onSaveGroupFromPanel"
            />

            <WebhookPanel
              v-if="canEditGroup(selectedGroup.id)"
              :group-id="selectedGroup.id"
              :can-edit="canEditGroup(selectedGroup.id)"
            />
          </template>

          <template v-else-if="view === 'groups'">
            <section class="console-context-bar">
              <div>
                <p>{{ t("kpi.groups") }}</p>
                <strong>{{ groups.length }}</strong>
              </div>
              <RcBadge v-if="groupsLoading" variant="soft" size="sm" dot>{{
                t("status.loading")
              }}</RcBadge>
            </section>

            <p v-if="groupsError" class="err">{{ groupsError }}</p>

            <section class="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
              <RcCard
                v-for="(g, i) in groups"
                :key="g.id"
                variant="outline"
                :hoverable="true"
                padding="none"
                class="console-group-card transition-all hover:border-border-strong hover:shadow-xs"
                :style="{ animationDelay: i * 35 + 'ms' }"
                @click="enterGroup(g)"
              >
                <div class="p-4 space-y-3">
                  <div class="flex items-start justify-between gap-2.5">
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <span class="truncate text-[15px] font-semibold text-text">{{
                          g.name || t("route.untitled")
                        }}</span>
                        <RcBadge v-if="roleOf(g.id)" variant="brand" size="xs">
                          {{ t("role.badge", { role: t("roles." + roleOf(g.id)) }) }}
                        </RcBadge>
                      </div>
                      <div class="mt-0.5 font-mono text-[11px] text-faint truncate">{{ g.id }}</div>
                    </div>
                    <div
                      v-if="canEditGroup(g.id)"
                      class="flex shrink-0 items-center gap-1"
                      @click.stop
                    >
                      <RcButton
                        variant="ghost"
                        size="icon"
                        class="h-7 w-7 text-muted hover:text-text"
                        :title="t('groupEditor.editTitle')"
                        @click="openEditGroup(g)"
                      >
                        <Pencil :size="13.5" />
                      </RcButton>
                      <RcButton
                        variant="ghost"
                        color="error"
                        size="icon"
                        class="h-7 w-7 text-muted hover:text-bad"
                        @click="onDeleteGroup(g)"
                      >
                        <Trash2 :size="13.5" />
                      </RcButton>
                    </div>
                  </div>

                  <div class="space-y-1.5 text-xs">
                    <div class="flex items-center justify-between text-[11.5px]">
                      <span class="text-faint font-semibold">{{ t("groups.members") }}</span>
                      <span class="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-text">
                        {{ (g.members ?? []).length || (g.adminIds || []).length || 0 }}
                      </span>
                    </div>
                    <div
                      v-if="g.owners?.length"
                      class="flex items-center justify-between text-[11.5px]"
                    >
                      <span class="text-faint font-semibold">{{ t("groups.owners") }}</span>
                      <span
                        class="truncate max-w-[170px] text-muted text-right font-mono text-[11px]"
                      >
                        {{ g.owners.join(", ") }}
                      </span>
                    </div>
                  </div>

                  <div
                    class="flex items-center justify-between pt-2 border-t border-border/70 text-xs"
                  >
                    <span class="text-faint text-[11px]">{{ t("overview.routes") }}</span>
                    <span
                      class="inline-flex items-center gap-1 font-semibold text-accent hover:underline"
                    >
                      {{ t("groups.open") }}
                      <ArrowRight :size="12" />
                    </span>
                  </div>
                </div>
              </RcCard>
            </section>

            <section v-if="!groupsLoading && !groups.length" class="console-empty">
              <RcEmptyState :title="t('groups.empty')"
                ><RcButton v-if="isSuper" @click="openNewGroup"
                  ><Plus :size="16" />{{ t("groups.createFirst") }}</RcButton
                ></RcEmptyState
              >
            </section>
          </template>

          <template v-else-if="view === 'logs'">
            <section v-if="logsLoading" class="console-context-bar">
              <RcBadge variant="soft" size="sm" dot>{{ t("status.loading") }}</RcBadge>
            </section>
            <SendLogs
              :logs="logs"
              :loading="logsLoading"
              :error="logsError"
              :groups="groups"
              :selected-group-id="logFilterGroup"
              @refresh="loadLogs(50, logFilterGroup || undefined)"
              @filter="loadLogs(50, logFilterGroup || undefined)"
              @update:selected-group-id="logFilterGroup = $event"
            />
          </template>

          <template v-else-if="view === 'audit'">
            <AuditLog
              :entries="auditEntries"
              :loading="auditLoading"
              :error="auditError"
              :groups="groups"
              :selected-group-id="auditFilterGroup"
              @refresh="loadAudit(50, auditFilterGroup || undefined)"
              @filter="loadAudit(50, auditFilterGroup || undefined)"
              @update:selected-group-id="auditFilterGroup = $event"
            />
          </template>

          <template v-else-if="view === 'metrics'">
            <MetricsPanel
              :metrics="metrics"
              :loading="metricsLoading"
              :error="metricsError"
              :groups="groups"
              :selected-group-id="metricsFilterGroup"
              @refresh="loadMetrics(metricsFilterGroup || undefined)"
              @filter="loadMetrics(metricsFilterGroup || undefined)"
              @update:selected-group-id="metricsFilterGroup = $event"
            />
          </template>
        </template>
      </main>
    </div>

    <RouteEditor
      :open="editorOpen"
      :route="editing"
      :saving="saving"
      :group-id="selectedGroup?.id ?? null"
      @close="editorOpen = false"
      @save="onSave"
    />

    <GroupEditor
      :open="groupEditorOpen"
      :group="editingGroup"
      :saving="savingGroup"
      :super-admin="isSuper"
      @close="groupEditorOpen = false"
      @save="onSaveGroup"
    />

    <ConfirmDialog />
  </div>
</template>

<script setup lang="ts">
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  ClipboardList,
  Gauge,
  Languages,
  Layers3,
  LockKeyhole,
  LogIn,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-vue-next";
import type { Group, Route } from "~/types";
import { useAuditApi } from "~/composables/useAudit";
import WebhookPanel from "~/components/WebhookPanel.vue";
import AdminHome from "~/components/AdminHome.vue";

const { t, toggle } = useI18n();
const { push } = useToasts();
const { confirm } = useConfirm();
const route = useRoute();
const router = useRouter();

/**
 * The console view mirrors the URL path so navigation is deep-linkable:
 * /admin (overview) · /admin/groups · /admin/logs · /admin/audit · /admin/metrics.
 * Unknown slugs 404.
 */
type View = "overview" | "groups" | "logs" | "audit" | "metrics";
const view = computed<View | null>(() => {
  const seg = route.path.split("/").filter(Boolean)[1];
  if (!seg) return "overview";
  if (
    seg === "overview" ||
    seg === "groups" ||
    seg === "logs" ||
    seg === "audit" ||
    seg === "metrics"
  )
    return seg;
  return null;
});

if (view.value === null) {
  throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: false });
}

const nav = computed(() => [
  { id: "overview" as View, label: t("tab.overview"), path: "/admin" },
  { id: "groups" as View, label: t("tab.groups"), path: "/admin/groups" },
  { id: "logs" as View, label: t("tab.logs"), path: "/admin/logs" },
  { id: "audit" as View, label: t("tab.audit"), path: "/admin/audit" },
  { id: "metrics" as View, label: t("tab.metrics"), path: "/admin/metrics" },
]);

const mobileNav = computed(() =>
  nav.value.map(({ id, label }) => ({ value: id, label, icon: navIcon(id) })),
);

function navIcon(id: View) {
  const icons = {
    overview: Gauge,
    groups: Layers3,
    logs: Activity,
    audit: ClipboardList,
    metrics: ShieldCheck,
  } satisfies Record<View, typeof Gauge>;
  return icons[id];
}

const activeNav = computed<View>(() => view.value ?? "overview");

const pageTitle = computed(() => {
  if (selectedGroup.value) return t("group.routesIn", { name: selectedGroup.value.name });
  switch (view.value) {
    case "overview":
      return t("tab.overview");
    case "groups":
      return t("tab.groups");
    case "logs":
      return t("tab.logs");
    case "audit":
      return t("tab.audit");
    case "metrics":
      return t("tab.metrics");
    default:
      return "";
  }
});

const loadingAny = computed(
  () =>
    groupsLoading.value ||
    logsLoading.value ||
    metricsLoading.value ||
    groupRoutesLoading.value ||
    auditLoading.value,
);

const { logs, loading: logsLoading, error: logsError, load: loadLogs } = useSendLogs();
const {
  entries: auditEntries,
  loading: auditLoading,
  error: auditError,
  load: loadAudit,
} = useAuditApi();
const { metrics, loading: metricsLoading, error: metricsError, load: loadMetrics } = useMetrics();
const {
  groups,
  isSuper,
  roles,
  roleOf,
  canEditGroup,
  canEditRoutes,
  loading: groupsLoading,
  needLogin,
  error: groupsError,
  load: loadGroups,
  save: saveGroups,
  rename: groupsRename,
} = useGroupsApi();
const {
  routes: groupRoutes,
  loading: groupRoutesLoading,
  error: groupRoutesError,
  load: loadGroupRoutes,
  save: saveGroupRoutes,
} = useGroupRoutesApi();

const editorOpen = ref(false);
const editing = ref<Route | null>(null);
const saving = ref(false);
const forbidden = ref(false);
const selectedGroup = ref<Group | null>(null);

const groupEditorOpen = ref(false);
const editingGroup = ref<Group | null>(null);
const savingGroup = ref(false);

const logFilterGroup = ref("");
const auditFilterGroup = ref("");
const metricsFilterGroup = ref("");
const refreshKey = ref(0);

onMounted(() => {
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    forbidden.value = params.get("error") === "forbidden";
    const invite = params.get("invite");
    if (invite === "ok") push(t("members.inviteOk"));
    else if (invite != null && invite !== "ok") push(t("members.inviteBad"), "bad");
    if (params.get("install") === "ok") push(t("install.ok"));
  }
  loadGroups();
  loadLogs(50, logFilterGroup.value || undefined);
  loadMetrics();
});

// Tab switches are client-side navigations (no remount), so load the audit
// log whenever the audit view becomes active — including direct deep links.
watch(
  view,
  (v) => {
    if (v === "audit") loadAudit(50, auditFilterGroup.value || undefined);
    if (v === "metrics") loadMetrics(metricsFilterGroup.value || undefined);
  },
  { immediate: true },
);

function switchView(next: View): void {
  const path = next === "overview" ? "/admin" : `/admin/${next}`;
  if (route.path !== path) router.replace(path);
}

async function refreshOverview(): Promise<void> {
  refreshKey.value++;
  await Promise.all([loadGroups(), loadLogs(50, logFilterGroup.value || undefined), loadMetrics()]);
  push(t("overview.refreshed"));
}

function enterGroup(group: Group): void {
  selectedGroup.value = group;
  groupRoutes.value = [];
  loadGroupRoutes(group.id);
}

function exitGroup(): void {
  selectedGroup.value = null;
  loadGroups();
}

function openNew(): void {
  editing.value = null;
  editorOpen.value = true;
}

function openEdit(route: Route): void {
  editing.value = route;
  editorOpen.value = true;
}

async function onSave(route: Route): Promise<void> {
  const group = selectedGroup.value;
  if (!group) return;
  saving.value = true;
  try {
    let next: Route[];
    if (editing.value) {
      next = groupRoutes.value.map((r) => (r.id === editing.value!.id ? route : r));
    } else {
      if (groupRoutes.value.some((r) => r.id === route.id)) {
        push(t("toast.routeIdExists"), "bad");
        return;
      }
      next = [...groupRoutes.value, route];
    }
    await saveGroupRoutes(group.id, next);
    editorOpen.value = false;
    push(t("toast.routesSaved"));
  } catch (err) {
    push(t("toast.saveFailed", { msg: err instanceof Error ? err.message : String(err) }), "bad");
  } finally {
    saving.value = false;
  }
}

async function onMove(route: Route, dir: -1 | 1): Promise<void> {
  const group = selectedGroup.value;
  if (!group) return;
  const i = groupRoutes.value.findIndex((r) => r.id === route.id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= groupRoutes.value.length) return;
  const next = [...groupRoutes.value];
  [next[i], next[j]] = [next[j]!, next[i]!];
  try {
    await saveGroupRoutes(group.id, next);
  } catch (err) {
    push(t("toast.saveFailed", { msg: err instanceof Error ? err.message : String(err) }), "bad");
    loadGroupRoutes(group.id);
  }
}

async function onToggle(route: Route): Promise<void> {
  const group = selectedGroup.value;
  if (!group) return;
  try {
    await saveGroupRoutes(
      group.id,
      groupRoutes.value.map((r) => (r.id === route.id ? route : r)),
    );
  } catch (err) {
    push(t("toast.saveFailed", { msg: err instanceof Error ? err.message : String(err) }), "bad");
    loadGroupRoutes(group.id);
  }
}

async function onDelete(route: Route): Promise<void> {
  const group = selectedGroup.value;
  if (!group) return;
  if (!(await confirm({ title: t("confirm.deleteRoute", { name: route.name || route.id }) })))
    return;
  try {
    await saveGroupRoutes(
      group.id,
      groupRoutes.value.filter((r) => r.id !== route.id),
    );
    push(t("toast.routeDeleted"));
  } catch (err) {
    push(t("toast.deleteFailed", { msg: err instanceof Error ? err.message : String(err) }), "bad");
  }
}

function openNewGroup(): void {
  editingGroup.value = null;
  groupEditorOpen.value = true;
}

function openEditGroup(group: Group): void {
  editingGroup.value = group;
  groupEditorOpen.value = true;
}

async function onSaveGroupFromPanel(group: Group): Promise<void> {
  savingGroup.value = true;
  try {
    const next = groups.value.map((g) => (g.id === group.id ? group : g));
    await saveGroups(next);
    selectedGroup.value = group;
    push(t("toast.groupSaved"));
  } catch (err) {
    push(t("toast.saveFailed", { msg: err instanceof Error ? err.message : String(err) }), "bad");
    if (selectedGroup.value) {
      loadGroups();
    }
  } finally {
    savingGroup.value = false;
  }
}

async function onSaveGroup(group: Group): Promise<void> {
  savingGroup.value = true;
  try {
    const editing = editingGroup.value;
    let next: Group[];
    if (editing) {
      if (group.id !== editing.id) {
        // Id changed: rename first so routes/webhook secret/invites follow,
        // then persist the remaining edits under the new id.
        await groupsRename(editing.id, group.id);
        next = [...groups.value.filter((g) => g.id !== editing.id), group];
      } else {
        next = groups.value.map((g) => (g.id === editing.id ? group : g));
      }
    } else {
      if (groups.value.some((g) => g.id === group.id)) {
        push(t("toast.groupIdExists"), "bad");
        return;
      }
      next = [...groups.value, group];
    }
    await saveGroups(next);
    groupEditorOpen.value = false;
    push(t("toast.groupSaved"));
    await loadGroups();
  } catch (err) {
    push(t("toast.saveFailed", { msg: err instanceof Error ? err.message : String(err) }), "bad");
  } finally {
    savingGroup.value = false;
  }
}

async function onDeleteGroup(group: Group): Promise<void> {
  // Fetch the real route count for this group instead of relying on the
  // routes of whichever group happens to be open in the detail view.
  let used = 0;
  try {
    const data = await apiFetch<{ routes?: Route[] }>(
      `/admin/api/groups/${encodeURIComponent(group.id)}/routes`,
    );
    used = (data.routes ?? []).length;
  } catch {
    // Count is best-effort; proceed without the warning.
  }
  const confirmed = await confirm({
    title: t("confirm.deleteGroup", { name: group.name || group.id }),
    description: used ? t("confirm.deleteGroupWarn", { n: used }).trim() : undefined,
  });
  if (!confirmed) return;
  try {
    await saveGroups(groups.value.filter((g) => g.id !== group.id));
    push(t("toast.groupDeleted"));
  } catch (err) {
    push(t("toast.deleteFailed", { msg: err instanceof Error ? err.message : String(err) }), "bad");
  }
}
</script>

<style scoped>
.console-shell {
  display: grid;
  grid-template-columns: 264px minmax(0, 1fr);
  min-height: 100vh;
  background: rgb(var(--wh-bg));
  color: rgb(var(--wh-text));
}
.console-sidebar {
  position: sticky;
  top: 0;
  display: flex;
  height: 100vh;
  flex-direction: column;
  border-right: 1px solid rgb(var(--wh-border));
  background: linear-gradient(165deg, rgb(var(--wh-surface)), rgb(var(--wh-surface-2)));
  padding: 1.25rem 0.85rem;
}
.console-brand {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.45rem 0.55rem 1.75rem;
  color: rgb(var(--wh-text));
  text-decoration: none;
}
.console-brand :deep(svg) {
  color: rgb(var(--wh-accent));
}
.console-brand span {
  display: grid;
  gap: 0.1rem;
}
.console-brand strong {
  font-size: 1rem;
  letter-spacing: -0.04em;
}
.console-brand small,
.console-nav-label,
.console-kicker {
  color: rgb(var(--wh-faint));
  font-size: 0.62rem;
  font-weight: 800;
  letter-spacing: 0.13em;
  text-transform: uppercase;
}
.console-nav-label {
  margin: 0 0.65rem 0.45rem;
}
.console-nav {
  display: grid;
  gap: 0.2rem;
}
.console-nav-item {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  width: 100%;
  border: 0;
  border-radius: 0.65rem;
  background: transparent;
  padding: 0.7rem;
  color: rgb(var(--wh-muted));
  font: inherit;
  font-size: 0.82rem;
  font-weight: 700;
  text-align: left;
  transition:
    background-color 150ms ease,
    color 150ms ease;
  cursor: pointer;
}
.console-nav-item:hover {
  background: rgb(var(--wh-surface-2));
  color: rgb(var(--wh-text));
}
.console-nav-item.active {
  background: rgb(var(--wh-accent));
  color: white;
  box-shadow: 0 8px 18px rgb(var(--wh-accent) / 0.2);
}
.console-sidebar-footer {
  display: grid;
  gap: 0.9rem;
  margin-top: auto;
  padding: 0.9rem 0.55rem 0.25rem;
  border-top: 1px solid rgb(var(--wh-border));
}
.console-sidebar-footer a {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  color: rgb(var(--wh-muted));
  font-size: 0.8rem;
  font-weight: 700;
  text-decoration: none;
}
.console-sidebar-footer a:hover {
  color: rgb(var(--wh-bad));
}
.console-main {
  min-width: 0;
}
.console-topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  min-height: 76px;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 1px solid rgb(var(--wh-border));
  background: color-mix(in srgb, rgb(var(--wh-bg)) 87%, transparent);
  padding: 0.8rem clamp(1rem, 3vw, 2.5rem);
  backdrop-filter: blur(18px);
}
.console-topbar h1 {
  margin: 0.1rem 0 0;
  font-size: 1.15rem;
  letter-spacing: -0.035em;
}
.console-kicker {
  margin: 0;
}
.console-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.45rem;
}
.console-status {
  white-space: nowrap;
}
.console-mobile-nav {
  display: none;
}
.console-content {
  width: min(100% - 2rem, 1240px);
  margin: 0 auto;
  padding: clamp(1.25rem, 3vw, 2.5rem) 0 5rem;
}
.console-login {
  display: grid;
  min-height: 62vh;
  place-items: center;
}
.console-login-card {
  width: min(100%, 430px);
  text-align: center;
}
.console-login-card :deep(.rc-card-header) {
  justify-content: center;
  color: rgb(var(--wh-accent));
}
.console-login-card h2 {
  margin: 0.35rem 0 0.65rem;
  font-size: 1.35rem;
  letter-spacing: -0.035em;
}
.console-login-card p {
  margin: 0 0 1.4rem;
  color: rgb(var(--wh-muted));
}
.console-context-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
  padding: 0.8rem 1rem;
  border: 1px solid rgb(var(--wh-border));
  border-radius: 0.85rem;
  background: rgb(var(--wh-surface) / 0.6);
}
.console-context-bar > div {
  display: flex;
  align-items: center;
  gap: 0.8rem;
}
.console-context-bar p {
  margin: 0;
  color: rgb(var(--wh-muted));
  font-size: 0.8rem;
  font-weight: 700;
}
.console-context-bar strong {
  font-size: 1.25rem;
  letter-spacing: -0.04em;
}
.console-empty {
  padding: 4rem 1rem;
}
.console-group-card {
  cursor: pointer;
}
.console-open {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  color: rgb(var(--wh-accent));
  font-size: 0.75rem;
  font-weight: 800;
}
@media (max-width: 900px) {
  .console-shell {
    display: block;
  }
  .console-sidebar {
    display: none;
  }
  .console-mobile-nav {
    display: block;
    border-bottom: 1px solid rgb(var(--wh-border));
    padding: 0.5rem 1rem;
    overflow-x: auto;
  }
  .console-mobile-nav :deep(.rc-tabs) {
    min-width: max-content;
  }
}
@media (max-width: 620px) {
  .console-topbar {
    align-items: flex-start;
    flex-direction: column;
  }
  .console-actions {
    width: 100%;
    justify-content: flex-start;
    overflow-x: auto;
    padding-bottom: 0.05rem;
  }
  .console-status {
    display: none;
  }
  .console-content {
    width: min(100% - 1.25rem, 1240px);
  }
}
</style>
