/**
 * Keeps an editor dialog open when the user clicks outside it, so a stray click
 * on the backdrop never throws away unsaved input. RcDialog exposes no hook for
 * reka's `interactOutside`, so this watches pointer-downs while the dialog is
 * open: a press outside the dialog (and outside any popover or dialog stacked
 * above it) marks the close request it triggers as one to ignore. Escape, the
 * close button and Cancel keep closing the dialog.
 */
export function useBackdropGuard(isOpen: () => boolean, dialogSelector: string) {
  let pressedOutside = false;

  function onPointerDown(event: PointerEvent): void {
    const target = event.target as Element | null;
    pressedOutside = !target?.closest?.(
      `${dialogSelector}, [data-dismissable-layer], [data-reka-popper-content-wrapper]`,
    );
  }

  function onKeyDown(): void {
    pressedOutside = false;
  }

  function listen(on: boolean): void {
    if (typeof document === "undefined") return;
    if (on) {
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("keydown", onKeyDown, true);
      return;
    }
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    pressedOutside = false;
  }

  watch(isOpen, listen, { immediate: true });
  onBeforeUnmount(() => listen(false));

  /** Whether the pending close request came from a press outside the dialog. */
  function isBackdropClose(): boolean {
    const outside = pressedOutside;
    pressedOutside = false;
    return outside;
  }

  return { isBackdropClose };
}
