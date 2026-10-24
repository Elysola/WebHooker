<script setup lang="ts">
import type { DeliveryMetrics, Group, MetricsBreakdown } from "~/types";

const { t } = useI18n();

const props = defineProps<{
  metrics: DeliveryMetrics | null;
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

const sortBy = ref<"total" | "failed" | "rate">("total");

const groupOptions = computed(() => [
  { label: t("metrics.allGroups"), value: "*" }, // "*" is no group id: one named "all" stays selectable
  ...props.groups.map((g) => ({ label: g.name || g.id, value: g.id })),
]);

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function pctOf(count: number, total: number): string {
  if (total <= 0) return "0%";
  return `${((count / total) * 100).toFixed(0)}%`;
}

function onGroupFilter(value: string): void {
  emit("update:selectedGroupId", value === "*" ? "" : value);
  emit("filter");
}

function eventLabel(raw: string): string {
  const key = `event.${raw}`;
  const label = t(key);
  return label === key ? raw : label;
}

const TONE: Record<string, string> = {
  accent: "metric-kpi accent",
  ok: "metric-kpi ok",
  bad: "metric-kpi bad",
  warn: "metric-kpi warn",
  info: "metric-kpi info",
};

const summary = (m: DeliveryMetrics) => [
  {
    label: t("metrics.total"),
    value: m.total.toLocaleString(),
    tone: "accent",
  },
  {
    label: t("metrics.successRate"),
    value: pct(1 - m.failureRate),
    tone: "ok",
  },
  {
    label: t("metrics.failed"),
    value: m.failed.toLocaleString(),
    tone: "bad",
  },
  {
    label: t("metrics.avgDuration"),
    value: `${m.avgDurationMs.toFixed(0)}ms`,
    tone: "warn",
  },
  {
    label: t("metrics.retryRate"),
    value: m.totalAttempts > m.total ? pct((m.totalAttempts - m.total) / m.total) : "0%",
    tone: "info",
  },
];

function rows(list: MetricsBreakdown[], key: (r: MetricsBreakdown) => string) {
  const raw = list.map((r) => ({
    key: key(r),
    rawKey: key(r),
    total: r.total,
    ok: r.ok,
    failed: r.failed,
    rate: r.total > 0 ? r.failed / r.total : 0,
  }));
  if (sortBy.value === "total") {
    raw.sort((a, b) => b.total - a.total);
  } else if (sortBy.value === "failed") {
    raw.sort((a, b) => b.failed - a.failed || b.total - a.total);
  } else {
    raw.sort((a, b) => b.rate - a.rate || b.failed - a.failed);
  }
  return raw;
}

function sortLabel(): string {
  if (sortBy.value === "total") return t("metrics.sortTotal");
  if (sortBy.value === "failed") return t("metrics.sortFailed");
  return t("metrics.sortRate");
}

function cycleSort(): void {
  if (sortBy.value === "total") sortBy.value = "failed";
  else if (sortBy.value === "failed") sortBy.value = "rate";
  else sortBy.value = "total";
}
</script>

<template>
  <div>
    <div class="log-toolbar">
      <span class="kpi-label">{{ t("metrics.title") }}</span>
      <div class="log-filters">
        <label class="filter-label">{{ t("metrics.filterGroup") }}</label>
        <RcSelect
          class="filter-select"
          :model-value="selectedGroupId || '*'"
          :options="groupOptions"
          :disabled="loading"
          @update:model-value="onGroupFilter"
        />
      </div>
      <RcButton variant="ghost" size="sm" :disabled="loading" @click="emit('refresh')">
        {{ t("metrics.refresh") }}
      </RcButton>
    </div>

    <p v-if="error" class="err">{{ error }}</p>
    <RcEmptyState v-else-if="!loading && !metrics" :title="t('metrics.empty')" class="empty-log" />

    <template v-else-if="metrics">
      <div class="metric-kpis">
        <RcCard
          v-for="k in summary(metrics)"
          :key="k.label"
          variant="outline"
          padding="md"
          class="metric-kpi"
          :class="TONE[k.tone] ?? ''"
        >
          <span class="metric-kpi-value">{{ k.value }}</span>
          <span class="metric-kpi-label">{{ k.label }}</span>
        </RcCard>
      </div>

      <RcCard v-if="metrics.byPlatform.length" variant="outline" padding="md" class="metric-block">
        <h3 class="metric-block-title">{{ t("metrics.byPlatform") }}</h3>
        <div
          v-for="r in rows(metrics.byPlatform, (r) => r.platform ?? 'unknown')"
          :key="r.key"
          class="metric-row"
        >
          <span class="metric-key">{{ r.key }}</span>
          <div class="metric-bar">
            <span
              v-if="r.ok > 0"
              class="metric-fill ok"
              :style="{ flex: String(r.ok) }"
              :title="`${t('metrics.ok')} ${r.ok} (${pctOf(r.ok, r.total)})`"
            ></span>
            <span
              v-if="r.failed > 0"
              class="metric-fill bad"
              :style="{ flex: String(r.failed), minWidth: '4px' }"
              :title="`${t('metrics.failed')} ${r.failed} (${pctOf(r.failed, r.total)})`"
            ></span>
          </div>
          <span class="metric-total">{{ r.total }}</span>
        </div>
      </RcCard>

      <RcCard v-if="metrics.byEvent.length" variant="outline" padding="md" class="metric-block">
        <div class="metric-block-head">
          <h3 class="metric-block-title">{{ t("metrics.byEvent") }}</h3>
          <RcButton variant="ghost" size="xs" class="metric-sort-toggle" @click="cycleSort">{{
            sortLabel()
          }}</RcButton>
        </div>
        <div
          v-for="r in rows(metrics.byEvent, (r) => r.event ?? 'unknown')"
          :key="r.key"
          class="metric-row"
        >
          <span class="metric-key" :title="r.rawKey">{{ eventLabel(r.rawKey) }}</span>
          <div class="metric-bar">
            <span
              v-if="r.ok > 0"
              class="metric-fill ok"
              :style="{ flex: String(r.ok), minWidth: r.ok > 0 ? '4px' : '0' }"
              :title="`${t('metrics.ok')} ${r.ok} (${pctOf(r.ok, r.total)})`"
            ></span>
            <span
              v-if="r.failed > 0"
              class="metric-fill bad"
              :style="{ flex: String(r.failed), minWidth: '4px' }"
              :title="`${t('metrics.failed')} ${r.failed} (${pctOf(r.failed, r.total)})`"
            ></span>
          </div>
          <span class="metric-total">{{ r.total }}</span>
        </div>
      </RcCard>

      <RcCard v-if="metrics.byStatus.length" variant="outline" padding="md" class="metric-block">
        <h3 class="metric-block-title">{{ t("metrics.byStatus") }}</h3>
        <div class="metric-status-row">
          <span
            v-for="s in metrics.byStatus"
            :key="s.status"
            class="metric-status"
            :class="{
              ok: !s.status.startsWith('5') && s.status !== '0',
              bad: s.status.startsWith('5') || s.status === '0',
            }"
          >
            {{ s.status }} · {{ s.count }}
          </span>
        </div>
      </RcCard>

      <RcCard
        v-if="metrics.recentFailures.length"
        variant="outline"
        padding="md"
        class="metric-block"
      >
        <h3 class="metric-block-title">{{ t("metrics.recentFailures") }}</h3>
        <div
          v-for="f in metrics.recentFailures"
          :key="f.id ?? `${f.ts}-${f.target}`"
          class="log-entry fail"
        >
          <div class="log-head">
            <span class="dot bad"></span>
            <span class="log-route">{{ f.event }}</span>
            <span v-if="f.errorCode" class="log-status bad">{{ f.errorCode }}</span>
            <span class="log-time">{{ f.target }}</span>
          </div>
        </div>
      </RcCard>
    </template>
  </div>
</template>
