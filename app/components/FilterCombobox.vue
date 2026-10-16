<template>
  <ComboboxRoot
    ref="rootRef"
    v-model:open="open"
    :model-value="multiple ? values : single || undefined"
    :multiple="multiple"
    ignore-filter
    open-on-click
    :reset-search-term-on-blur="false"
    :reset-search-term-on-select="false"
    class="filter-combo"
  >
    <ComboboxAnchor
      class="filter-combo-anchor"
      :class="{ 'is-multi': multiple, 'is-invalid': !!commitError }"
      @click="focusInput"
    >
      <template v-if="multiple">
        <span
          v-for="(v, i) in values"
          :key="v"
          class="filter-combo-chip"
          :class="{ 'is-invalid': !!chipError(v) }"
          :title="chipError(v) ? t(chipError(v)!) : hintOf(v)"
        >
          <span class="filter-combo-chip-text">{{ v }}</span>
          <button
            type="button"
            class="filter-combo-chip-x"
            :aria-label="t('combo.remove', { value: v })"
            @pointerdown.stop
            @click.stop="removeAt(i)"
          >
            <X :size="12" />
          </button>
        </span>
      </template>
      <ComboboxInput
        :id="inputId"
        v-model="inputText"
        class="filter-combo-input"
        :class="{ 'is-mono': mono }"
        :placeholder="multiple && values.length ? '' : placeholder"
        :aria-label="label"
        :aria-invalid="commitError ? true : undefined"
        :title="multiple ? undefined : hintOf(single) || undefined"
        @keydown="onKeydown"
        @focus="focused = true"
        @blur="onBlur"
      />
      <ComboboxTrigger class="filter-combo-trigger" tabindex="-1" :aria-label="label">
        <ChevronDown :size="14" />
      </ComboboxTrigger>
    </ComboboxAnchor>
    <p v-if="commitError" class="filter-combo-error">{{ t(commitError) }}</p>
    <p v-else-if="pending && !focused" class="filter-combo-pending">
      {{ t("combo.pending", { value: draftText }) }}
    </p>

    <ComboboxPortal>
      <ComboboxContent
        position="popper"
        align="start"
        :side-offset="4"
        :collision-padding="8"
        :data-filter-combo="uid"
        class="filter-combo-content"
        @pointerdown="markPointerInside"
      >
        <ComboboxViewport class="filter-combo-viewport">
          <ComboboxGroup v-for="section in sections" :key="section.name">
            <ComboboxLabel v-if="section.name" class="filter-combo-group">
              {{ section.name }}
            </ComboboxLabel>
            <ComboboxItem
              v-for="opt in section.options"
              :key="opt.value"
              :value="opt.value"
              :title="opt.hint"
              class="filter-combo-item"
              @select="onPick($event, opt.value)"
            >
              <span class="filter-combo-item-value">{{ opt.value }}</span>
              <span v-if="opt.hint" class="filter-combo-item-hint">{{ opt.hint }}</span>
              <ComboboxItemIndicator class="filter-combo-item-check">
                <Check :size="14" />
              </ComboboxItemIndicator>
            </ComboboxItem>
          </ComboboxGroup>
          <ComboboxItem
            v-if="canCreate"
            :value="CREATE_VALUE"
            class="filter-combo-item is-create"
            @select="onCreate"
          >
            <Plus :size="14" class="shrink-0" />
            <span class="filter-combo-item-create">{{
              t("combo.useValue", { value: draftText })
            }}</span>
          </ComboboxItem>
          <p v-if="liveError && !sections.length" class="filter-combo-note is-error">
            {{ t(liveError) }}
          </p>
          <p v-else-if="!sections.length && !canCreate" class="filter-combo-note">
            {{ creatable ? t("combo.typeToAdd") : t("combo.empty") }}
          </p>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>

<script setup lang="ts">
import { Check, ChevronDown, Plus, X } from "lucide-vue-next";
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxLabel,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxViewport,
} from "reka-ui";
import type { ComboOption } from "~/utils/filter-catalog";

/**
 * Searchable dropdown for the filter editor. Options carry the stored English
 * key plus localized descriptions; search matches the key first, then either
 * language. With `creatable`, typed text can be added as a custom value once
 * `validate` accepts it — otherwise typing only searches.
 *
 * Built on the reka-ui primitives that @elysola/ui ships (and styled
 * like RcCombobox / RcTagInput). It deliberately uses that same reka-ui copy
 * rather than a separate dependency so its popover stacks with Rc dialogs.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string | string[];
    options: ComboOption[];
    multiple?: boolean;
    creatable?: boolean;
    /** Returns an i18n error key for an unusable custom value. */
    validate?: (value: string) => string | null;
    placeholder?: string;
    label?: string;
    mono?: boolean;
    /**
     * Multi-value fields: the typed text not added yet (`v-model:draft`), so
     * the owner can refuse to save it and restore it after a remount.
     */
    draft?: string;
  }>(),
  {
    multiple: false,
    creatable: false,
    validate: undefined,
    placeholder: "",
    label: "",
    mono: true,
    draft: "",
  },
);

const emit = defineEmits<{
  (e: "update:modelValue", value: string | string[]): void;
  (e: "update:draft", value: string): void;
}>();

const { t } = useI18n();

/** Item value of the "use typed text" entry (never a real option value). */
const CREATE_VALUE = "\u0000create";

const uid = useId();
const inputId = `filter-combo-${uid}`;
const rootRef = ref<{ highlightedElement?: HTMLElement } | null>(null);
const open = ref(false);
// A multi-value draft kept by the owner comes back after a remount.
const draft = ref(props.multiple ? props.draft : "");
const typing = ref(!!draft.value.trim());
const commitError = ref<string | null>(
  typing.value ? (props.validate?.(draft.value.trim()) ?? null) : null,
);
const pointerInside = ref(false);
const focused = ref(false);

const values = computed(() =>
  Array.isArray(props.modelValue) ? props.modelValue : props.modelValue ? [props.modelValue] : [],
);
const single = computed(() => (Array.isArray(props.modelValue) ? "" : props.modelValue));
const draftText = computed(() => draft.value.trim());
const query = computed(() => (typing.value ? draftText.value.toLowerCase() : ""));

const inputText = computed({
  get: () => (props.multiple || typing.value ? draft.value : single.value),
  set: (text: string) => {
    draft.value = text;
    typing.value = true;
    commitError.value = null;
  },
});

/** Search score: lower is better, -1 = no match. The English key ranks first. */
function score(opt: ComboOption, q: string): number {
  const value = opt.value.toLowerCase();
  const snake = q.replace(/\s+/g, "_");
  if (value === q) return 0;
  if (value.startsWith(q) || value.startsWith(snake)) return 1;
  if (value.includes(q) || value.includes(snake)) return 2;
  if (opt.hint?.toLowerCase().includes(q)) return 3;
  if (opt.keywords?.some((k) => k.toLowerCase().includes(q))) return 4;
  return -1;
}

const sections = computed(() => {
  const q = query.value;
  if (q) {
    const ranked = props.options
      .map((opt, index) => ({ opt, index, s: score(opt, q) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => a.s - b.s || a.index - b.index)
      .map((r) => r.opt);
    return ranked.length ? [{ name: "", options: ranked }] : [];
  }
  const groups: { name: string; options: ComboOption[] }[] = [];
  for (const opt of props.options) {
    const name = opt.group ?? "";
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.options.push(opt);
    else groups.push({ name, options: [opt] });
  }
  return groups;
});

const liveError = computed(() =>
  props.creatable && typing.value && draftText.value
    ? (props.validate?.(draftText.value) ?? null)
    : null,
);

const canCreate = computed(() => {
  if (!props.creatable || !typing.value || !draftText.value || liveError.value) return false;
  const text = draftText.value.toLowerCase();
  return (
    !props.options.some((o) => o.value.toLowerCase() === text) &&
    !values.value.some((v) => v.toLowerCase() === text)
  );
});

/**
 * Typed text in a multi-value field that has not been added yet. It is never
 * added implicitly (it may just be a search), so the route form refuses to
 * save until it is added with Enter or cleared.
 */
const pending = computed(
  () => props.multiple && typing.value && !!draftText.value && !commitError.value,
);

watch(draft, (text) => {
  if (props.multiple) emit("update:draft", text);
});

watch(open, (isOpen) => {
  if (isOpen) {
    // Single-value fields opened by a click or arrow key: typing replaces the
    // current value. Opened by typing, the typed text must stay as it is.
    if (!props.multiple) nextTick(() => !typing.value && inputEl()?.select());
    return;
  }
  if (!props.multiple && !props.creatable) resetDraft();
});

/** Error of an already-added value (e.g. after the filter type changed). */
function chipError(value: string): string | null {
  return props.validate?.(value) ?? null;
}

function hintOf(value: string): string {
  return props.options.find((o) => o.value === value)?.hint ?? "";
}

function inputEl(): HTMLInputElement | null {
  return document.getElementById(inputId) as HTMLInputElement | null;
}

function focusInput(): void {
  inputEl()?.focus();
}

function resetDraft(): void {
  draft.value = "";
  typing.value = false;
  commitError.value = null;
}

function setValues(next: string[]): void {
  emit("update:modelValue", next);
}

function choose(value: string): void {
  if (props.multiple) {
    const exists = values.value.includes(value);
    setValues(exists ? values.value.filter((v) => v !== value) : [...values.value, value]);
    resetDraft();
    nextTick(focusInput);
    return;
  }
  emit("update:modelValue", value);
  resetDraft();
  open.value = false;
  nextTick(focusInput);
}

/** Commit typed text as a custom value; false (with an error shown) when invalid. */
function commitDraft(): boolean {
  const text = draftText.value;
  if (!text) {
    // Clearing a single free-form value (e.g. the field path) removes it.
    if (!props.multiple && typing.value && single.value) emit("update:modelValue", "");
    resetDraft();
    return true;
  }
  const err = props.validate?.(text) ?? null;
  if (err) {
    commitError.value = err;
    return false;
  }
  if (props.multiple) {
    if (!values.value.includes(text)) setValues([...values.value, text]);
  } else if (text !== single.value) {
    emit("update:modelValue", text);
  }
  resetDraft();
  return true;
}

function removeAt(index: number): void {
  setValues(values.value.filter((_, i) => i !== index));
  focusInput();
}

function onPick(event: Event, value: string): void {
  // We own the model: stop reka from applying (or toggling) the value itself.
  event.preventDefault();
  choose(value);
}

function onCreate(event: Event): void {
  event.preventDefault();
  if (commitDraft() && !props.multiple) open.value = false;
  nextTick(focusInput);
}

function markPointerInside(): void {
  pointerInside.value = true;
  setTimeout(() => (pointerInside.value = false), 0);
}

function onBlur(event: FocusEvent): void {
  focused.value = false;
  const next = event.relatedTarget as HTMLElement | null;
  // Focus moving into our own list means an option is being clicked.
  if (pointerInside.value || next?.closest?.(`[data-filter-combo="${uid}"]`)) return;
  if (!typing.value) return;
  if (!props.creatable) {
    resetDraft();
    return;
  }
  if (!props.multiple) {
    // A single free-form value (the field path) behaves like a text input.
    commitDraft();
    return;
  }
  // Only an exact suggestion is unambiguous enough to add on its own; any
  // other text stays pending (it may be a search) until Enter or clearing.
  const text = draftText.value.toLowerCase();
  const match = props.options.find((o) => o.value.toLowerCase() === text);
  if (!match) return;
  if (!values.value.includes(match.value)) setValues([...values.value, match.value]);
  resetDraft();
}

defineExpose({
  /** Whether the field shows text that was rejected and is not its value. */
  hasInvalidDraft: (): boolean => !!commitError.value,
});

function isComposing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

function onKeydown(event: KeyboardEvent): void {
  if (isComposing(event)) return;
  if (event.key === "Enter") {
    // Never let Enter submit the surrounding form.
    const handled = event.defaultPrevented;
    event.preventDefault();
    if (handled && rootRef.value?.highlightedElement) return;
    if (props.creatable && draftText.value) {
      if (commitDraft() && !props.multiple) open.value = false;
    } else if (!open.value) {
      open.value = true;
    }
    return;
  }
  if (event.key === "Backspace" && props.multiple && !draft.value && values.value.length) {
    event.preventDefault();
    removeAt(values.value.length - 1);
  }
}

</script>
