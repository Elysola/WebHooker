<script setup lang="ts">
import type { DeliveryMetrics, Group, SendRecord } from "~/types";

const props = defineProps<{
  groups: Group[];
  logs: SendRecord[];
  metrics: DeliveryMetrics | null;
  groupsLoading: boolean;
  logsLoading: boolean;
  metricsLoading: boolean;
  /** Why the latest load failed (what is shown may be empty or older). */
  error?: string;
}>();

const { t } = useI18n();
const router = useRouter();

const kpis = computed(() => {
  const m = props.metrics;
  const total = m?.total ?? 0;
  const ok = m?.ok ?? 0;
  const rate = total ? (ok / total) * 100 : 0;
  return [
    { label: t("metrics.total"), value: total.toLocaleString(), tone: "accent" },
    { label: t("metrics.successRate"), value: `${rate.toFixed(1)}%`, tone: "ok" },
    { label: t("metrics.failed"), value: (m?.failed ?? 0).toLocaleString(), tone: "bad" },
    {
      label: t("metrics.avgDuration"),
      value: `${(m?.avgDurationMs ?? 0).toFixed(0)}ms`,
      tone: "muted",
    },
  ];
});

const KPI_TEXT: Record<string, string> = {
  accent: "text-accent",
  ok: "text-ok",
  bad: "text-bad",
  muted: "text-text",
};

const EVENT_TONES: Record<string, string> = {
  push: "ok",
  pull_request: "accent",
  issues: "warn",
  workflow_run: "info",
  check_suite: "info",
  check_run: "info",
  release: "ok",
  deployment: "accent",
};

const EVENT_BADGE: Record<string, string> = {
  ok: "bg-ok-dim text-ok",
  accent: "bg-accent-dim text-accent",
  warn: "bg-warn-dim text-warn",
  info: "bg-info-dim text-info",
  bad: "bg-bad-dim text-bad",
  muted: "bg-surface-2 text-muted",
};

function eventBadge(ev: string): string {
  return EVENT_BADGE[EVENT_TONES[ev] ?? "muted"] ?? EVENT_BADGE.muted!;
}

function fmtTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return `${Math.max(1, Math.round(d / 1000))}s`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h`;
  return `${Math.round(d / 86_400_000)}d`;
}
</script>

<template>
  <div class="space-y-6">
    <p v-if="error" class="err">{{ t("overview.loadFailed", { error }) }}</p>
    <!-- KPI cards -->
    <section class="grid grid-cols-2 gap-4 xl:grid-cols-4">
      <RcCard v-for="k in kpis" :key="k.label" variant="outline" padding="md" class="p-5">
        <div class="text-[11px] font-bold uppercase tracking-[1.5px] text-faint">{{ k.label }}</div>
        <div
          class="mt-2 text-2xl font-extrabold tracking-tight [font-variant-numeric:tabular-nums]"
          :class="KPI_TEXT[k.tone] ?? KPI_TEXT.muted"
        >
          {{ metricsLoading ? "—" : k.value }}
        </div>
      </RcCard>
    </section>

    <!-- Recent send logs -->
    <RcCard variant="outline" padding="none">
      <div class="flex items-center justify-between border-b border-border px-5 py-4">
        <h2 class="text-sm font-bold tracking-tight">{{ t("overview.recent") }}</h2>
        <RcButton variant="link" size="xs" @click="router.push('/admin/logs')">
          {{ t("overview.viewAll") }}
        </RcButton>
      </div>

      <div v-if="logsLoading" class="flex justify-center px-5 py-12 text-faint">
        <RcSpinner size="sm" />
      </div>
      <RcEmptyState v-else-if="!logs.length" :title="t('metrics.empty')" class="px-5 py-12" />

      <ul v-else class="divide-y divide-border">
        <li
          v-for="log in logs.slice(0, 10)"
          :key="log.id ?? `${log.ts}-${log.target}`"
          class="flex items-center gap-3 px-5 py-3"
        >
          <span class="dot" :class="log.ok ? 'ok' : 'bad'" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <RcBadge
                variant="soft"
                size="xs"
                class="uppercase tracking-wide"
                :class="eventBadge(log.event)"
              >
                {{ log.event }}
              </RcBadge>
              <span class="truncate text-[12px] text-muted">{{ log.repo || log.target }}</span>
            </div>
            <div class="mt-0.5 truncate font-mono text-[11px] text-faint">{{ log.target }}</div>
          </div>
          <span class="text-[11px] font-medium text-faint [font-variant-numeric:tabular-nums]">
            {{ fmtTime(log.ts) }}
          </span>
        </li>
      </ul>
    </RcCard>
  </div>
</template>
