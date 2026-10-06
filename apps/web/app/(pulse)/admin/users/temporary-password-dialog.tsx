'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, KeyRound } from 'lucide-react';
import { Button } from '@pulse/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pulse/ui/components/dialog';
import { IconTile } from '@pulse/ui/components/icon-tile';

// Spec: SECURITY.md#sign-in-and-passwords and docs/modules/core.md#managing-user-accounts — after
// creating a user or resetting a password, the temporary password is shown once, with Copy and
// "Hand it over privately". It lives only in this dialog's state: closing it drops it, and it
// can't be shown again (reset again if it's lost). It isn't dismissed by a click outside, so it
// isn't lost by accident; Done and Escape close it. After a create (build step 1.7), closing it
// goes on to the new user's access sheet (`/admin/access?user=<id>`), which the dialog says.

/** What the dialog shows: whose password it is, and the password itself. */
export interface TemporaryPasswordNotice {
  /** "created" after adding a user, "reset" after a reset. */
  kind: 'created' | 'reset';
  /** The new user's ID after a create: the page opens their access sheet once this closes. */
  userId?: string;
  /** The person's name, or the email for the system account. */
  name: string;
  email: string;
  /** Shown after a create. */
  employeeNumber: string | null;
  temporaryPassword: string;
}

const COPIED_FOR_MS = 2000;

export function TemporaryPasswordDialog({
  notice,
  onClose,
  onCloseAutoFocus,
}: {
  notice: TemporaryPasswordNotice | null;
  /** Called when the dialog closes; the caller drops the password. */
  onClose: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  // Kept while the dialog animates closed, then dropped with the notice.
  const [shown, setShown] = useState<TemporaryPasswordNotice | null>(notice);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);

  if (notice && notice !== shown) {
    setShown(notice);
    setCopy('idle');
  }

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copyPassword() {
    if (!shown) return;
    try {
      await navigator.clipboard.writeText(shown.temporaryPassword);
      setCopy('copied');
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopy('idle'), COPIED_FOR_MS);
    } catch {
      setCopy('failed');
    }
  }

  return (
    <Dialog
      open={notice !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          setShown(null);
          onCloseAutoFocus?.(event);
        }}
        className={[
          'top-1/2 left-1/2 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-5',
          'rounded-panel bg-surface p-6 text-text-primary shadow-float',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
        ].join(' ')}
      >
        {shown ? (
          <>
            <div className="flex items-start gap-4">
              <IconTile className="size-11 shrink-0 rounded-xl [&_svg]:size-5">
                <KeyRound strokeWidth={1.75} />
              </IconTile>
              <div className="flex min-w-0 flex-col gap-1.5">
                <DialogTitle>
                  {shown.kind === 'created'
                    ? `${shown.name} added`
                    : `Password reset for ${shown.name}`}
                </DialogTitle>
                <DialogDescription>
                  Hand it over privately. It won’t be shown again.
                </DialogDescription>
              </div>
            </div>
            <dl className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-bg-grouped">
              <div className="flex flex-col gap-0.5 px-4 py-3">
                <dt className="text-footnote font-semibold text-text-secondary">Login email</dt>
                <dd className="text-subheadline break-all">{shown.email}</dd>
              </div>
              {shown.employeeNumber ? (
                <div className="flex flex-col gap-0.5 px-4 py-3">
                  <dt className="text-footnote font-semibold text-text-secondary">
                    Employee number
                  </dt>
                  <dd className="numeric text-subheadline">{shown.employeeNumber}</dd>
                </div>
              ) : null}
              <div className="flex flex-col gap-1 px-4 py-3">
                <dt className="text-footnote font-semibold text-text-secondary">
                  Temporary password
                </dt>
                <dd className="font-mono text-title-3 tracking-wider break-all select-all">
                  {shown.temporaryPassword}
                </dd>
              </div>
            </dl>
            <p className="text-footnote text-text-secondary">
              They must change it when they first sign in.
              {shown.kind === 'reset' ? ' They were signed out everywhere.' : null} If it’s lost,
              reset the password again.
              {shown.kind === 'created' && shown.userId
                ? ' Next, you’ll set the modules they can open.'
                : null}
            </p>
            <p role="status" className="text-footnote font-medium empty:hidden">
              {copy === 'copied' ? (
                <span className="text-success-text">Copied to the clipboard.</span>
              ) : copy === 'failed' ? (
                <span className="text-destructive-text">
                  Couldn’t copy. Select the password and copy it yourself.
                </span>
              ) : null}
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="secondary" onClick={onClose}>
                Done
              </Button>
              <Button onClick={() => void copyPassword()} autoFocus>
                {copy === 'copied' ? (
                  <Check aria-hidden="true" className="size-4.5" />
                ) : (
                  <Copy aria-hidden="true" className="size-4.5" />
                )}
                Copy password
              </Button>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
