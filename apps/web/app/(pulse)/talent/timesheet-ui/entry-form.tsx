'use client';

import { type FormEvent, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, RotateCw, Trash2 } from 'lucide-react';
import type { BusinessDate } from '@pulse/core';
import {
  EXTRA_HOURS_REASON_MAX_LENGTH,
  EXTRA_HOURS_SWITCH_LABEL,
  type ExtraHoursTreatment,
  PROJECT_PICKER_NOTE,
  TICKET_PICKER_NOTE,
  TIME_ENTRY_ACTIVITY_MAX_LENGTH,
  type TimeEntryView,
  type TimesheetClientOption,
} from '@pulse/talent';
import { Button } from '@pulse/ui/components/button';
import { DestructiveConfirmDialog } from '@pulse/ui/components/confirm-dialog';
import { FormField, FormSection, Input, Select, Switch, Textarea } from '@pulse/ui/components/form';
import { SheetBody, SheetClose, SheetFooter, SheetHeader } from '@pulse/ui/components/sheet';
import {
  ariaKeyShortcuts,
  ShortcutHint,
  submitFormFromShortcut,
  useShortcut,
} from '@pulse/ui/components/shortcut-hint';
import { FormAlert } from '@/components/form-alert';
import { useActionSubmit } from '@/components/org-structure';
import {
  createTimeEntryAction,
  deleteTimeEntryAction,
  timeOutAction,
  updateTimeEntryAction,
} from '@/lib/actions/talent-timesheets';
import { clockTimeOf, longDayText } from './format';

// Spec: docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24 ("Time
// entries", "Screens": the entry sheet) and docs/DESIGN_SYSTEM.md#layout--components ("Timesheets
// on a phone": Sheets). Native time inputs, a "Next day" switch for the time out, the required
// activity, a client picker, the project and ticket pickers disabled with their notes, and the
// extra-hours switch with its required reason. Three forms:
//
// - **add** ("Add entry" on a day): typed times, so both sides are `manual`. An empty time out
//   leaves the entry open.
// - **edit**: the whole entry with the version it was loaded at; a time sent unchanged keeps its
//   stored source, a changed one becomes `manual` (the server decides). "Delete entry" asks first.
// - **timeOut**: Time out found no activity, so it asks for it and times out with the server's
//   time; the client and the extra-hours mark are sent only when given.
//
// The checks run on the server; the activity and the reason are also checked here so the sheet
// says so at once. A stale save comes back as a form error with a reload. Nothing is logged.

const SAVE = ['mod', 's'] as const;
const SAVE_FAILED = 'The entry wasn’t saved. Check your connection and try again.';
const DELETE_FAILED = 'The entry wasn’t deleted. Check your connection and try again.';
const ACTIVITY_MISSING = 'Enter the activity performed.';
const REASON_MISSING = 'Enter the reason for the extra hours.';

export type EntryFormMode =
  | { kind: 'add'; date: BusinessDate }
  | { kind: 'edit'; entry: TimeEntryView }
  | { kind: 'timeOut' };

export function EntryForm({
  mode,
  treatment,
  clients,
  onBack,
  onDone,
}: {
  mode: EntryFormMode;
  /** The day's treatment of claimed extra hours: the switch reads "as overtime" or "as offset". */
  treatment: ExtraHoursTreatment;
  clients: readonly TimesheetClientOption[];
  /** Back to the day sheet; absent when the form opened on its own (Time out). */
  onBack?: () => void;
  /** Saved, deleted or timed out. */
  onDone: () => void;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const entry = mode.kind === 'edit' ? mode.entry : null;

  const [timeIn, setTimeIn] = useState(entry ? clockTimeOf(entry.timeIn) : '');
  const [timeOut, setTimeOut] = useState(entry?.timeOut ? clockTimeOf(entry.timeOut) : '');
  const [nextDay, setNextDay] = useState(entry?.endsNextDay ?? false);
  const [activity, setActivity] = useState(entry?.activity ?? '');
  const [clientId, setClientId] = useState(entry?.client?.id ?? '');
  const [extra, setExtra] = useState(entry?.extraHours !== null && entry?.extraHours !== undefined);
  const [reason, setReason] = useState(entry?.extraHours?.reason ?? '');
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const create = useActionSubmit(createTimeEntryAction, onDone);
  const update = useActionSubmit(updateTimeEntryAction, onDone);
  const close = useActionSubmit(timeOutAction, (result) => {
    if (result.status === 'timedOut') onDone();
    else setLocalErrors({ activity: ACTIVITY_MISSING });
  });
  const remove = useActionSubmit(deleteTimeEntryAction, onDone);
  const save = mode.kind === 'add' ? create : mode.kind === 'edit' ? update : close;

  useShortcut(SAVE, () => submitFormFromShortcut(formRef.current), { scope: formRef });

  // An entry's own client may be retired since; keep it as an option so the sheet shows it.
  const clientOptions =
    entry?.client && !clients.some((client) => client.id === entry.client?.id)
      ? [...clients, entry.client]
      : clients;

  const errors = { ...save.fieldErrors, ...localErrors };
  const formError =
    save.formError ?? errors.date ?? errors.entryId ?? errors.version ?? networkError;

  function focusFirstError() {
    requestAnimationFrame(() => {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNetworkError(null);
    const missing: Record<string, string> = {};
    const closing = mode.kind === 'timeOut' || timeOut.trim() !== '';
    if (closing && activity.trim() === '') missing.activity = ACTIVITY_MISSING;
    if (extra && reason.trim() === '') missing.extraHoursReason = REASON_MISSING;
    setLocalErrors(missing);
    if (Object.keys(missing).length > 0) {
      save.reset();
      focusFirstError();
      return;
    }
    const mark = extra ? reason : '';
    try {
      let ok: boolean;
      if (mode.kind === 'timeOut') {
        ok = await close.run({
          activity,
          ...(clientId ? { clientId } : {}),
          ...(extra ? { extraHoursReason: reason } : {}),
        });
      } else {
        const fields = {
          timeIn,
          timeOut,
          timeOutNextDay: timeOut.trim() !== '' && nextDay,
          activity,
          clientId,
          extraHoursReason: mark,
        };
        ok =
          mode.kind === 'add'
            ? await create.run({ date: mode.date, ...fields })
            : await update.run({
                entryId: mode.entry.id,
                version: mode.entry.version,
                date: mode.entry.date,
                ...fields,
              });
      }
      if (!ok) focusFirstError();
    } catch {
      setNetworkError(SAVE_FAILED);
    }
  }

  async function confirmDelete() {
    if (!entry) return;
    setDeleteError(null);
    let ok = false;
    try {
      ok = await remove.run({ entryId: entry.id, version: entry.version });
    } catch {
      setDeleteError(DELETE_FAILED);
      throw new Error('delete failed');
    }
    if (!ok) throw new Error('delete refused');
  }

  const title =
    mode.kind === 'add' ? 'Add entry' : mode.kind === 'edit' ? 'Edit entry' : 'Time out';
  const description =
    mode.kind === 'timeOut'
      ? 'Enter the activity performed. Time out uses the current time.'
      : longDayText(mode.kind === 'add' ? mode.date : mode.entry.date);

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={submit}
      className="flex min-h-0 flex-1 flex-col"
      aria-busy={save.pending || undefined}
    >
      <SheetHeader
        title={title}
        description={description}
        leading={
          onBack ? (
            <Button
              variant="plain"
              size="icon"
              aria-label="Back to the day"
              onClick={onBack}
              className="-ml-2"
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
          ) : undefined
        }
      />
      <SheetBody>
        <FormAlert message={formError} />
        {formError && mode.kind === 'edit' ? (
          <Button
            variant="secondary"
            onClick={() => {
              router.refresh();
              onDone();
            }}
            className="self-start"
          >
            <RotateCw aria-hidden="true" className="size-4" />
            Reload timesheet
          </Button>
        ) : null}

        {mode.kind === 'timeOut' ? null : (
          <FormSection
            title="Times"
            footer={
              mode.kind === 'add'
                ? 'Typed times show as Manual. Leave the time out empty if you’re still working.'
                : 'A changed time shows as Manual.'
            }
          >
            <FormField label="Time in" required error={errors.timeIn}>
              <Input
                type="time"
                name="timeIn"
                value={timeIn}
                onChange={(event) => setTimeIn(event.target.value)}
                className="numeric"
              />
            </FormField>
            <FormField label="Time out" error={errors.timeOut}>
              <Input
                type="time"
                name="timeOut"
                value={timeOut}
                onChange={(event) => {
                  setTimeOut(event.target.value);
                  if (event.target.value === '') setNextDay(false);
                }}
                className="numeric"
              />
            </FormField>
            <FormField
              label="Next day"
              layout="inline"
              hint="Turn on when the time out is after midnight."
              error={errors.timeOutNextDay}
            >
              <Switch
                checked={nextDay}
                onCheckedChange={setNextDay}
                disabled={timeOut.trim() === ''}
              />
            </FormField>
          </FormSection>
        )}

        <FormSection title="Work">
          <FormField
            label="Activity performed"
            required
            error={errors.activity}
            hint={mode.kind === 'add' ? 'Needed once the entry has a time out.' : undefined}
          >
            <Textarea
              name="activity"
              value={activity}
              maxLength={TIME_ENTRY_ACTIVITY_MAX_LENGTH}
              onChange={(event) => setActivity(event.target.value)}
            />
          </FormField>
          <FormField label="Client" error={errors.clientId}>
            <Select
              name="clientId"
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
            >
              <option value="">No client</option>
              {clientOptions.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Project" hint={PROJECT_PICKER_NOTE}>
            <Select disabled value="">
              <option value="">No project</option>
            </Select>
          </FormField>
          <FormField label="Ticket" hint={TICKET_PICKER_NOTE}>
            <Select disabled value="">
              <option value="">No ticket</option>
            </Select>
          </FormField>
        </FormSection>

        <FormSection title="Extra hours">
          <FormField label={EXTRA_HOURS_SWITCH_LABEL[treatment]} layout="inline">
            <Switch
              checked={extra}
              onCheckedChange={(checked) => {
                setExtra(checked);
                if (!checked) {
                  setLocalErrors((current) => {
                    const rest = { ...current };
                    delete rest.extraHoursReason;
                    return rest;
                  });
                }
              }}
            />
          </FormField>
          {extra ? (
            <FormField label="Reason" required error={errors.extraHoursReason}>
              <Textarea
                name="extraHoursReason"
                value={reason}
                maxLength={EXTRA_HOURS_REASON_MAX_LENGTH}
                onChange={(event) => setReason(event.target.value)}
              />
            </FormField>
          ) : null}
        </FormSection>

        {entry ? (
          <DestructiveConfirmDialog
            trigger={
              <Button variant="secondary" className="self-start text-destructive-text">
                <Trash2 aria-hidden="true" className="size-4" />
                Delete entry
              </Button>
            }
            title="Delete this entry?"
            description="It’s removed from your timesheet. The audit log keeps a record of it."
            confirmLabel="Delete entry"
            onConfirm={confirmDelete}
            error={remove.formError ?? deleteError}
          />
        ) : null}
      </SheetBody>
      <SheetFooter>
        {onBack ? (
          <Button variant="secondary" onClick={onBack}>
            Cancel
          </Button>
        ) : (
          <SheetClose asChild>
            <Button variant="secondary" className="pr-3">
              Cancel
              <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
            </Button>
          </SheetClose>
        )}
        <Button
          type="submit"
          loading={save.pending}
          aria-keyshortcuts={ariaKeyShortcuts(SAVE)}
          className="pr-3"
        >
          {mode.kind === 'add' ? 'Add entry' : mode.kind === 'edit' ? 'Save' : 'Time out'}
          <ShortcutHint keys={SAVE} tone="on-fill" className="hidden sm:inline-flex" />
        </Button>
      </SheetFooter>
    </form>
  );
}
