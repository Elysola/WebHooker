<script setup lang="ts">
import { computed, nextTick, provide, reactive, ref, watch } from "vue";
import { Trash2 } from "lucide-vue-next";
import type { Filter, FilterNode, NamedFragment, Route, RouteTarget, RouteTemplate } from "~/types";
import { FRAGMENT_PRESETS, ROUTE_TEMPLATES } from "~/types";
import type { NodeForm } from "~/composables/useFilterNode";
import {
  FILTER_SCOPE_EVENTS,
  blankLeafForm,
  blankNode,
  nodeToForm,
  nodeFormToRouteFilters,
  formToNode,
  hasPendingDraft,
  scopeEvents,
} from "~/composables/useFilterNode";
import { eventOptions, validateFilterValue } from "~/utils/filter-catalog";

interface TargetForm {
  platform: "discord" | "telegram" | "feishu";
  channelId: string;
  threadId: string;
  chatId: string;
  topicId: string;
}

const props = withDefaults(
  defineProps<{ open: boolean; route: Route | null; saving: boolean; groupId?: string | null }>(),
  { groupId: null },
);

const emit = defineEmits<{ (e: "close"): void; (e: "save", route: Route): void }>();

const { t, locale } = useI18n();
const { confirm } = useConfirm();

const isEdit = computed(() => props.route != null);
const discordRoles = computed({
  get: () =>
    form.discordRolesText
      .split(",")
      .map((role) => role.trim())
      .filter(Boolean),
  set: (roles: string[]) => {
    form.discordRolesText = roles.join(", ");
  },
});
const bodyEl = ref<HTMLFormElement | null>(null);
const filterError = ref("");
const targetError = ref("");
const formError = ref("");

const blankTarget = (): TargetForm => ({
  platform: "discord",
  channelId: "",
  threadId: "",
  chatId: "",
  topicId: "",
});

const form = reactive({
  id: "",
  name: "",
  enabled: true,
  fallback: false,
  stop: false,
  discordRolesText: "",
  targets: [] as TargetForm[],
});

const root = ref<NodeForm>(blankNode("all"));
provide(
  FILTER_SCOPE_EVENTS,
  computed(() => scopeEvents(root.value)),
);
const eventSuggestions = computed(() => eventOptions(locale.value));

const {
  fragments,
  loading: fragmentsLoading,
  error: fragmentsLoadError,
  readyFor: fragmentsReadyFor,
  load: loadFragments,
  save: saveFragments,
} = useFragmentsApi();
/** This group's fragments are loaded and no fragment write is running. */
const fragmentsWritable = computed(() => !!props.groupId && fragmentsReadyFor(props.groupId));
const fragmentName = ref("");
const fragmentError = ref("");

const testPayload = ref("");
const testEvent = ref("");
const testResult = ref<{ matched: boolean; explanation: string } | null>(null);
const testError = ref("");
const testing = ref(false);
const testEventInput = ref<{ hasInvalidDraft: () => boolean } | null>(null);

function applyTemplate(tmpl: RouteTemplate): void {
  form.id = tmpl.id;
  form.name = t(tmpl.nameKey);
  form.targets = [blankTarget()];
  root.value = tmpl.filters.length ? nodeToForm({ all: tmpl.filters }) : blankNode("all");
}

function addTarget(): void {
  form.targets.push(blankTarget());
}

async function removeTarget(target: TargetForm): Promise<void> {
  const filled = [target.channelId, target.threadId, target.chatId, target.topicId].some((v) =>
    v.trim(),
  );
  if (filled) {
    const n = form.targets.indexOf(target) + 1;
    if (!(await confirm({ title: t("confirm.removeTarget", { n }) }))) return;
  }
  const index = form.targets.indexOf(target);
  if (index >= 0) form.targets.splice(index, 1);
}

function validateEventName(value: string): string | null {
  return /^[a-z0-9_]+$/i.test(value) ? null : "valid.eventName";
}

function validateNode(nf: NodeForm): string | null {
  if (nf.kind === "leaf") {
    const { type, op, path, values } = nf.leaf;
    if (type === "field" && !path.trim()) return t("routeEditor.errPath");
    if (type === "keyword" || op !== "exists") {
      if (values.every((v) => !v.trim())) return t("routeEditor.errValues");
      for (const value of values) {
        const err = validateFilterValue(type, op, value);
        if (err) return t("routeEditor.errInvalidValue", { value: value.trim(), reason: t(err) });
      }
    }
    return null;
  }
  if (nf.kind === "all" || nf.kind === "any") {
    if (nf.children.length === 0) return t("routeEditor.errGroupEmpty");
    for (const c of nf.children) {
      const err = validateNode(c);
      if (err) return err;
    }
    return null;
  }
  if (nf.child) return validateNode(nf.child);
  return t("routeEditor.errGroupEmpty");
}

/** Why the filter tree cannot be used as-is (unconfirmed input or an invalid value). */
function filterTreeError(): string | null {
  if (hasPendingDraft(root.value)) return t("routeEditor.errDraft");
  return validateNode(root.value);
}

function collect(): Route | null {
  filterError.value = "";
  targetError.value = "";
  formError.value = "";

  let filters: Filter[] = [];
  let ast: FilterNode | undefined;
  if (!form.fallback) {
    const err = validateNode(root.value);
    if (err) {
      filterError.value = err;
      return null;
    }
    const res = nodeFormToRouteFilters(root.value);
    filters = res.filters;
    ast = res.ast;
  } else {
    const res = nodeFormToRouteFilters(root.value);
    const has = res.filters.length > 0 || res.ast !== undefined;
    if (has) {
      const err = validateNode(root.value);
      if (err) {
        filterError.value = err;
        return null;
      }
      filters = res.filters;
      ast = res.ast;
    }
  }

  const targets: RouteTarget[] = [];
  for (const tg of form.targets) {
    if (tg.platform === "telegram") {
      const chatId = tg.chatId.trim();
      if (!chatId) continue;
      targets.push({ platform: "telegram", chatId, topicId: tg.topicId.trim() || undefined });
    } else if (tg.platform === "feishu") {
      const chatId = tg.chatId.trim();
      if (!chatId) continue;
      targets.push({ platform: "feishu", chatId });
    } else {
      const channelId = tg.channelId.trim();
      if (!channelId) continue;
      targets.push({ platform: "discord", channelId, threadId: tg.threadId.trim() || undefined });
    }
  }

  const discordRoles = form.discordRolesText
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    id: form.id.trim(),
    name: form.name.trim(),
    enabled: form.enabled,
    fallback: form.fallback || undefined,
    stop: form.stop || undefined,
    discordRoleIds: discordRoles.length ? discordRoles : undefined,
    filters,
    ...(ast ? { ast } : {}),
    targets,
  };
}

function validated(): Route | null {
  if (hasPendingDraft(root.value)) {
    targetError.value = "";
    formError.value = "";
    filterError.value = t("routeEditor.errDraft");
    return null;
  }
  const route = collect();
  if (!route) return null;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(route.id)) {
    formError.value = t("routeEditor.errIdFormat");
    return null;
  }
  if (!route.name) {
    formError.value = t("routeEditor.errName");
    return null;
  }
  if (!route.targets.length) {
    targetError.value = t("routeEditor.errTargets");
    return null;
  }
  form.targets.forEach((tg, i) => {
    if ((tg.platform === "telegram" || tg.platform === "feishu") && !tg.chatId.trim()) {
      targetError.value = t("routeEditor.errChat", { n: i + 1 });
    } else if (tg.platform === "discord" && !tg.channelId.trim()) {
      targetError.value = t("routeEditor.errChannel", { n: i + 1 });
    }
  });
  return targetError.value ? null : route;
}

function save(): void {
  const route = validated();
  if (route) {
    emit("save", route);
    return;
  }
  // The footer button may be far from the failing section: bring the error into view.
  nextTick(() =>
    bodyEl.value
      ?.querySelector("[data-save-error]")
      ?.scrollIntoView({ block: "center", behavior: "smooth" }),
  );
}

function close(): void {
  emit("close");
}

// A click on the backdrop must not discard what has been typed so far.
const { isBackdropClose } = useBackdropGuard(() => props.open, ".editor-dialog");
useDialogFocus(() => props.open, ".editor-dialog");

function onOpenChange(open: boolean): void {
  if (!open && !isBackdropClose()) close();
}

/**
 * Bumped whenever the editor opens or closes. The console keeps one editor
 * for every group, so an async result (a test run, a fragment write) only
 * lands in the session that started it.
 */
let session = 0;

async function runTest(): Promise<void> {
  testError.value = "";
  testResult.value = null;
  let payload: unknown;
  try {
    payload = JSON.parse(testPayload.value);
  } catch {
    testError.value = t("routeEditor.testInvalidJson");
    return;
  }
  if (testEventInput.value?.hasInvalidDraft()) {
    testError.value = t("routeEditor.testEventInvalid");
    return;
  }
  const problem = filterTreeError();
  if (problem) {
    testError.value = problem;
    return;
  }
  const node = formToNode(root.value);
  if (!node) {
    testError.value = t("routeEditor.errAddFilter");
    return;
  }
  const mine = session;
  testing.value = true;
  try {
    const result = await apiFetch<{ matched: boolean; explanation: string }>(
      "/admin/api/test-match",
      {
        method: "POST",
        body: JSON.stringify({ node, event: testEvent.value.trim() || undefined, payload }),
      },
    );
    if (mine === session) testResult.value = result;
  } catch (err) {
    if (mine === session) testError.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (mine === session) testing.value = false;
  }
}

function insertNode(node: FilterNode): void {
  const child = nodeToForm(node);
  if (root.value.kind === "all" || root.value.kind === "any") {
    root.value.children.push(child);
  } else {
    root.value = {
      kind: "all",
      leaf: blankLeafForm(),
      children: [root.value, child],
      child: null,
    };
  }
}

function insertFragment(frag: NamedFragment): void {
  insertNode(frag.node);
}

async function saveAsFragment(): Promise<void> {
  fragmentError.value = "";
  const name = fragmentName.value.trim();
  if (!name) {
    fragmentError.value = t("routeEditor.fragmentsNameRequired");
    return;
  }
  if (!props.groupId) return;
  // A save replaces the group's whole list: never from one not loaded yet.
  if (!fragmentsReadyFor(props.groupId)) {
    fragmentError.value = t("routeEditor.fragmentsNotReady");
    return;
  }
  const problem = filterTreeError();
  if (problem) {
    fragmentError.value = problem;
    return;
  }
  const node = formToNode(root.value);
  if (!node) {
    fragmentError.value = t("routeEditor.errAddFilter");
    return;
  }
  const groupId = props.groupId;
  const id = `frag-${Math.random().toString(36).slice(2, 10)}`;
  const next: NamedFragment[] = [
    ...fragments.value.filter((f) => f.id !== id),
    { id, groupId, name, node },
  ];
  const mine = session;
  try {
    await saveFragments(groupId, next);
    if (mine === session) fragmentName.value = "";
  } catch (err) {
    if (mine === session) fragmentError.value = err instanceof Error ? err.message : String(err);
  }
}

async function deleteFragment(frag: NamedFragment): Promise<void> {
  const groupId = props.groupId;
  if (!groupId) return;
  const mine = session;
  if (!(await confirm({ title: t("confirm.deleteFragment", { name: frag.name }) }))) return;
  if (mine !== session) return;
  fragmentError.value = "";
  if (props.groupId !== groupId || !fragmentsReadyFor(groupId)) {
    fragmentError.value = t("routeEditor.fragmentsNotReady");
    return;
  }
  const next = fragments.value.filter((f) => f.id !== frag.id);
  try {
    await saveFragments(groupId, next);
  } catch (err) {
    if (mine === session) fragmentError.value = err instanceof Error ? err.message : String(err);
  }
}

watch(
  () => props.open,
  (open) => {
    session++;
    if (!open) return;
    const r = props.route;
    form.id = r?.id ?? "";
    form.name = r?.name ?? "";
    form.enabled = r?.enabled ?? true;
    form.fallback = r?.fallback ?? false;
    form.stop = r?.stop ?? false;
    form.discordRolesText = r?.discordRoleIds?.length ? r.discordRoleIds.join(", ") : "";
    form.targets =
      r && r.targets.length
        ? r.targets.map((tg) => {
            const merged = { ...blankTarget(), ...tg };
            merged.platform =
              merged.platform === "telegram" || merged.platform === "feishu"
                ? merged.platform
                : "discord";
            return merged;
          })
        : [blankTarget()];
    if (r?.ast) {
      root.value = nodeToForm(r.ast);
    } else if (r && r.filters.length) {
      root.value = nodeToForm({ all: r.filters });
    } else {
      root.value = blankNode("all");
    }
    filterError.value = "";
    targetError.value = "";
    formError.value = "";
    testPayload.value = "";
    testEvent.value = "";
    testResult.value = null;
    testError.value = "";
    testing.value = false;
    fragmentName.value = "";
    fragmentError.value = "";
    if (props.groupId) loadFragments(props.groupId);
  },
);
</script>

<template>
  <RcDialog
    :open="open"
    :title="isEdit ? t('routeEditor.editTitle') : t('routeEditor.newTitle')"
    class="editor-dialog flex flex-col gap-0 max-h-[calc(100dvh-2rem)] overflow-hidden p-0 max-w-4xl"
    @update:open="onOpenChange"
  >
    <template #header>
      <div class="editor-head">
        <div class="editor-heading">
          <span class="editor-eyebrow">{{ t("routeEditor.eyebrow") }}</span>
          <h2>{{ isEdit ? t("routeEditor.editTitle") : t("routeEditor.newTitle") }}</h2>
        </div>
      </div>
    </template>

    <form ref="bodyEl" class="editor-body" @submit.prevent="save">
      <!-- Locked while saving: an edit made meanwhile would be lost when the
           save closes the editor. -->
      <fieldset :disabled="saving" class="contents">
        <section class="editor-section">
          <h3 class="editor-section-title">{{ t("routeEditor.sectionBasic") }}</h3>
          <div v-if="!isEdit" class="templates">
            <RcButton
              v-for="tmpl in ROUTE_TEMPLATES"
              :key="tmpl.id"
              type="button"
              variant="ghost"
              size="sm"
              :class="form.id === tmpl.id ? 'template-chip active' : 'template-chip'"
              @click="applyTemplate(tmpl)"
            >
              {{ t(tmpl.nameKey) }}
            </RcButton>
          </div>
          <div class="row2">
            <div class="field">
              <label>{{ t("routeEditor.name") }}</label>
              <RcInput
                v-model="form.name"
                :placeholder="t('routeEditor.namePlaceholder')"
                required
              />
            </div>
            <div class="field">
              <label>{{ t("routeEditor.id") }}</label>
              <RcInput v-model="form.id" placeholder="my-route" required />
              <div class="hint">{{ t("routeEditor.idHint") }}</div>
            </div>
          </div>
        </section>

        <section class="editor-section">
          <h3 class="editor-section-title">{{ t("routeEditor.sectionOptions") }}</h3>
          <div class="option-list">
            <div class="option-row">
              <RcSwitch v-model="form.enabled" :label="t('routeEditor.enabled')" />
            </div>
            <div class="option-row">
              <RcCheckbox v-model="form.fallback" :label="t('routeEditor.fallback')" />
              <p class="option-hint">{{ t("routeEditor.fallbackHint") }}</p>
            </div>
            <div class="option-row">
              <RcCheckbox v-model="form.stop" :label="t('routeEditor.stop')" />
              <p class="option-hint">{{ t("routeEditor.stopHint") }}</p>
            </div>
          </div>
          <div class="field">
            <label>{{ t("routeEditor.discordRoles") }}</label>
            <RcTagInput
              v-model="discordRoles"
              separator=","
              :placeholder="t('routeEditor.discordRolesPlaceholder')"
            />
            <div class="hint">{{ t("routeEditor.discordRolesHint") }}</div>
          </div>
        </section>

        <section class="editor-section">
          <h3 class="editor-section-title">{{ t("routeEditor.sectionFilters") }}</h3>
          <FilterNodeEditor :node="root" />
          <div v-if="filterError" class="err" data-save-error>{{ filterError }}</div>
        </section>

        <section class="editor-section">
          <h3 class="editor-section-title">{{ t("routeEditor.testMatch") }}</h3>
          <div class="field test-event">
            <FilterCombobox
              ref="testEventInput"
              :model-value="testEvent"
              :options="eventSuggestions"
              creatable
              :validate="validateEventName"
              :placeholder="t('routeEditor.testEvent')"
              :label="t('routeEditor.testEvent')"
              @update:model-value="testEvent = typeof $event === 'string' ? $event : ''"
            />
          </div>
          <div class="field">
            <RcTextarea
              v-model="testPayload"
              class="test-payload"
              :rows="6"
              :placeholder="t('routeEditor.testPayloadPlaceholder')"
            />
          </div>
          <div class="field">
            <RcButton type="button" variant="ghost" :loading="testing" @click="runTest">
              {{ testing ? "…" : t("routeEditor.testRun") }}
            </RcButton>
          </div>
          <div v-if="testResult" class="test-result" :class="{ ok: testResult.matched }">
            <span class="test-badge">
              {{
                testResult.matched ? t("routeEditor.testMatched") : t("routeEditor.testNotMatched")
              }}
            </span>
            <span class="test-explanation">{{ testResult.explanation }}</span>
          </div>
          <div v-if="testError" class="err">{{ testError }}</div>
        </section>

        <section v-if="groupId" class="editor-section">
          <h3 class="editor-section-title">{{ t("routeEditor.fragments") }}</h3>
          <div class="fragments-presets">
            <span class="hint">{{ t("routeEditor.fragmentsPresets") }}</span>
            <div v-for="preset in FRAGMENT_PRESETS" :key="preset.id" class="fragment-row">
              <span class="fragment-name">{{ t(preset.nameKey) }}</span>
              <RcButton
                type="button"
                variant="ghost"
                size="sm"
                class="fragment-action"
                @click="insertNode(preset.node)"
              >
                {{ t("routeEditor.fragmentsInsert") }}
              </RcButton>
            </div>
          </div>
          <div class="fragments-list">
            <!-- A failed load is said so (never shown as "no fragments"). -->
            <div v-if="fragmentsLoadError" class="err">
              {{ t("routeEditor.fragmentsLoadFailed", { error: fragmentsLoadError }) }}
              <RcButton
                type="button"
                variant="ghost"
                size="sm"
                @click="groupId && loadFragments(groupId)"
              >
                {{ t("routeEditor.fragmentsRetry") }}
              </RcButton>
            </div>
            <div v-else-if="!fragments.length && !fragmentsLoading" class="hint">
              {{ t("routeEditor.fragmentsEmpty") }}
            </div>
            <div v-for="frag in fragments" :key="frag.id" class="fragment-row">
              <span class="fragment-name">{{ frag.name }}</span>
              <RcButton
                type="button"
                variant="ghost"
                size="sm"
                class="fragment-action"
                @click="insertFragment(frag)"
              >
                {{ t("routeEditor.fragmentsInsert") }}
              </RcButton>
              <RcButton
                type="button"
                variant="ghost"
                color="error"
                size="icon"
                class="h-8 w-8 text-muted hover:text-bad"
                :disabled="!fragmentsWritable"
                :title="t('routeEditor.fragmentsDelete')"
                :aria-label="t('routeEditor.fragmentsDelete')"
                @click="deleteFragment(frag)"
              >
                <Trash2 :size="15" />
              </RcButton>
            </div>
          </div>
          <div class="fragment-save">
            <div class="fragment-save-input">
              <RcInput
                v-model="fragmentName"
                :placeholder="t('routeEditor.fragmentsNamePlaceholder')"
              />
            </div>
            <RcButton
              type="button"
              variant="ghost"
              class="shrink-0 whitespace-nowrap"
              :disabled="!fragmentsWritable"
              @click="saveAsFragment"
            >
              {{ t("routeEditor.fragmentsSave") }}
            </RcButton>
          </div>
          <div v-if="fragmentError" class="err">{{ fragmentError }}</div>
        </section>

        <section class="editor-section">
          <h3 class="editor-section-title">{{ t("routeEditor.sectionTargets") }}</h3>
          <div v-for="(tg, i) in form.targets" :key="i" class="target-card">
            <div class="target-card-head">
              <div class="target-platform">
                <RcSelect
                  v-model="tg.platform"
                  :options="[
                    { label: 'Discord', value: 'discord' },
                    { label: 'Telegram', value: 'telegram' },
                    { label: t('routeEditor.platformFeishu'), value: 'feishu' },
                  ]"
                />
              </div>
              <RcButton
                type="button"
                variant="ghost"
                color="error"
                size="icon"
                class="h-8 w-8 text-muted hover:text-bad"
                :title="t('routeEditor.removeTarget')"
                :aria-label="t('routeEditor.removeTarget')"
                @click="removeTarget(tg)"
              >
                <Trash2 :size="15" />
              </RcButton>
            </div>
            <template v-if="tg.platform === 'discord'">
              <div class="target-field">
                <label :for="`target-${i}-channel`">{{ t("routeEditor.channel") }}</label>
                <RcInput
                  :id="`target-${i}-channel`"
                  v-model="tg.channelId"
                  :placeholder="t('routeEditor.channelPlaceholder')"
                />
              </div>
              <div class="target-field">
                <label :for="`target-${i}-thread`"
                  >{{ t("routeEditor.thread") }}
                  <span class="lbl-note">{{ t("routeEditor.threadNote") }}</span></label
                >
                <RcInput
                  :id="`target-${i}-thread`"
                  v-model="tg.threadId"
                  :placeholder="t('routeEditor.threadPlaceholder')"
                />
              </div>
            </template>
            <template v-else>
              <div class="target-field">
                <label :for="`target-${i}-chat`">{{ t("routeEditor.chat") }}</label>
                <RcInput
                  :id="`target-${i}-chat`"
                  v-model="tg.chatId"
                  :placeholder="
                    tg.platform === 'telegram'
                      ? t('routeEditor.chatPlaceholder')
                      : t('routeEditor.feishuChatPlaceholder')
                  "
                />
              </div>
              <div v-if="tg.platform === 'telegram'" class="target-field">
                <label :for="`target-${i}-topic`"
                  >{{ t("routeEditor.topic") }}
                  <span class="lbl-note">{{ t("routeEditor.topicNote") }}</span></label
                >
                <RcInput
                  :id="`target-${i}-topic`"
                  v-model="tg.topicId"
                  :placeholder="t('routeEditor.topicPlaceholder')"
                />
              </div>
            </template>
          </div>
          <RcButton type="button" variant="ghost" class="add-filter" @click="addTarget">
            {{ t("routeEditor.addTarget") }}
          </RcButton>
          <div v-if="targetError" class="err" data-save-error>{{ targetError }}</div>
        </section>

        <div v-if="formError" class="err" data-save-error>{{ formError }}</div>
      </fieldset>
    </form>

    <template #footer>
      <div class="editor-foot">
        <RcButton variant="ghost" @click="close">{{ t("routeEditor.cancel") }}</RcButton>
        <RcButton variant="primary" :loading="saving" @click="save">
          {{ t("routeEditor.save") }}
        </RcButton>
      </div>
    </template>
  </RcDialog>
</template>

<style scoped>
:deep(.editor-foot) {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  border-top: 1px solid rgb(var(--wh-border));
  background: rgb(var(--wh-surface));
  padding: 1rem 1.5rem;
  box-shadow: 0 -8px 24px -16px rgba(15, 23, 42, 0.18);
}
</style>
