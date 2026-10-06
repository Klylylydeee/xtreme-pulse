'use client';

import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { cn } from '@pulse/ui';
import { Button } from '@pulse/ui/components/button';
import { DestructiveConfirmDialog } from '@pulse/ui/components/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pulse/ui/components/dialog';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { ShortcutHint } from '@pulse/ui/components/shortcut-hint';
import { FormAlert } from '@/components/form-alert';
import { Badge, useActionSubmit } from '@/components/org-structure';
import { setSystemAccountDisabledAction } from '@/lib/actions/users';

// Spec: SECURITY.md#system-administrator (build step 1.7, decision 75) — a System Administrator
// can Disable or Enable the bootstrap system account on `/admin/users`, never the system account
// itself, and a disable that would leave no active System Administrator is refused
// (SECURITY.md#account-status). Each change asks first: disabling signs the account out on its next
// request, enabling lets it sign in again with full access. The Server Action checks the role, and
// the service checks it again with the rest; this control only shows to a System Administrator.

const DISABLE_DESCRIPTION =
  'It’s signed out on its next request and can’t sign in until a System Administrator enables it again. It can’t be disabled while it’s the only active System Administrator.';
const ENABLE_DESCRIPTION =
  'It can sign in again with its current password, as a System Administrator with full access to every module.';

/** The system account's status on its sheet, with Disable or Enable after a confirmation. */
export function SystemAccountStatusRow({
  disabled,
  onChanged,
}: {
  /** Whether the system account is disabled now. */
  disabled: boolean;
  /** The change was saved: the sheet closes and the list refreshes. */
  onChanged: (disabled: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const change = useActionSubmit<unknown>(setSystemAccountDisabledAction, () =>
    onChanged(!disabled),
  );

  function open() {
    change.reset();
    setConfirming(true);
  }

  return (
    <div className="flex flex-col gap-1.5 px-4 py-3">
      <span className="text-subheadline font-medium text-text-primary">Account status</span>
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="flex flex-wrap items-center gap-2 text-body md:text-subheadline">
          {disabled ? <Badge>Disabled</Badge> : 'Active'}
        </span>
        <Button variant="tinted" onClick={open}>
          {disabled ? 'Enable' : 'Disable'}
        </Button>
      </div>
      <p className="text-footnote text-text-secondary">
        {disabled
          ? 'A disabled system account can’t sign in.'
          : 'Disabling it signs it out at once. It can’t be disabled while it’s the only active System Administrator.'}
      </p>
      {disabled ? (
        <EnableDialog
          open={confirming}
          onOpenChange={setConfirming}
          pending={change.pending}
          error={change.formError}
          onConfirm={() => void change.run({ disabled: false })}
        />
      ) : (
        <DestructiveConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Disable the system account?"
          description={DISABLE_DESCRIPTION}
          confirmLabel="Disable system account"
          error={change.formError}
          onConfirm={async () => {
            const ok = await change.run({ disabled: true });
            if (!ok) throw new Error('Disable refused');
          }}
        />
      )}
    </div>
  );
}

/** Enabling isn't destructive, so it asks in a plain dialog with a primary button. */
function EnableDialog({
  open,
  onOpenChange,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  error: string | null | undefined;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent
        className={cn(
          'top-1/2 left-1/2 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-5 overflow-y-auto',
          'rounded-panel bg-surface p-6 text-text-primary shadow-float',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
        )}
      >
        <div className="flex items-start gap-4">
          <IconTile className="size-11 shrink-0 rounded-xl [&_svg]:size-5">
            <ShieldCheck strokeWidth={1.75} />
          </IconTile>
          <div className="flex min-w-0 flex-col gap-1.5">
            <DialogTitle>Enable the system account?</DialogTitle>
            <DialogDescription>{ENABLE_DESCRIPTION}</DialogDescription>
          </div>
        </div>
        <FormAlert message={error} />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={pending}
            className="gap-2.5"
          >
            Cancel
            <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
          </Button>
          <Button loading={pending} onClick={onConfirm}>
            Enable system account
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
