/**
 * Opens an editor dialog without jumping into its first field. reka-ui's
 * FocusScope focuses and *selects* the first input on open, which highlights
 * the name as if about to overwrite it and pops up the keyboard on touch
 * screens. Its mount auto-focus is announced with a non-bubbling, cancelable
 * event — RcDialog exposes no `openAutoFocus` hook — so it is caught here in
 * the capture phase and focus goes to the dialog itself instead: Escape and
 * Tab keep working, the fields stay untouched until the user picks one.
 */
export function useDialogFocus(isOpen: () => boolean, dialogSelector: string) {
  function onMountAutoFocus(event: Event): void {
    const dialog = event.target;
    if (!(dialog instanceof HTMLElement) || !dialog.matches(dialogSelector)) return;
    event.preventDefault();
    dialog.focus({ preventScroll: true });
  }

  function listen(on: boolean): void {
    if (typeof document === "undefined") return;
    if (on) document.addEventListener("focusScope.autoFocusOnMount", onMountAutoFocus, true);
    else document.removeEventListener("focusScope.autoFocusOnMount", onMountAutoFocus, true);
  }

  watch(isOpen, listen, { immediate: true });
  onBeforeUnmount(() => listen(false));
}
