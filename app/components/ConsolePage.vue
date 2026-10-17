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
        <div class="console-heading">
          <p class="console-kicker">WebHooker / {{ activeNav }}</p>
          <h1 :title="pageTitle">{{ pageTitle }}</h1>
        </div>
        <div class="console-utilities">
          <RcBadge
            v-if="!needLogin && loadingAny"
            variant="soft"
            size="sm"
            dot
            class="console-status"
          >
            {{ t("status.loading") }}
          </RcBadge>
          <ThemeToggle />
          <RcButton variant="ghost" size="sm" @click="toggle"
            ><Languages :size="15" class="console-lang-icon" />{{ t("app.langToggle") }}</RcButton
          >
        </div>
        <div class="console-actions">
          <RcButton v-if="view === 'overview'" variant="ghost" size="sm" @click="refreshOverview"
            ><RefreshCw :size="15" />{{ t("metrics.refresh") }}</RcButton
          >
          <RcButton
            v-if="!needLogin && selectedGroup && canEditRoutes(selectedGroup.id) && !reordering"
            @click="openNew"
            ><Plus :size="16" />{{ t("app.newRoute") }}</RcButton
          >
        </div>
      </header>

      <div class="console-mobile-nav" @click="onMobileNavClick">
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
            <section class="console-context-bar console-group-bar">
              <div class="console-group-heading">
                <h2 :title="selectedGroup.name">{{ selectedGroup.name }}</h2>
                <RcBadge
                  :variant="groupRoutesLoading ? 'soft' : 'success'"
                  size="sm"
                  dot
                  class="shrink-0"
                  :title="t('group.routeCount', { count: groupRoutes.length })"
                  >{{ groupRoutes.length }}</RcBadge
                >
              </div>
              <div class="console-context-actions">
                <template v-if="reordering">
                  <RcButton
                    variant="outline"
                    color="neutral"
                    size="sm"
                    :disabled="savingOrder"
                    @click="cancelReorder"
                    >{{ t("routes.reorderCancel") }}</RcButton
                  >
                  <RcButton
                    size="sm"
                    :loading="savingOrder"
                    :disabled="!orderChanged || reorderBusy"
                    @click="saveOrder"
                    ><Check :size="15" />{{ t("routes.reorderSave") }}</RcButton
                  >
                </template>
                <RcButton
                  v-else-if="canReorder"
                  variant="outline"
                  color="neutral"
                  size="sm"
                  class="console-reorder-btn"
                  :disabled="groupRoutesLoading || saving"
                  :title="t('routes.reorder')"
                  :aria-label="t('routes.reorder')"
                  @click="startReorder"
                  ><ArrowUpDown :size="15" /><span class="console-reorder-label">{{
                    t("routes.reorder")
                  }}</span></RcButton
                >
              </div>
              <p v-if="reordering" class="console-reorder-hint">{{ t("routes.reorderHint") }}</p>
            </section>

            <p v-if="groupRoutesError" class="err">{{ groupRoutesError }}</p>

            <RouteList
              :routes="reordering ? orderDraft : groupRoutes"
              :reordering="reordering"
              :locked="savingOrder"
              :readonly="!canEditRoutes(selectedGroup.id)"
              @update:routes="orderDraft = $event"
              @update:busy="reorderBusy = $event"
              @toggle="onToggle"
              @edit="openEdit"
              @delete="onDelete"
            />

            <section v-if="groupRoutesReady && !groupRoutes.length" class="console-empty">
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

          <section v-else-if="groupMissing" class="console-empty">
            <RcEmptyState :title="t('group.notFound')">
              <NuxtLink to="/admin/groups"
                ><RcButton variant="outline" color="neutral">{{
                  t("group.allGroups")
                }}</RcButton></NuxtLink
              >
            </RcEmptyState>
          </section>

          <section v-else-if="routeGroupId" class="console-context-bar">
            <p v-if="groupsError" class="err">{{ groupsError }}</p>
            <RcBadge v-else variant="soft" size="sm" dot>{{ t("status.loading") }}</RcBadge>
          </section>

          <template v-else-if="view === 'groups'">
            <section class="console-context-bar">
              <div class="console-count">
                <p>{{ t("tab.groups") }}</p>
                <strong>{{ groups.length }}</strong>
              </div>
              <div class="console-context-actions">
                <RcBadge v-if="groupsLoading" variant="soft" size="sm" dot>{{
                  t("status.loading")
                }}</RcBadge>
                <RcButton
                  v-if="!needLogin && !selectedGroup && isSuper"
                  size="sm"
                  @click="openNewGroup"
                  ><Plus :size="15" />{{ t("app.newGroup") }}</RcButton
                >
              </div>
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
                <div class="flex flex-1 flex-col gap-3 p-4">
                  <div class="flex items-start justify-between gap-2.5">
                    <div class="min-w-0 flex-1">
                      <div
                        class="line-clamp-2 text-[15px] leading-snug font-semibold text-text [overflow-wrap:anywhere]"
                        :title="g.name || t('route.untitled')"
                      >
                        {{ g.name || t("route.untitled") }}
                      </div>
                      <div class="mt-0.5 font-mono text-[11px] text-faint truncate" :title="g.id">
                        {{ g.id }}
                      </div>
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
                        :title="t('groups.delete')"
                        :aria-label="t('groups.delete')"
                        @click="onDeleteGroup(g)"
                      >
                        <Trash2 :size="13.5" />
                      </RcButton>
                    </div>
                  </div>

                  <div class="space-y-1.5 text-xs">
                    <div
                      v-if="roleOf(g.id)"
                      class="flex items-center justify-between text-[11.5px]"
                    >
                      <span class="text-faint font-semibold">{{ t("groups.myRole") }}</span>
                      <RcBadge variant="brand" size="xs" class="whitespace-nowrap">
                        {{ t("roles." + roleOf(g.id)) }}
                      </RcBadge>
                    </div>
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
                    class="mt-auto flex items-center justify-between pt-2 border-t border-border/70 text-xs"
                  >
                    <span class="text-faint text-[11px]">{{ t("overview.routes") }}</span>
                    <NuxtLink
                      :to="groupPath(g.id)"
                      class="inline-flex items-center gap-1 font-semibold text-accent hover:underline"
                      @click.stop
                    >
                      {{ t("groups.open") }}
                      <ArrowRight :size="12" />
                    </NuxtLink>
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
  ArrowRight,
  ArrowUpDown,
  Check,
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
import type { AdminView } from "~/utils/admin-path";
import { adminGroupPath, parseAdminPath } from "~/utils/admin-path";
import { useAuditApi } from "~/composables/useAudit";
import WebhookPanel from "~/components/WebhookPanel.vue";
import AdminHome from "~/components/AdminHome.vue";

const { t, toggle } = useI18n();
const { push } = useToasts();
const { confirm, settle: dismissConfirm } = useConfirm();
const route = useRoute();
const router = useRouter();

/**
 * The console view mirrors the URL path so navigation is deep-linkable:
 * /admin (overview) · /admin/groups · /admin/groups/{groupId} (a group's
 * routes) · /admin/logs · /admin/audit · /admin/metrics. The page validates
 * the path, so unknown slugs 404 before the console renders.
 */
type View = AdminView;
const adminPath = computed(() => parseAdminPath(route.params.slug));
const view = computed<View | null>(() => adminPath.value?.view ?? null);
/** Group whose routes page the URL opens (/admin/groups/{groupId}). */
const routeGroupId = computed(() => adminPath.value?.groupId ?? null);
const groupPath = adminGroupPath;

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
  if (routeGroupId.value) return t("tab.groups");
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
  loaded: groupsLoaded,
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
  clear: clearGroupRoutes,
  ready: groupRoutesReady,
  save: saveGroupRoutes,
} = useGroupRoutesApi();

const editorOpen = ref(false);
const editing = ref<Route | null>(null);
const saving = ref(false);
const forbidden = ref(false);
/** The group the URL opens, once the group list knows it. */
const selectedGroup = computed<Group | null>(() =>
  routeGroupId.value ? (groups.value.find((g) => g.id === routeGroupId.value) ?? null) : null,
);
/** The URL names a group the signed-in user cannot see (or that does not exist). */
const groupMissing = computed(
  () => !!routeGroupId.value && groupsLoaded.value && !groupsError.value && !selectedGroup.value,
);


const groupEditorOpen = ref(false);
const editingGroup = ref<Group | null>(null);
const savingGroup = ref(false);

/** Reorder mode: the draft order the user drags until it is saved or cancelled. */
const reordering = ref(false);
const orderDraft = ref<Route[]>([]);
const savingOrder = ref(false);
/** A dropped card is still settling; its new position is not in the draft yet. */
const reorderBusy = ref(false);
const orderChanged = computed(
  () =>
    orderDraft.value.length !== groupRoutes.value.length ||
    orderDraft.value.some((r, i) => r.id !== groupRoutes.value[i]?.id),
);
const canReorder = computed(
  () =>
    !!selectedGroup.value && canEditRoutes(selectedGroup.value.id) && groupRoutes.value.length > 1,
);

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
  if (route.path !== path) router.push(path);
}

/**
 * The active mobile tab emits no change, so a tap on "Groups" while a group's
 * routes are open leads back to the list here (the sidebar link does so itself).
 */
function onMobileNavClick(event: MouseEvent): void {
  const tab = event.target instanceof Element ? event.target.closest('[role="tab"]') : null;
  if (tab?.getAttribute("aria-selected") === "true" && routeGroupId.value) switchView("groups");
}

/** Work on the current page that leaving it would throw away. */
function hasUnsavedWork(): boolean {
  return editorOpen.value || groupEditorOpen.value || (reordering.value && orderChanged.value);
}

/** Counts navigations reaching the guards; a newer one supersedes the question. */
let navigationAttempt = 0;

/** Ask before a navigation throws work away; the page resets once it happened. */
async function confirmLeave(): Promise<boolean> {
  if (!hasUnsavedWork()) return true;
  const attempt = navigationAttempt;
  const leave = await confirm({
    title: t("confirm.leaveUnsaved"),
    description: t("confirm.leaveUnsavedDesc"),
    confirmText: t("confirm.leave"),
    kind: "leave",
  });
  // Superseded while asking: let the router cancel this navigation itself.
  // Refusing it would read as "stay" and step the browser history back again,
  // on top of the newer navigation that already moved it.
  if (attempt !== navigationAttempt) return true;
  // Staying after Back/Forward: the browser has already moved. The router
  // steps back its own move; earlier, superseded moves are undone after it.
  if (!leave && historyPosition() !== shownPosition) {
    window.addEventListener("popstate", restoreShownEntry, { once: true });
  }
  return leave;
}

/** vue-router's position (in `history.state`) of the current history entry. */
function historyPosition(): number | null {
  const position = (window.history.state as { position?: unknown } | null)?.position;
  return typeof position === "number" ? position : null;
}

/** History position of the page on screen, as of the last completed navigation. */
let shownPosition = typeof window === "undefined" ? null : historyPosition();
const stopTrackingPosition = router.afterEach((_to, _from, failure) => {
  if (!failure) shownPosition = historyPosition();
});
onBeforeUnmount(stopTrackingPosition);

/** Move the browser back to the entry on screen without starting a navigation. */
function restoreShownEntry(): void {
  const position = historyPosition();
  if (position !== null && shownPosition !== null && position !== shownPosition) {
    router.options.history.go(shownPosition - position, false);
  }
}

// A newer navigation supersedes one still waiting for an answer: that
// question (like any other confirmation of this page) is cancelled first.
function supersedePending(): void {
  navigationAttempt++;
  dismissConfirm(false);
}

onBeforeRouteUpdate((to, from) => {
  supersedePending();
  return to.path === from.path || confirmLeave();
});
onBeforeRouteLeave(() => {
  supersedePending();
  return confirmLeave();
});

/** Bumped by every page change: work begun on one page must not act on the next. */
let pageVisit = 0;

// Only a navigation that actually happened resets the page it left: its
// editors, a reorder draft and any confirmation still open.
watch(
  () => route.path,
  () => {
    pageVisit++;
    dismissConfirm(false);
    editorOpen.value = false;
    groupEditorOpen.value = false;
    cancelReorder();
  },
);

async function refreshOverview(): Promise<void> {
  refreshKey.value++;
  await Promise.all([loadGroups(), loadLogs(50, logFilterGroup.value || undefined), loadMetrics()]);
  push(t("overview.refreshed"));
}

function enterGroup(group: Group): void {
  router.push(groupPath(group.id));
}

// The URL decides which group's routes are shown — on a deep link, a click
// on a group, or the browser's back/forward buttons alike.
watch(
  routeGroupId,
  (id, previous) => {
    cancelReorder();
    if (id) loadGroupRoutes(id);
    else clearGroupRoutes();
    // Back on the list: members or sources may have changed meanwhile.
    if (!id && previous && view.value === "groups") loadGroups();
  },
  { immediate: true },
);

function startReorder(): void {
  if (groupRoutesLoading.value || saving.value) return;
  orderDraft.value = [...groupRoutes.value];
  reorderBusy.value = false;
  reordering.value = true;
}

function cancelReorder(): void {
  reordering.value = false;
  reorderBusy.value = false;
  orderDraft.value = [];
}

async function saveOrder(): Promise<void> {
  const group = selectedGroup.value;
  if (!group || !orderChanged.value || reorderBusy.value || savingOrder.value) return;
  savingOrder.value = true;
  try {
    await saveGroupRoutes(group.id, orderDraft.value);
    cancelReorder();
    push(t("toast.orderSaved"));
  } catch (err) {
    push(t("toast.saveFailed", { msg: err instanceof Error ? err.message : String(err) }), "bad");
  } finally {
    savingOrder.value = false;
  }
}

function onReorderKey(event: KeyboardEvent): void {
  if (event.key !== "Escape" || savingOrder.value || event.defaultPrevented) return;
  // Escape closes an open dialog or list first (e.g. a member-removal
  // confirmation); it must not also throw away the unsaved order.
  const target = event.target instanceof Element ? event.target : null;
  if (
    target?.closest('[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]') ||
    document.querySelector('[role="dialog"], [role="alertdialog"]')
  )
    return;
  cancelReorder();
}

watch(reordering, (on) => {
  if (on) window.addEventListener("keydown", onReorderKey);
  else window.removeEventListener("keydown", onReorderKey);
});

onBeforeUnmount(() => window.removeEventListener("keydown", onReorderKey));

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
    push(t("toast.groupSaved"));
  } catch (err) {
    push(t("toast.saveFailed", { msg: err instanceof Error ? err.message : String(err) }), "bad");
    loadGroups();
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
  /* The sidebar narrows with the window (264px from ~1260px down to 208px),
     wide enough for every label in either language. */
  grid-template-columns: clamp(208px, 21vw, 264px) minmax(0, 1fr);
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
  gap: 0.45rem;
  border-bottom: 1px solid rgb(var(--wh-border));
  background: color-mix(in srgb, rgb(var(--wh-bg)) 87%, transparent);
  padding: 0.8rem clamp(1rem, 3vw, 2.5rem);
  backdrop-filter: blur(18px);
}
.console-heading {
  flex: 1 1 auto;
  min-width: 0;
  padding-right: 0.55rem;
}
.console-topbar h1 {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  margin: 0.1rem 0 0;
  font-size: 1.15rem;
  letter-spacing: -0.035em;
  overflow-wrap: anywhere;
}
.console-kicker {
  margin: 0;
}
.console-heading .console-kicker {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.console-utilities,
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
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem 1rem;
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
/* A heading with its count: one size, aligned on the text baseline. */
.console-context-bar > .console-count {
  align-items: baseline;
  gap: 0.5rem;
}
.console-count p {
  color: rgb(var(--wh-text));
  font-size: 1rem;
  font-weight: 600;
}
.console-count strong {
  color: rgb(var(--wh-muted));
  font-size: 1rem;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0;
}
.console-context-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-left: auto;
}
/* A group's routes: its name with the route count right after it. The name
   gives way (ellipsis) so the count and the actions keep their line. */
.console-group-bar {
  position: relative;
}
.console-context-bar > .console-group-heading {
  flex: 1 1 0;
  min-width: 0;
  gap: 0.5rem;
}
.console-group-heading h2 {
  min-width: 0;
  overflow: hidden;
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.console-group-bar .console-context-actions {
  flex: none;
}
.console-context-bar .console-reorder-hint {
  flex-basis: 100%;
  font-size: 0.78rem;
  font-weight: 500;
}
.console-empty {
  padding: 4rem 1rem;
}
.console-group-card {
  cursor: pointer;
}
/* Cards stretch to their grid row; the footer sits at the bottom so the
   dividers of one row line up whatever each card lists above them. */
.console-group-card,
.console-group-card > :deep(div) {
  display: flex;
  flex-direction: column;
}
.console-group-card > :deep(div) {
  flex: 1 1 auto;
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
    /* Still swipeable, without a scrollbar under the tabs. */
    scrollbar-width: none;
  }
  .console-mobile-nav::-webkit-scrollbar {
    display: none;
  }
  .console-mobile-nav :deep(.rc-tabs) {
    min-width: max-content;
  }
}
@media (max-width: 620px) {
  .console-reorder-label {
    display: none;
  }
  .console-reorder-btn {
    width: 2rem;
    padding-inline: 0;
  }
  /* Title left with theme/language pinned top-right; page actions below, right-aligned. */
  .console-topbar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: 0.75rem 0.25rem;
  }
  .console-heading {
    padding-right: 0;
  }
  .console-utilities {
    gap: 0.25rem;
  }
  .console-actions {
    grid-column: 1 / -1;
    justify-self: end;
    max-width: 100%;
    overflow-x: auto;
    padding-bottom: 0.05rem;
  }
  /* Keep the top-right tools compact so the title column stays readable. */
  .console-status,
  .console-lang-icon {
    display: none;
  }
  .console-content {
    width: min(100% - 1.25rem, 1240px);
  }
}
</style>
