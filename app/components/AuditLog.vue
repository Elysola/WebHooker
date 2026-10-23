<template>
  <div>
    <div class="log-toolbar">
      <span class="kpi-label">{{ t("audit.title") }}</span>
      <div class="log-filters">
        <label class="filter-label">{{ t("audit.filterGroup") }}</label>
        <RcSelect
          class="filter-select"
          :model-value="selectedGroupId || '*'"
          :options="groupOptions"
          :disabled="loading"
          @update:model-value="onGroupFilter"
        />
      </div>
      <RcButton variant="ghost" size="sm" :disabled="loading" @click="refresh">
        {{ t("audit.refresh") }}
      </RcButton>
    </div>

    <p v-if="error" class="err">{{ error }}</p>
    <RcEmptyState
      v-else-if="!loading && !entries.length"
      :title="t('audit.empty')"
      class="empty-log"
    />

    <div class="log-list">
      <article v-for="e in entries" :key="e.id ?? e.ts" class="log-entry">
        <div class="log-head">
          <span class="dot ok"></span>
          <span class="log-route">{{ e.action }}</span>
          <span class="log-event">{{ e.actorLogin || e.actorId || "-" }}</span>
          <span class="log-status ok">{{ e.targetType || "-" }}</span>
          <span class="log-time">{{ fmtTime(e.ts) }}</span>
        </div>
        <div class="log-meta">
          <span
            ><b>{{ t("audit.target") }}</b
            ><code>{{ e.targetId || "-" }}</code></span
          >
          <span
            ><b>{{ t("audit.group") }}</b
            ><code>{{ e.groupId || "-" }}</code></span
          >
          <span v-if="e.detail && Object.keys(e.detail).length > 0"
            ><b>{{ t("audit.detail") }}</b
            ><code>{{ JSON.stringify(e.detail) }}</code></span
          >
        </div>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { AuditEntry, Group } from "~/types";

const { t } = useI18n();

const props = defineProps<{
  entries: AuditEntry[];
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

function refresh(): void {
  emit("refresh");
}

const groupOptions = computed(() => [
  { label: t("audit.allGroups"), value: "*" }, // "*" is no group id: one named "all" stays selectable
  ...props.groups.map((g) => ({ label: g.name || g.id, value: g.id })),
]);

function onGroupFilter(value: string): void {
  emit("update:selectedGroupId", value === "*" ? "" : value);
  emit("filter");
}
</script>
