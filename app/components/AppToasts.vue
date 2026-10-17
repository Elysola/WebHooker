<template>
  <div class="elysola-toasts" aria-live="polite" aria-atomic="true">
    <TransitionGroup name="toast">
      <RcCard
        v-for="t in toasts"
        :key="t.id"
        :variant="t.kind === 'bad' ? 'soft' : 'outline'"
        padding="sm"
        class="elysola-toast"
        :class="t.kind"
        role="status"
        @click="dismiss(t.id)"
      >
        <component :is="t.kind === 'bad' ? CircleAlert : CircleCheck" :size="18" />
        <span>{{ t.msg }}</span>
        <X :size="15" class="toast-close" />
      </RcCard>
    </TransitionGroup>
  </div>
</template>

<script setup lang="ts">
import { CircleAlert, CircleCheck, X } from "lucide-vue-next";

const { toasts, dismiss } = useToasts();
</script>

<style scoped>
.elysola-toasts {
  position: fixed;
  z-index: 70;
  right: 1rem;
  bottom: 1rem;
  display: grid;
  width: min(calc(100vw - 2rem), 390px);
  gap: 0.65rem;
}
.elysola-toast {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  cursor: pointer;
  box-shadow: 0 16px 38px rgb(var(--wh-text) / 0.14);
}
.elysola-toast :deep(.rc-card-body) {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.7rem;
  padding: 0.1rem;
}
.elysola-toast :deep(svg) {
  flex: none;
  color: rgb(var(--wh-ok));
}
.elysola-toast.bad :deep(svg) {
  color: rgb(var(--wh-bad));
}
.elysola-toast span {
  flex: 1;
  font-size: 0.8rem;
  font-weight: 700;
}
.elysola-toast .toast-close {
  color: rgb(var(--wh-faint));
}
.toast-enter-active,
.toast-leave-active {
  transition:
    opacity 180ms ease,
    transform 180ms ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(16px);
}
</style>
