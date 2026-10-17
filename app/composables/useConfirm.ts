export interface ConfirmOptions {
  /** The question, shown as the dialog title. */
  title: string;
  /** Optional consequence text under the title. */
  description?: string;
  /** Label of the destructive button (defaults to "Delete"). */
  confirmText?: string;
  /** What the action does, shown as the dialog icon (defaults to "delete"). */
  kind?: "delete" | "leave" | "signOut";
}

interface ConfirmRequest extends ConfirmOptions {
  resolve: (confirmed: boolean) => void;
}

/**
 * Promise-based destructive-action confirmation shared by the whole console.
 * <ConfirmDialog /> (mounted once by ConsolePage) renders the pending request;
 * `confirm()` resolves true on confirm and false on cancel / Escape.
 */
export function useConfirm() {
  const pending = useState<ConfirmRequest | null>("wh-confirm", () => null);
  const hosts = useState<number>("wh-confirm-hosts", () => 0);
  // The component that asks; a request it makes after unmounting is refused,
  // and one still on screen when it unmounts is cancelled.
  const owner = getCurrentInstance();
  let asked: ConfirmRequest | null = null;
  if (owner) {
    onBeforeUnmount(() => {
      // Only our own request: another component's newer one stays open.
      if (asked && toRaw(pending.value) === asked) settle(false);
      asked = null;
    });
  }

  function confirm(options: ConfirmOptions): Promise<boolean> {
    // Nobody can answer, or the asker is gone (the console was left while the
    // request was being prepared): never resume a stale destructive action.
    if (!hosts.value || owner?.isUnmounted) return Promise.resolve(false);
    // A newer request supersedes (and cancels) one still on screen.
    pending.value?.resolve(false);
    return new Promise((resolve) => {
      asked = { ...options, resolve };
      pending.value = asked;
    });
  }

  function settle(confirmed: boolean): void {
    const request = pending.value;
    if (!request) return;
    pending.value = null;
    request.resolve(confirmed);
  }

  /** Register the dialog that renders requests; the returned detach cancels any pending one. */
  function attachHost(): () => void {
    hosts.value++;
    return () => {
      hosts.value--;
      settle(false);
    };
  }

  return { pending, confirm, settle, attachHost };
}
