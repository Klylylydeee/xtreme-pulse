'use client';

import { useId, useState } from 'react';
import { CircleAlert, UserRoundCog } from 'lucide-react';
import {
  type BusinessDate,
  EMPLOYMENT_STATUS_OPTIONS,
  type EmploymentStatus,
  formatDate,
  isSeparatedStatus,
  SEPARATION_IN_FUTURE,
} from '@pulse/core';
import { cn } from '@pulse/ui';
import { Button } from '@pulse/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pulse/ui/components/dialog';
import { FormField, Input } from '@pulse/ui/components/form';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { ShortcutHint } from '@pulse/ui/components/shortcut-hint';
import { FormAlert } from '@/components/form-alert';
import { useActionSubmit } from '@/components/org-structure';
import { changeEmploymentStatusAction } from '@/lib/actions/users';

// Spec: SECURITY.md#account-status — changing the employment status takes effect at once: a
// separated status (Resigned, Retired) deactivates the account and signs the person out on their
// next request, and needs a separation date (today or earlier in Manila, not before the date
// hired). Terminated shows disabled with its hint until termination due process is built. A move
// back to an active status clears the date.

export interface EmploymentStatusTarget {
  id: string;
  name: string;
  employmentStatus: EmploymentStatus;
  separationDate: BusinessDate | null;
  dateHired: BusinessDate;
}

export function EmploymentStatusDialog({
  open,
  onOpenChange,
  target,
  today,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: EmploymentStatusTarget;
  /** Today in Manila: the latest separation date. */
  today: BusinessDate;
  onChanged: (status: EmploymentStatus, separationDate: BusinessDate | null) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'top-1/2 left-1/2 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col overflow-y-auto',
          'rounded-panel bg-surface text-text-primary shadow-float',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
        )}
      >
        {open ? (
          <StatusForm
            target={target}
            today={today}
            onCancel={() => onOpenChange(false)}
            onChanged={onChanged}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function StatusForm({
  target,
  today,
  onCancel,
  onChanged,
}: {
  target: EmploymentStatusTarget;
  today: BusinessDate;
  onCancel: () => void;
  onChanged: (status: EmploymentStatus, separationDate: BusinessDate | null) => void;
}) {
  const [status, setStatus] = useState<EmploymentStatus>(target.employmentStatus);
  const [separationDate, setSeparationDate] = useState<string>(
    target.separationDate ?? (isSeparatedStatus(target.employmentStatus) ? '' : today),
  );
  const groupId = useId();
  const save = useActionSubmit(changeEmploymentStatusAction, () =>
    onChanged(status, isSeparatedStatus(status) ? (separationDate as BusinessDate) : null),
  );

  const separating = isSeparatedStatus(status);
  const wasSeparated = isSeparatedStatus(target.employmentStatus);
  const unchanged =
    status === target.employmentStatus &&
    (!separating || separationDate === (target.separationDate ?? ''));
  const statusError = save.fieldErrors.employmentStatus;

  const consequence = separating
    ? wasSeparated
      ? `${target.name} stays signed out and can’t sign in.`
      : `${target.name} is signed out at once and can’t sign in while ${status}.`
    : wasSeparated
      ? `${target.name}’s account becomes active at once, and they can sign in again.`
      : 'The change takes effect at once.';

  return (
    <form
      noValidate
      onSubmit={(event) => void save.onSubmit(event)}
      className="flex flex-col gap-5 p-6"
    >
      <input type="hidden" name="id" value={target.id} />
      <div className="flex items-start gap-4">
        <IconTile className="size-11 shrink-0 rounded-xl [&_svg]:size-5">
          <UserRoundCog strokeWidth={1.75} />
        </IconTile>
        <div className="flex min-w-0 flex-col gap-1.5">
          <DialogTitle>Change employment status</DialogTitle>
          <DialogDescription>
            {target.name} is {target.employmentStatus}
            {target.separationDate ? ` since ${formatDate(target.separationDate)}` : null}.
          </DialogDescription>
        </div>
      </div>
      <FormAlert message={save.formError} />
      <fieldset
        aria-describedby={statusError ? `${groupId}-error` : undefined}
        className="flex flex-col gap-2"
      >
        <legend className="mb-2 px-4 text-footnote font-semibold text-text-secondary">
          Employment status
        </legend>
        <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-bg-grouped">
          {EMPLOYMENT_STATUS_OPTIONS.map((option) => {
            const optionId = `${groupId}-${option.value}`;
            return (
              // The hint sits outside the label, so the radio's name is the status alone (the hint
              // is its description).
              <div
                key={option.value}
                className={cn(
                  'relative flex min-h-11 items-start gap-3 px-4 py-3',
                  option.disabled ? 'cursor-not-allowed' : 'cursor-pointer',
                )}
              >
                <input
                  id={optionId}
                  type="radio"
                  name="employmentStatus"
                  value={option.value}
                  checked={status === option.value}
                  disabled={option.disabled}
                  aria-describedby={option.hint ? `${optionId}-hint` : undefined}
                  onChange={() => {
                    setStatus(option.value);
                    save.reset();
                  }}
                  className="mt-0.5 size-5 shrink-0 cursor-[inherit] accent-accent"
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  {/* Stretched over the row, so the whole row picks the status. */}
                  <label
                    htmlFor={optionId}
                    className={cn(
                      'flex items-center gap-2 text-subheadline font-medium',
                      "after:absolute after:inset-0 after:content-['']",
                      option.disabled ? 'cursor-not-allowed text-text-secondary' : 'cursor-pointer',
                    )}
                  >
                    {option.value}
                    {option.value === target.employmentStatus ? (
                      <span className="text-footnote font-normal text-text-secondary">
                        (current)
                      </span>
                    ) : null}
                  </label>
                  {option.hint ? (
                    <span id={`${optionId}-hint`} className="text-footnote text-text-secondary">
                      {option.hint}
                    </span>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
        <div aria-live="polite">
          {statusError ? (
            <p
              id={`${groupId}-error`}
              className="flex items-start gap-1.5 px-4 text-footnote font-medium text-destructive-text"
            >
              <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
              <span>{statusError}</span>
            </p>
          ) : null}
        </div>
      </fieldset>
      {separating ? (
        <div className="overflow-hidden rounded-card bg-bg-grouped">
          <FormField
            label="Separation date"
            required
            hint={`From ${formatDate(target.dateHired)} (the date hired) to today. ${SEPARATION_IN_FUTURE}`}
            error={save.fieldErrors.separationDate}
          >
            <Input
              type="date"
              name="separationDate"
              value={separationDate}
              min={target.dateHired}
              max={today}
              onChange={(event) => setSeparationDate(event.target.value)}
              required
            />
          </FormField>
        </div>
      ) : null}
      <p className="text-footnote text-text-secondary">{consequence}</p>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={onCancel} disabled={save.pending} className="gap-2.5">
          Cancel
          <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
        </Button>
        <Button
          type="submit"
          variant={separating && !wasSeparated ? 'destructive' : 'primary'}
          loading={save.pending}
          disabled={unchanged}
        >
          {separating && !wasSeparated ? `Change to ${status}` : 'Change status'}
        </Button>
      </div>
    </form>
  );
}
