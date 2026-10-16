<template>
  <RcCard variant="outline" padding="none" :class="cardClass">
    <div class="route-row">
      <div class="route-lead">
        <RcSwitch
          v-if="!readonly"
          :model-value="route.enabled"
          size="sm"
          @update:model-value="onToggle"
        />
        <span v-else class="dot" :class="route.enabled ? 'ok' : 'bad'"></span>
      </div>

      <div class="route-title">
        <span class="route-name">{{ displayName }}</span>
        <span class="route-id">{{ route.id }}</span>
      </div>

      <div v-if="hasTags" class="route-tags">
        <RcBadge
          v-for="p in platforms"
          :key="p.platform"
          size="xs"
          class="route-badge"
          :class="`route-badge-${p.platform}`"
        >
          <span class="route-badge-dot"></span>
          {{ platformLabel(p.platform) }}<template v-if="p.count > 1"> ×{{ p.count }}</template>
        </RcBadge>
        <RcBadge
          v-if="route.discordRoleIds?.length"
          size="xs"
          class="route-badge route-badge-role"
          :title="route.discordRoleIds.join(', ')"
          >@roles</RcBadge
        >
        <RcBadge v-if="route.fallback" size="xs" class="route-badge route-badge-fallback">{{
          t("route.fallback")
        }}</RcBadge>
        <RcBadge v-if="route.stop" size="xs" class="route-badge route-badge-stop">{{
          t("route.stop")
        }}</RcBadge>
      </div>

      <div v-if="!readonly" class="route-actions">
        <RcButton
          type="button"
          variant="ghost"
          size="icon"
          class="h-8 w-8 text-muted hover:text-text"
          :disabled="atFirst"
          :title="t('route.moveUp')"
          :aria-label="t('route.moveUp')"
          @click="emit('move', route, -1)"
        >
          <ChevronUp :size="15" />
        </RcButton>
        <RcButton
          type="button"
          variant="ghost"
          size="icon"
          class="h-8 w-8 text-muted hover:text-text"
          :disabled="atLast"
          :title="t('route.moveDown')"
          :aria-label="t('route.moveDown')"
          @click="emit('move', route, 1)"
        >
          <ChevronDown :size="15" />
        </RcButton>
        <RcButton
          type="button"
          variant="ghost"
          size="icon"
          class="h-8 w-8 text-muted hover:text-text"
          :title="t('routeEditor.editTitle')"
          :aria-label="t('routeEditor.editTitle')"
          @click="emit('edit', route)"
        >
          <Pencil :size="15" />
        </RcButton>
        <RcButton
          type="button"
          variant="ghost"
          color="error"
          size="icon"
          class="h-8 w-8 text-muted hover:text-bad"
          :title="t('routes.delete')"
          :aria-label="t('routes.delete')"
          @click="emit('delete', route)"
        >
          <Trash2 :size="15" />
        </RcButton>
      </div>

      <div class="route-body">
        <p class="route-summary" :class="{ 'is-empty': !summary }" :title="summary || undefined">
          {{ summary || t("route.noFilters") }}
        </p>
        <div v-if="route.targets.length" class="route-card-targets">
          <span v-for="(tg, i) in route.targets" :key="i" class="route-target-row">
            <span class="route-target-label">
              <template v-if="tg.platform === 'telegram' || tg.platform === 'feishu'">{{
                t("route.chat")
              }}</template>
              <template v-else-if="tg.threadId">{{ t("route.thread") }}</template>
              <template v-else>{{ t("route.channel") }}</template>
            </span>
            <code class="route-target-id">
              <template v-if="tg.platform === 'telegram' || tg.platform === 'feishu'">{{
                tg.chatId
              }}</template>
              <template v-else-if="tg.threadId">{{ tg.threadId }}</template>
              <template v-else>{{ tg.channelId }}</template>
            </code>
          </span>
        </div>
      </div>
    </div>
  </RcCard>
</template>

<script setup lang="ts">
import { ChevronDown, ChevronUp, Pencil, Trash2 } from "lucide-vue-next";
import type { FilterNode, Route, RouteTarget } from "~/types";
import { describeNode } from "~/composables/useFilterNode";

type Platform = NonNullable<RouteTarget["platform"]>;

const { t } = useI18n();

const props = defineProps<{
  route: Route;
  atFirst?: boolean;
  atLast?: boolean;
  readonly?: boolean;
}>();

const emit = defineEmits<{
  (e: "toggle", route: Route): void;
  (e: "edit", route: Route): void;
  (e: "delete", route: Route): void;
  (e: "move", route: Route, dir: -1 | 1): void;
}>();

const displayName = computed(() => props.route.name || t("route.untitled"));
const summary = computed(() => {
  const node: FilterNode = props.route.ast ?? { all: props.route.filters };
  return describeNode(node, t);
});
const cardClass = computed(() => `route-card${props.route.enabled ? "" : " disabled"}`);

/** One tag per platform (in target order) with how many targets use it. */
const platforms = computed(() => {
  const counts = new Map<Platform, number>();
  for (const tg of props.route.targets) {
    const platform: Platform = tg.platform ?? "discord";
    counts.set(platform, (counts.get(platform) ?? 0) + 1);
  }
  return [...counts].map(([platform, count]) => ({ platform, count }));
});
const hasTags = computed(
  () =>
    platforms.value.length > 0 ||
    !!props.route.discordRoleIds?.length ||
    !!props.route.fallback ||
    !!props.route.stop,
);

function platformLabel(platform: Platform): string {
  if (platform === "telegram") return "Telegram";
  if (platform === "feishu") return t("route.feishu");
  return "Discord";
}

function onToggle(enabled: boolean): void {
  emit("toggle", { ...props.route, enabled });
}
</script>
