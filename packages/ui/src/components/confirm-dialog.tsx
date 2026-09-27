'use client';

import { useRef, useState, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { AlertDialog } from 'radix-ui';
import { cn } from '../lib/utils';
import { Button } from './button';
import { ShortcutHint } from './shortcut-hint';

/**
 * The destructive confirm dialog (DESIGN_SYSTEM.md › Feedback & motion) for delete, cancel and void
 * actions. The confirm button is red and names the action ("Delete draft", never "OK").
 *
 * Focus starts on Cancel, so Enter never destroys by accident; Escape cancels. While `onConfirm`
 * runs, the confirm button shows a spinner and keeps focus, and Escape and Cancel are blocked; if it
 * throws, the dialog stays open, focus stays on the confirm button, and the caller shows `error`. Opened by a `trigger` child, or controlled with `open`.
 */
export function DestructiveConfirmDialog({
  trigger,
  open: openProp,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  error,
}: {
  /** The button that opens the dialog, e.g. a destructive "Delete draft" button. */
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** A question naming the thing, e.g. "Delete this draft timesheet?" */
  title: ReactNode;
  /** What happens, and whether it can be undone. */
  description: ReactNode;
  /** Names the action: "Delete draft", "Cancel request", "Void invoice". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Runs the action. The dialog closes when it resolves. */
  onConfirm: () => void | Promise<void>;
  /** A message to show when the action failed. */
  error?: ReactNode;
}) {
  const [innerOpen, setInnerOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const open = openProp ?? innerOpen;

  function setOpen(next: boolean) {
    if (pending) return;
    if (openProp === undefined) setInnerOpen(next);
    onOpenChange?.(next);
  }

  async function confirm() {
    setPending(true);
    try {
      await onConfirm();
      setPending(false);
      if (openProp === undefined) setInnerOpen(false);
      onOpenChange?.(false);
    } catch {
      // The caller shows what went wrong through `error` (announced as an alert); keep the dialog
      // open with focus on the confirm button, ready to retry.
      setPending(false);
      confirmRef.current?.focus();
    }
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={setOpen}>
      {trigger ? <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger> : null}
      <AlertDialog.Portal>
        <AlertDialog.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-scrim duration-base',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          )}
        />
        <AlertDialog.Content
          data-slot="destructive-confirm-dialog"
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault();
          }}
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-5',
            'rounded-panel bg-surface p-6 text-text-primary shadow-float outline-none duration-base',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          )}
        >
          <div className="flex items-start gap-4">
            <TriangleAlert
              aria-hidden="true"
              strokeWidth={1.75}
              className="mt-0.5 size-6 shrink-0 text-destructive-text"
            />
            <div className="flex min-w-0 flex-col gap-1.5">
              <AlertDialog.Title className="text-headline">{title}</AlertDialog.Title>
              <AlertDialog.Description className="text-subheadline text-text-secondary">
                {description}
              </AlertDialog.Description>
            </div>
          </div>
          {error ? (
            <p
              role="alert"
              className="rounded-lg bg-bg-grouped px-3 py-2 text-footnote font-medium text-destructive-text"
            >
              {error}
            </p>
          ) : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary" disabled={pending} className="gap-2.5">
                {cancelLabel}
                <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
              </Button>
            </AlertDialog.Cancel>
            {/* Not AlertDialog.Action: that closes at once, before the action has run. */}
            <Button ref={confirmRef} variant="destructive" loading={pending} onClick={confirm}>
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
