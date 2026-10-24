<template>
  <div>
    <div class="log-toolbar">
      <span class="kpi-label">{{ t("logs.lastSends", { n: logs.length }) }}</span>
      <div class="log-filters">
        <label class="filter-label">{{ t("logs.filterGroup") }}</label>
        <RcSelect
          class="filter-select"
          :model-value="selectedGroupId || '*'"
          :options="groupOptions"
          :disabled="loading"
          @update:model-value="onGroupFilter"
        />
      </div>
      <RcButton variant="ghost" size="sm" :disabled="loading" @click="refresh">
        {{ t("logs.refresh") }}
      </RcButton>
    </div>

    <p v-if="error" class="err">{{ error }}</p>
    <RcEmptyState v-else-if="!loading && !logs.length" :title="t('logs.empty')" class="empty-log" />

    <div class="log-list">
      <article
        v-for="l in logs"
        :key="l.id ?? l.ts + l.routeId"
        class="log-entry"
        :class="{ fail: !l.ok, clickable: true }"
        @click="openDetail(l)"
      >
        <div class="log-head">
          <span class="dot" :class="l.ok ? 'ok' : 'bad'"></span>
          <span class="log-route">{{ l.routeId }}</span>
          <span class="log-event">{{ l.event }}</span>
          <span v-if="l.status" class="log-status" :class="l.ok ? 'ok' : 'bad'">{{
            l.status
          }}</span>
          <span class="log-time">{{ fmtTime(l.ts) }}</span>
        </div>
        <div class="log-meta">
          <span v-if="l.repo"
            ><b>{{ t("logs.repo") }}</b
            ><code>{{ l.repo }}</code></span
          >
          <span
            ><b>{{ t("logs.target") }}</b
            ><code>{{ l.target }}</code></span
          >
        </div>
        <div v-if="!l.ok && l.error" class="log-error">{{ l.error }}</div>
      </article>
    </div>

    <RcDialog
      :open="detailOpen"
      :title="t('logs.detailTitle')"
      class="log-detail"
      @update:open="onDetailOpenChange"
    >
      <div v-if="detailLoading" class="flex justify-center py-8"><RcSpinner size="sm" /></div>
      <p v-else-if="detailError" class="err">{{ detailError }}</p>

      <dl v-else-if="detail" class="detail-grid">
        <template v-for="row in detailRows" :key="row.label">
          <dt>{{ row.label }}</dt>
          <dd>
            <pre v-if="row.block" class="log-block">{{ row.value }}</pre>
            <code v-else-if="row.code">{{ row.value }}</code>
            <span v-else>{{ row.value }}</span>
          </dd>
        </template>
      </dl>

      <p v-else class="err">{{ t("logs.detailMissing") }}</p>
    </RcDialog>
  </div>
</template>

<script setup lang="ts">
import type { Group, SendRecord } from "~/types";

const { t } = useI18n();
const { loadById } = useSendLogs();

const props = defineProps<{
  logs: SendRecord[];
  loading: boolean;
  error: string;
  groups: Group[];
  selectedGroupId: string;
}>();
const emit = defineEmits<{
  (e: "refresh"): void;
  (e: "filter"): void;
  (e: "update:selectedGroupId", value: string): void;
}>();

const detailOpen = ref(false);
const detail = ref<SendRecord | null>(null);
const detailLoading = ref(false);
const detailError = ref("");

const groupOptions = computed(() => [
  { label: t("logs.allGroups"), value: "*" }, // "*" is no group id: one named "all" stays selectable
  ...props.groups.map((g) => ({ label: g.name || g.id, value: g.id })),
]);

const detailRows = computed(() => {
  const l = detail.value;
  if (!l) return [] as Array<{ label: string; value: string; code?: boolean; block?: boolean }>;
  const rows: Array<{ label: string; value: string; code?: boolean; block?: boolean }> = [
    { label: t("logs.id"), value: String(l.id ?? "-"), code: true },
    { label: t("logs.time"), value: fmtTime(l.ts) },
    { label: t("logs.route"), value: l.routeId, code: true },
    { label: t("logs.event"), value: l.event, code: true },
    { label: t("logs.action"), value: l.action || "-", code: true },
    { label: t("logs.actor"), value: l.actor || "-", code: true },
    { label: t("logs.deliveryId"), value: l.deliveryId || "-", code: true },
    { label: t("logs.repo"), value: l.repo || "-", code: true },
    { label: t("logs.target"), value: l.target, code: true },
    { label: t("logs.platform"), value: l.platform || "-", code: true },
    { label: t("logs.status"), value: l.status != null ? String(l.status) : "-", code: true },
    { label: t("logs.messageId"), value: l.messageId || "-", code: true },
    { label: t("logs.errorCode"), value: l.errorCode || "-", code: true },
    { label: t("logs.duration"), value: l.durationMs != null ? `${l.durationMs} ms` : "-" },
    { label: t("logs.attempts"), value: l.attempts != null ? String(l.attempts) : "-" },
    { label: t("logs.ok"), value: l.ok ? t("logs.yes") : t("logs.no") },
    { label: t("logs.error"), value: l.error || "-", block: true },
  ];
  if (l.detail && Object.keys(l.detail).length > 0) {
    rows.push({
      label: t("logs.detail"),
      value: JSON.stringify(l.detail, null, 2),
      block: true,
    });
  }
  return rows;
});

function refresh(): void {
  emit("refresh");
}

function onGroupFilter(value: string): void {
  emit("update:selectedGroupId", value === "*" ? "" : value);
  emit("filter");
}

/** Bumped by every open/close: only the latest detail request may land. */
let detailRequest = 0;

async function openDetail(l: SendRecord): Promise<void> {
  if (l.id == null) return;
  const mine = ++detailRequest;
  detailOpen.value = true;
  detail.value = null;
  detailError.value = "";
  detailLoading.value = true;
  try {
    const entry = await loadById(l.id);
    if (mine === detailRequest) detail.value = entry;
  } catch (err) {
    if (mine === detailRequest) {
      detailError.value = err instanceof Error ? err.message : String(err);
    }
  } finally {
    if (mine === detailRequest) detailLoading.value = false;
  }
}

function closeDetail(): void {
  detailRequest++;
  detailOpen.value = false;
  detail.value = null;
  detailLoading.value = false;
}

function onDetailOpenChange(open: boolean): void {
  if (!open) closeDetail();
}
</script>
