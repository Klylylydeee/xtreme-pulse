'use client';

import type { ReactNode } from 'react';
import { Button } from '@pulse/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pulse/ui/components/dialog';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { ShortcutHint } from '@pulse/ui/components/shortcut-hint';

/**
 * A confirmation that isn't destructive, so not red (like the "Make System Administrator" dialog
 * on User access): Confirm all, and saving changes to a confirmed holiday. The confirm button names
 * the action and takes focus; Escape and Cancel close it. While `pending`, it can't be closed.
 * `children` sits between the description and the buttons (Confirm all lists the drafts that still
 * need a legal basis there).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  icon,
  title,
  description,
  confirmLabel,
  onConfirm,
  pending = false,
  error,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icon: ReactNode;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  /** Why the action failed, announced as an alert. */
  error?: string | null;
  children?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        className={[
          'top-1/2 left-1/2 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-5 overflow-y-auto',
          'rounded-panel bg-surface p-6 text-text-primary shadow-float',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
        ].join(' ')}
      >
        <div className="flex items-start gap-4">
          <IconTile className="size-11 shrink-0 rounded-xl [&_svg]:size-5">{icon}</IconTile>
          <div className="flex min-w-0 flex-col gap-1.5">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </div>
        </div>
        <div role="alert" className="empty:hidden">
          {error ? (
            <p className="rounded-lg bg-bg-grouped px-3 py-2 text-footnote font-medium text-destructive-text">
              {error}
            </p>
          ) : null}
        </div>
        {children}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => onOpenChange(false)}
            className="gap-2.5"
          >
            Cancel
            <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
          </Button>
          <Button onClick={onConfirm} loading={pending} autoFocus>
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
