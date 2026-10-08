'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Pencil, RotateCcw, Trash2 } from 'lucide-react';
import type { ActionResult } from '@pulse/core';
import { Button } from '@pulse/ui/components/button';
import { DestructiveConfirmDialog } from '@pulse/ui/components/confirm-dialog';
import { Switch } from '@pulse/ui/components/form';
import { FormAlert } from '@/components/form-alert';
import { useActionSubmit } from '@/components/org-structure';

// The parts the Sites and Contacts sections share: the row card, a row's Edit, Remove and Restore
// buttons, the "Show removed" switch, and moving focus once a row appears or goes away.

type RowAction = (
  previous: null,
  input: FormData | Record<string, unknown>,
) => Promise<ActionResult<unknown>>;

/**
 * Focuses the element with a given id once it is on the page (after a reload, a new row appears a
 * render or two later). `focusLater(null)` cancels.
 */
export function useFocusLater(): (id: string | null) => void {
  const pending = useRef<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!pending.current) return;
    const element = document.getElementById(pending.current);
    if (element) {
      pending.current = null;
      element.focus();
    }
  });

  return (id) => {
    pending.current = id;
    setTick((count) => count + 1);
  };
}

/** The "Show removed" switch, local to the sheet (removed rows are already loaded). */
export function ShowRemovedSwitch({
  checked,
  onCheckedChange,
  count,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  count: number;
}) {
  const id = useId();
  return (
    <div className="flex min-h-11 items-center gap-3">
      <label htmlFor={id} className="text-subheadline font-medium text-text-primary">
        Show removed <span className="text-text-secondary numeric">({count})</span>
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

/** A card holding the rows. */
export function RowCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul
      aria-label={label}
      className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card"
    >
      {children}
    </ul>
  );
}

/** One row: its text, and its buttons (44px each) on the right. */
export function Row({
  removed = false,
  actions,
  children,
}: {
  removed?: boolean;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-2 py-2 pr-2 pl-4">
      <div
        className={
          removed
            ? 'flex min-w-0 flex-1 flex-col gap-0.5 py-1.5 text-text-secondary'
            : 'flex min-w-0 flex-1 flex-col gap-0.5 py-1.5'
        }
      >
        {children}
      </div>
      <div className="flex shrink-0 items-center">{actions}</div>
    </li>
  );
}

export function EditRowButton({
  id,
  label,
  onClick,
}: {
  id: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button id={id} variant="plain" size="icon" aria-label={label} onClick={onClick}>
      <Pencil aria-hidden="true" />
    </Button>
  );
}

/** Remove, after the destructive confirmation. A refused removal is shown in the dialog. */
export function RemoveRowButton({
  id,
  label,
  title,
  description,
  confirmLabel,
  action,
  onRemoved,
}: {
  /** The record to remove. */
  id: string;
  /** The button's accessible name: "Remove Makati Branch". */
  label: string;
  title: string;
  description: string;
  confirmLabel: string;
  action: RowAction;
  onRemoved: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const remove = useActionSubmit(action, () => undefined);

  return (
    <>
      <Button
        variant="plain"
        size="icon"
        aria-label={label}
        onClick={() => {
          remove.reset();
          setConfirming(true);
        }}
        className="text-destructive-text hover:bg-bg-grouped hover:text-destructive-text"
      >
        <Trash2 aria-hidden="true" />
      </Button>
      <DestructiveConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={title}
        description={description}
        confirmLabel={confirmLabel}
        error={remove.formError ?? Object.values(remove.fieldErrors)[0] ?? null}
        onConfirm={async () => {
          const ok = await remove.run({ id });
          // Keeps the dialog open, showing why, when the removal was refused.
          if (!ok) throw new Error('Remove refused');
          // Not awaited: the dialog closes first, so the reload can then move focus out of it.
          void onRemoved();
        }}
      />
    </>
  );
}

/** Restore a removed row; a refusal is shown above the list. */
export function RestoreRowButton({
  id,
  label,
  action,
  onRestored,
  onError,
}: {
  id: string;
  label: string;
  action: RowAction;
  onRestored: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [pending, setPending] = useState(false);

  async function restore() {
    setPending(true);
    onError(null);
    try {
      const result = await action(null, { id });
      if (result.ok) await onRestored();
      else
        onError(
          result.formError ?? Object.values(result.fieldErrors)[0] ?? 'It couldn’t be restored.',
        );
    } finally {
      setPending(false);
    }
  }

  return (
    <Button variant="tinted" loading={pending} aria-label={label} onClick={() => void restore()}>
      {pending ? null : <RotateCcw aria-hidden="true" className="size-4.5" />}
      Restore
    </Button>
  );
}

/** A section-level error (a refused restore, or a change refused because the client is retired). */
export function SectionAlert({ message }: { message: string | null }) {
  return <FormAlert message={message} />;
}
