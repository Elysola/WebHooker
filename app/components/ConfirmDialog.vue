<template>
  <AlertDialogRoot :open="!!request" @update:open="onOpenChange">
    <AlertDialogPortal>
      <AlertDialogOverlay class="confirm-overlay" />
      <AlertDialogContent class="confirm-dialog">
        <div class="confirm-body">
          <span class="confirm-icon" aria-hidden="true"><Trash2 :size="18" /></span>
          <div class="min-w-0 space-y-1.5">
            <AlertDialogTitle class="confirm-title">{{ shown?.title }}</AlertDialogTitle>
            <AlertDialogDescription v-if="shown?.description" class="confirm-description">
              {{ shown.description }}
            </AlertDialogDescription>
          </div>
        </div>
        <div class="confirm-actions">
          <AlertDialogCancel as-child>
            <RcButton variant="outline" color="neutral">{{ t("confirm.cancel") }}</RcButton>
          </AlertDialogCancel>
          <RcButton color="error" @click="settle(true)">
            {{ shown?.confirmText || t("confirm.delete") }}
          </RcButton>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>

<script setup lang="ts">
import { Trash2 } from "lucide-vue-next";
import {
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
} from "reka-ui";
import type { ConfirmOptions } from "~/composables/useConfirm";

const { t } = useI18n();
const { pending: request, settle, attachHost } = useConfirm();

// Keep the last request on screen while the close animation plays.
const shown = ref<ConfirmOptions | null>(null);
watch(
  request,
  (next) => {
    if (next) shown.value = next;
  },
  { immediate: true },
);

// A request must never outlive the console that asked for it: resolving it
// later would resume a destructive action of an unmounted component.
let detach: (() => void) | undefined;
onMounted(() => (detach = attachHost()));
onBeforeUnmount(() => detach?.());

function onOpenChange(open: boolean): void {
  if (!open) settle(false);
}
</script>

<style scoped>
.confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: var(--wh-scrim);
  backdrop-filter: blur(4px);
}
.confirm-dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  z-index: 60;
  display: grid;
  gap: 1.25rem;
  width: calc(100% - 2rem);
  max-width: 28rem;
  transform: translate(-50%, -50%);
  border-radius: 0.75rem;
  background: rgb(var(--wh-surface));
  box-shadow:
    inset 0 0 0 1px rgb(var(--wh-border)),
    0 20px 25px -5px rgb(0 0 0 / 0.1),
    0 8px 10px -6px rgb(0 0 0 / 0.1);
  padding: 1.5rem;
  color: rgb(var(--wh-text));
}
.confirm-dialog:focus {
  outline: none;
}
.confirm-body {
  display: flex;
  align-items: flex-start;
  gap: 0.875rem;
}
.confirm-icon {
  display: grid;
  flex: none;
  width: 2.25rem;
  height: 2.25rem;
  place-items: center;
  border-radius: 9999px;
  background: rgb(var(--wh-bad-dim));
  color: rgb(var(--wh-bad));
}
.confirm-title {
  font-size: 1rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.5rem;
  overflow-wrap: anywhere;
}
.confirm-description {
  color: rgb(var(--wh-muted));
  font-size: 0.875rem;
  line-height: 1.5rem;
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.625rem;
}
.confirm-overlay[data-state="open"],
.confirm-dialog[data-state="open"] {
  animation: confirm-in 150ms ease-out;
}
@keyframes confirm-in {
  from {
    opacity: 0;
  }
}
@media (max-width: 420px) {
  .confirm-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }
}
@media (prefers-reduced-motion: reduce) {
  .confirm-overlay[data-state="open"],
  .confirm-dialog[data-state="open"] {
    animation: none;
  }
}
</style>
