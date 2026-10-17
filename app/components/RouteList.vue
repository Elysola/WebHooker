<template>
  <div
    ref="listEl"
    class="route-list"
    :class="{
      'is-reordering': reordering,
      'is-dragging': dragIndex >= 0,
      'is-committing': committing,
    }"
  >
    <p v-if="reordering" :id="hintId" class="sr-only">{{ t("routes.reorderKeyboardHint") }}</p>
    <RouteCard
      v-for="(r, i) in routes"
      :key="r.id"
      :data-route-id="r.id"
      :route="r"
      :readonly="readonly"
      :reordering="reordering"
      :locked="locked"
      :position="i + 1"
      :hint-id="hintId"
      :class="{ 'is-dragged': i === dragIndex, 'is-settling': i === dragIndex && settling }"
      :style="itemStyle(i)"
      @toggle="emit('toggle', $event)"
      @edit="emit('edit', $event)"
      @delete="emit('delete', $event)"
      @drag-start="onDragStart(i, $event)"
      @nudge="nudge(i, $event)"
    />
    <p class="sr-only" aria-live="assertive">{{ announcement }}</p>
  </div>
</template>

<script setup lang="ts">
import type { Route } from "~/types";

/**
 * The routes of one group. In reorder mode each card gets a drag handle:
 * pointer drags (mouse and touch) move a card while its neighbours slide out
 * of the way, and the new order is emitted on drop; Arrow Up / Down on a
 * focused handle moves it by one. `locked` freezes the order (e.g. while it
 * is being saved); `busy` reports a drag that has not been committed yet.
 */
const props = defineProps<{
  routes: Route[];
  reordering?: boolean;
  readonly?: boolean;
  locked?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:routes", routes: Route[]): void;
  (e: "update:busy", busy: boolean): void;
  (e: "toggle", route: Route): void;
  (e: "edit", route: Route): void;
  (e: "delete", route: Route): void;
}>();

const { t } = useI18n();

const hintId = `route-reorder-hint-${useId()}`;
const listEl = ref<HTMLElement | null>(null);
const dragIndex = ref(-1);
const overIndex = ref(-1);
const dragDelta = ref(0);
const settling = ref(false);
const committing = ref(false);
const announcement = ref("");

interface DragSession {
  pointerId: number;
  startY: number;
  startScroll: number;
  lastY: number;
  /** Document-relative tops and heights of every card when the drag began. */
  tops: number[];
  heights: number[];
  gap: number;
}

let session: DragSession | null = null;
let scrollSpeed = 0;
let scrollFrame = 0;
let settleTimer: ReturnType<typeof setTimeout> | undefined;

/** Distance the cards between the drag origin and the drop slot move by. */
function shiftPx(): number {
  return session && dragIndex.value >= 0 ? session.heights[dragIndex.value]! + session.gap : 0;
}

function itemStyle(i: number): Record<string, string> | undefined {
  const from = dragIndex.value;
  if (from < 0) return undefined;
  if (i === from) return { transform: `translateY(${dragDelta.value}px)` };
  const to = overIndex.value;
  if (to > from && i > from && i <= to) return { transform: `translateY(${-shiftPx()}px)` };
  if (to < from && i >= to && i < from) return { transform: `translateY(${shiftPx()}px)` };
  return undefined;
}

function measure(): Pick<DragSession, "tops" | "heights" | "gap"> | null {
  const list = listEl.value;
  if (!list) return null;
  const cards = [...list.querySelectorAll<HTMLElement>("[data-route-id]")];
  if (cards.length !== props.routes.length) return null;
  const rects = cards.map((el) => el.getBoundingClientRect());
  return {
    tops: rects.map((r) => r.top + window.scrollY),
    heights: rects.map((r) => r.height),
    gap: parseFloat(getComputedStyle(list).rowGap) || 0,
  };
}

function onDragStart(index: number, event: PointerEvent): void {
  if (!props.reordering || props.locked || session || settling.value) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;
  const geometry = measure();
  if (!geometry) return;
  event.preventDefault();
  session = {
    pointerId: event.pointerId,
    startY: event.clientY,
    startScroll: window.scrollY,
    lastY: event.clientY,
    ...geometry,
  };
  dragIndex.value = index;
  overIndex.value = index;
  dragDelta.value = 0;
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
}

function update(): void {
  const s = session;
  const from = dragIndex.value;
  if (!s || from < 0) return;
  const delta = s.lastY - s.startY + (window.scrollY - s.startScroll);
  const center = s.tops[from]! + delta + s.heights[from]! / 2;
  // Slot = how many other cards' original centers lie above the dragged center.
  let slot = 0;
  for (let i = 0; i < s.tops.length; i++) {
    if (i !== from && s.tops[i]! + s.heights[i]! / 2 < center) slot++;
  }
  dragDelta.value = delta;
  overIndex.value = slot;
}

function onPointerMove(event: PointerEvent): void {
  if (!session || event.pointerId !== session.pointerId) return;
  session.lastY = event.clientY;
  update();
  autoScroll(event.clientY);
}

/** Scroll the page while the pointer rests near the viewport's top or bottom edge. */
function autoScroll(clientY: number): void {
  const top = 140;
  const bottom = window.innerHeight - 80;
  const raw = clientY < top ? (clientY - top) / 6 : clientY > bottom ? (clientY - bottom) / 6 : 0;
  scrollSpeed = Math.max(-18, Math.min(18, Math.round(raw)));
  if (!scrollSpeed || scrollFrame) return;
  const step = (): void => {
    if (!session || !scrollSpeed) {
      scrollFrame = 0;
      return;
    }
    window.scrollBy(0, scrollSpeed);
    update();
    scrollFrame = requestAnimationFrame(step);
  };
  scrollFrame = requestAnimationFrame(step);
}

function stopListening(): void {
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  window.removeEventListener("pointercancel", onPointerUp);
  cancelAnimationFrame(scrollFrame);
  scrollFrame = 0;
  scrollSpeed = 0;
}

function onPointerUp(event: PointerEvent): void {
  const s = session;
  if (!s || event.pointerId !== s.pointerId) return;
  stopListening();
  const from = dragIndex.value;
  const to = overIndex.value;
  // Glide the card into its slot, then commit the order in one frame.
  let slotTop = s.tops[0]!;
  for (let i = 0, placed = 0; placed < to; i++) {
    if (i === from) continue;
    slotTop += s.heights[i]! + s.gap;
    placed++;
  }
  settling.value = true;
  dragDelta.value = slotTop - s.tops[from]!;
  settleTimer = setTimeout(() => commit(from, to), 160);
}

function commit(from: number, to: number): void {
  committing.value = true;
  if (to !== from) {
    const next = [...props.routes];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    emit("update:routes", next);
    announce(moved!, to);
  }
  resetDrag();
  requestAnimationFrame(() => requestAnimationFrame(() => (committing.value = false)));
}

function resetDrag(): void {
  clearTimeout(settleTimer);
  session = null;
  dragIndex.value = -1;
  overIndex.value = -1;
  dragDelta.value = 0;
  settling.value = false;
}

function cancelDrag(): void {
  stopListening();
  resetDrag();
}

function nudge(index: number, dir: -1 | 1): void {
  const to = index + dir;
  if (props.locked || session || to < 0 || to >= props.routes.length) return;
  const next = [...props.routes];
  const [moved] = next.splice(index, 1);
  next.splice(to, 0, moved!);
  emit("update:routes", next);
  announce(moved!, to);
  nextTick(() => {
    listEl.value
      ?.querySelector<HTMLElement>(`[data-route-handle="${CSS.escape(moved!.id)}"]`)
      ?.focus();
  });
}

function announce(route: Route, index: number): void {
  announcement.value = t("routes.moved", {
    name: route.name || route.id,
    n: index + 1,
  });
}

watch(
  () => dragIndex.value >= 0,
  (busy) => emit("update:busy", busy),
);

watch(
  () => props.reordering,
  (on) => {
    if (!on) cancelDrag();
  },
);

onBeforeUnmount(cancelDrag);
</script>
