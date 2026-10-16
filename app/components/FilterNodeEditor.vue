<script setup lang="ts">
import type { NodeForm } from "~/composables/useFilterNode";
import { blankNode, isBlankNode } from "~/composables/useFilterNode";
import { FILTER_TYPES, FILTER_OPS } from "~/types";

defineOptions({ name: "FilterNodeEditor" });

const props = withDefaults(defineProps<{ node: NodeForm; depth?: number; deletable?: boolean }>(), {
  depth: 0,
  deletable: false,
});

const emit = defineEmits<{ (e: "remove"): void }>();

const { t } = useI18n();
const { confirm } = useConfirm();

const NODE_KINDS = ["all", "any"] as const;
const filterTypeOptions = computed(() =>
  FILTER_TYPES.map((value) => ({ label: t("filter." + value), value })),
);
const filterOpOptions = computed(() =>
  FILTER_OPS.map((value) => ({ label: t("filterOp." + value), value })),
);
const nodeKindOptions = computed(() =>
  NODE_KINDS.map((value) => ({ label: t("filterNode." + value), value })),
);

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
    <div v-if="node.kind === 'leaf'" class="leaf-row">
      <RcSelect v-model="node.leaf.type" class="node-select" :options="filterTypeOptions" />

      <RcInput
        v-if="node.leaf.type === 'field'"
        v-model="node.leaf.path"
        class="input node-path"
        :placeholder="t('routeEditor.pathPlaceholder')"
      />

      <RcSelect
        v-if="node.leaf.type !== 'keyword'"
        v-model="node.leaf.op"
        class="node-select"
        :options="filterOpOptions"
        :title="t('routeEditor.op')"
      />

      <TagInput
        v-if="node.leaf.type === 'keyword' || node.leaf.op !== 'exists'"
        v-model="node.leaf.values"
        class="node-values"
        :placeholder="t('routeEditor.valuesPlaceholder')"
      />

      <RcCheckbox
        v-model="node.leaf.exclude"
        class="node-exclude"
        :label="t('routeEditor.not')"
        :title="t('routeEditor.not')"
      />

      <RcButton
        v-if="deletable"
        type="button"
        variant="destructive"
        size="icon"
        class="icon-btn danger"
        :title="t('routeEditor.remove')"
        @click="remove"
      >
        ✕
      </RcButton>
    </div>

    <div v-else-if="node.kind === 'all' || node.kind === 'any'" class="node-group">
      <div class="node-group-head">
        <RcSelect v-model="node.kind" class="node-combo" :options="nodeKindOptions" />
        <div class="node-actions">
          <RcButton
            type="button"
            variant="ghost"
            size="xs"
            class="node-add"
            @click="addChild('leaf')"
          >
            + {{ t("routeEditor.addLeaf") }}
          </RcButton>
          <RcButton
            type="button"
            variant="ghost"
            size="xs"
            class="node-add"
            @click="addChild('all')"
          >
            + {{ t("routeEditor.addGroup") }}
          </RcButton>
          <RcButton
            type="button"
            variant="ghost"
            size="xs"
            class="node-add"
            @click="addChild('not')"
          >
            + {{ t("routeEditor.addNot") }}
          </RcButton>
          <RcButton
            v-if="deletable"
            type="button"
            variant="destructive"
            size="icon"
            class="icon-btn danger"
            :title="t('routeEditor.remove')"
            @click="remove"
          >
            ✕
          </RcButton>
        </div>
      </div>
      <div class="node-children">
        <FilterNodeEditor
          v-for="(child, i) in node.children"
          :key="i"
          :node="child"
          :depth="depth + 1"
          deletable
          @remove="node.children.splice(i, 1)"
        />
        <div v-if="node.children.length === 0" class="node-empty">{{ t("filterNode.empty") }}</div>
      </div>
    </div>

    <div v-else class="node-group node-not">
      <div class="node-group-head">
        <span class="node-combo node-combo-label">{{ t("filterNode.not") }}</span>
        <div class="node-actions">
          <RcButton type="button" variant="ghost" size="xs" class="node-add" @click="unwrapNot">
            {{ t("filterNode.unwrap") }}
          </RcButton>
          <RcButton
            v-if="deletable"
            type="button"
            variant="destructive"
            size="icon"
            class="icon-btn danger"
            :title="t('routeEditor.remove')"
            @click="remove"
          >
            ✕
          </RcButton>
        </div>
      </div>
      <div class="node-children">
        <FilterNodeEditor v-if="node.child" :node="node.child" :depth="depth + 1" />
      </div>
    </div>
  </div>
</template>
