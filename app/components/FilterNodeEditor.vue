<script setup lang="ts">
import { Plus, Trash2 } from "lucide-vue-next";
import type { NodeForm } from "~/composables/useFilterNode";
import { FILTER_SCOPE_EVENTS, blankNode, isBlankNode, nodeKey } from "~/composables/useFilterNode";
import { FILTER_TYPES, FILTER_OPS } from "~/types";
import type { FilterOp, FilterType } from "~/types";
import {
  fieldPathOptions,
  isArrayFieldPath,
  validateFilterValue,
  valueOptions,
} from "~/utils/filter-catalog";

defineOptions({ name: "FilterNodeEditor" });

const props = withDefaults(defineProps<{ node: NodeForm; depth?: number; deletable?: boolean }>(), {
  depth: 0,
  deletable: false,
});

const emit = defineEmits<{ (e: "remove"): void }>();

const { t, locale } = useI18n();
const { confirm } = useConfirm();
const scopeEvents = inject(
  FILTER_SCOPE_EVENTS,
  computed((): string[] => []),
);

const typeOptions = computed(() =>
  FILTER_TYPES.map((value) => ({ label: t("filter." + value), value })),
);
const opOptions = computed(() =>
  FILTER_OPS.map((value) => ({ label: t("filterOp." + value), value })),
);
const kindOptions = computed(() => [
  { label: t("filterNode.all"), value: "all" },
  { label: t("filterNode.any"), value: "any" },
]);
const pathOptions = computed(() => fieldPathOptions(locale.value, scopeEvents.value));
const valueSuggestions = computed(() =>
  valueOptions(
    locale.value,
    props.node.leaf.type,
    props.node.leaf.op,
    props.node.leaf.path,
    scopeEvents.value,
  ),
);

const isField = computed(() => props.node.leaf.type === "field");
const showOp = computed(() => props.node.leaf.type !== "keyword");
const showValues = computed(
  () => props.node.leaf.type === "keyword" || props.node.leaf.op !== "exists",
);

function validateValue(value: string): string | null {
  return validateFilterValue(props.node.leaf.type, props.node.leaf.op, value);
}

function setType(value: string): void {
  if ((FILTER_TYPES as readonly string[]).includes(value)) {
    props.node.leaf.type = value as FilterType;
    // Keyword filters have no operator; a hidden `exists` would drop their values.
    if (value === "keyword") props.node.leaf.op = "eq";
  }
}

function setOp(value: string): void {
  if (FILTER_OPS.includes(value as FilterOp)) {
    props.node.leaf.op = value as FilterOp;
    // `exists` hides the values input: its unadded text must not block saving.
    if (!showValues.value) props.node.leaf.draft = "";
  }
}

function setPath(value: string | string[]): void {
  props.node.leaf.path = typeof value === "string" ? value : "";
  // Paths ending on an array compare the whole array; `contains` matches an element.
  if (isArrayFieldPath(props.node.leaf.path) && props.node.leaf.op === "eq") {
    props.node.leaf.op = "contains";
  }
}

function setValues(value: string | string[]): void {
  props.node.leaf.values = Array.isArray(value) ? value : value ? [value] : [];
}

function setDraft(value: string): void {
  props.node.leaf.draft = value;
}

function setKind(value: string): void {
  if (value === "all" || value === "any") props.node.kind = value;
}

function addChild(kind: "leaf" | "all" | "any" | "not"): void {
  props.node.children.push(blankNode(kind));
}

function unwrapNot(): void {
  const child = props.node.child;
  if (!child) return;
  props.node.kind = child.kind;
  props.node.leaf = child.leaf;
  props.node.children = child.children;
  props.node.child = child.child;
}

async function remove(): Promise<void> {
  // Text typed but not added yet (the leaf's draft) counts as content too.
  if (!isBlankNode(props.node)) {
    const confirmed = await confirm({
      title:
        props.node.kind === "leaf" ? t("confirm.removeCondition") : t("confirm.removeFilterGroup"),
    });
    if (!confirmed) return;
  }
  emit("remove");
}
</script>

<template>
  <div class="node-editor" :class="{ 'node-nested': depth > 0 }">
    <div
      v-if="node.kind === 'leaf'"
      class="leaf-row"
      :class="{
        'is-field': isField,
        'is-keyword': !showOp,
        'no-values': !showValues,
        'is-negated': node.leaf.exclude,
      }"
    >
      <div class="leaf-type">
        <RcSelect
          :model-value="node.leaf.type"
          :options="typeOptions"
          @update:model-value="setType"
        />
      </div>
      <div v-if="isField" class="leaf-path">
        <FilterCombobox
          :model-value="node.leaf.path"
          :options="pathOptions"
          creatable
          :placeholder="t('routeEditor.pathPlaceholder')"
          :label="t('routeEditor.path')"
          @update:model-value="setPath"
        />
      </div>
      <div v-if="showOp" class="leaf-op">
        <RcSelect
          :model-value="node.leaf.op"
          :options="opOptions"
          :title="t('routeEditor.op')"
          @update:model-value="setOp"
        />
      </div>
      <div v-if="showValues" class="leaf-values">
        <FilterCombobox
          :model-value="node.leaf.values"
          :options="valueSuggestions"
          multiple
          creatable
          :validate="validateValue"
          :draft="node.leaf.draft"
          :placeholder="t('routeEditor.valuesPlaceholder')"
          :label="t('routeEditor.values')"
          @update:model-value="setValues"
          @update:draft="setDraft"
        />
      </div>
      <div class="leaf-actions">
        <RcToggle
          :model-value="node.leaf.exclude"
          size="sm"
          class="w-auto px-2.5 text-xs font-semibold ring-1 ring-inset ring-border-strong"
          :title="t('routeEditor.notHint')"
          :aria-label="t('routeEditor.notHint')"
          @update:model-value="node.leaf.exclude = $event"
        >
          {{ t("routeEditor.not") }}
        </RcToggle>
        <RcButton
          v-if="deletable"
          type="button"
          variant="ghost"
          color="error"
          size="icon"
          class="h-8 w-8 text-muted hover:text-bad"
          :title="t('routeEditor.removeCondition')"
          :aria-label="t('routeEditor.removeCondition')"
          @click="remove"
        >
          <Trash2 :size="15" />
        </RcButton>
      </div>
    </div>

    <div v-else-if="node.kind === 'all' || node.kind === 'any'" class="node-group">
      <div class="node-group-head">
        <RcToggleGroup
          :model-value="node.kind"
          :options="kindOptions"
          class="node-kind w-auto"
          @update:model-value="setKind"
        />
        <RcButton
          v-if="deletable"
          type="button"
          variant="ghost"
          color="error"
          size="icon"
          class="ml-auto h-8 w-8 text-muted hover:text-bad"
          :title="t('routeEditor.removeGroup')"
          :aria-label="t('routeEditor.removeGroup')"
          @click="remove"
        >
          <Trash2 :size="15" />
        </RcButton>
      </div>
      <div class="node-children">
        <FilterNodeEditor
          v-for="(child, i) in node.children"
          :key="nodeKey(child)"
          :node="child"
          :depth="depth + 1"
          deletable
          @remove="node.children.splice(i, 1)"
        />
        <div v-if="node.children.length === 0" class="node-empty">{{ t("filterNode.empty") }}</div>
      </div>
      <div class="node-add">
        <RcButton type="button" variant="ghost" size="xs" @click="addChild('leaf')">
          <Plus :size="13" />{{ t("routeEditor.addLeaf") }}
        </RcButton>
        <RcButton type="button" variant="ghost" size="xs" @click="addChild('all')">
          <Plus :size="13" />{{ t("routeEditor.addGroup") }}
        </RcButton>
        <RcButton type="button" variant="ghost" size="xs" @click="addChild('not')">
          <Plus :size="13" />{{ t("routeEditor.addNot") }}
        </RcButton>
      </div>
    </div>

    <div v-else class="node-group node-not">
      <div class="node-group-head">
        <span class="node-not-label">{{ t("filterNode.not") }}</span>
        <RcButton type="button" variant="ghost" size="xs" class="ml-auto" @click="unwrapNot">
          {{ t("filterNode.unwrap") }}
        </RcButton>
        <RcButton
          v-if="deletable"
          type="button"
          variant="ghost"
          color="error"
          size="icon"
          class="h-8 w-8 text-muted hover:text-bad"
          :title="t('routeEditor.removeGroup')"
          :aria-label="t('routeEditor.removeGroup')"
          @click="remove"
        >
          <Trash2 :size="15" />
        </RcButton>
      </div>
      <div class="node-children">
        <FilterNodeEditor v-if="node.child" :node="node.child" :depth="depth + 1" />
      </div>
    </div>
  </div>
</template>
