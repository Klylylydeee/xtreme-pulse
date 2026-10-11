'use client';

import { type FormEvent, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarDays, CalendarPlus, Megaphone, PencilLine, TriangleAlert } from 'lucide-react';
import {
  formatDate,
  HOLIDAY_LEGAL_BASIS_MAX_LENGTH,
  HOLIDAY_LOCATION_MAX_LENGTH,
  HOLIDAY_NAME_MAX_LENGTH,
  HOLIDAY_SCOPE_LABELS,
  HOLIDAY_SCOPES,
  HOLIDAY_SOURCE_LABELS,
  HOLIDAY_STATUS_LABELS,
  HOLIDAY_TYPE_LABELS,
  HOLIDAY_TYPES,
  type HolidayScope,
} from '@pulse/core';
import type { HolidayView, SameDateHoliday } from '@pulse/core/server';
import { Button } from '@pulse/ui/components/button';
import { DestructiveConfirmDialog } from '@pulse/ui/components/confirm-dialog';
import { FormField, FormSection, Input, Select } from '@pulse/ui/components/form';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { SegmentedControl } from '@pulse/ui/components/segmented-control';
import { SheetBody, SheetClose, SheetFooter, SheetHeader } from '@pulse/ui/components/sheet';
import {
  ariaKeyShortcuts,
  ShortcutHint,
  submitFormFromShortcut,
  useShortcut,
} from '@pulse/ui/components/shortcut-hint';
import { FormAlert } from '@/components/form-alert';
import { ReadOnlyField, useActionSubmit } from '@/components/org-structure';
import {
  confirmHolidayAction,
  createHolidayAction,
  declareHolidayAction,
  deleteHolidayAction,
  findHolidaysOnDateAction,
  updateHolidayAction,
} from '@/lib/actions/holidays';
import { ConfirmDialog } from './confirm-dialog';

// Spec: docs/modules/core.md#holiday-calendar — the holiday sheet, for HR and the System
// Administrator: add a holiday (a draft), declare one (confirmed at once, and every active user is
// notified), or edit one. A draft can be saved, confirmed (it needs a legal basis) or deleted. A
// confirmed holiday can be edited or deleted after a confirmation dialog; there is no unconfirm.
// The date moves within its year only. A date that already has a holiday shows a non-blocking
// warning naming it: several holidays may share a date.

export type HolidaySheetMode = 'add' | 'declare' | 'edit';

const SUBMIT = ['mod', 'enter'] as const;

const SCOPE_SEGMENTS = HOLIDAY_SCOPES.map((value) => ({
  value,
  label: HOLIDAY_SCOPE_LABELS[value],
}));

const LEGAL_BASIS_EXAMPLE = 'For example “Proclamation No. 1006”.';

/** The form's values as typed, to tell whether a draft changed before confirming it. */
function formValues(form: HTMLFormElement) {
  const data = new FormData(form);
  const text = (key: string) => String(data.get(key) ?? '').trim();
  const scope = text('scope');
  return {
    name: text('name'),
    date: text('date'),
    type: text('type'),
    scope,
    location: scope === 'local' ? text('location') : '',
    legalBasis: text('legalBasis'),
  };
}

type FormValues = ReturnType<typeof formValues>;

/** A loaded holiday's values, as the form shows them. */
function valuesOf(holiday: HolidayView): FormValues {
  return {
    name: holiday.name,
    date: holiday.date,
    type: holiday.type,
    scope: holiday.scope,
    location: holiday.scope === 'local' ? (holiday.location ?? '') : '',
    legalBasis: holiday.legalBasis ?? '',
  };
}

function changedFrom(saved: FormValues, form: HTMLFormElement): boolean {
  const values = formValues(form);
  return (Object.keys(saved) as (keyof FormValues)[]).some((key) => values[key] !== saved[key]);
}

/** "This date already has Christmas Day (draft)." */
function sameDateWarning(matches: SameDateHoliday[]): string {
  const names = matches.map(
    (match) => `${match.name}${match.status === 'draft' ? ' (draft)' : ''}`,
  );
  const list =
    names.length <= 1
      ? (names[0] ?? '')
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `This date already has ${list}. Holidays can share a date, so you can still save.`;
}

/** The sheet's content: one form, for adding, declaring or editing. Keyed per opening. */
export function HolidaySheet({
  mode,
  holiday,
  onDone,
}: {
  mode: HolidaySheetMode;
  /** The holiday being edited (edit mode only). */
  holiday: HolidayView | null;
  /** After a change: closes the sheet and shows `message`. */
  onDone: (message: string) => void;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef('');
  const confirmAfterSave = useRef(false);
  const pendingSave = useRef<FormData | null>(null);
  const warningId = useId();
  const editing = mode === 'edit' && holiday !== null;
  const confirmed = editing && holiday.status === 'confirmed';

  const [scope, setScope] = useState<HolidayScope>(holiday?.scope ?? 'nationwide');
  const [sameDate, setSameDate] = useState<SameDateHoliday[] | null>(null);
  const [askingToSave, setAskingToSave] = useState(false);
  // Confirming a changed draft saves it first: the Confirm button shows the progress, not Save.
  const [confirmingDraft, setConfirmingDraft] = useState(false);
  const checkRequest = useRef(0);
  // What the server last saved: the holiday as loaded, then each save from this sheet. A save
  // refreshes `updatedAt`, so saving, confirming or deleting again isn't refused as stale.
  const savedUpdatedAt = useRef(holiday?.updatedAt.toISOString() ?? '');
  const savedValues = useRef<FormValues | null>(holiday ? valuesOf(holiday) : null);
  const lastSent = useRef<FormValues | null>(null);

  const create = useActionSubmit(createHolidayAction, () =>
    onDone(`${nameRef.current} added as a draft.`),
  );
  const declare = useActionSubmit(declareHolidayAction, ({ notified }) =>
    onDone(
      `${nameRef.current} declared. ${
        notified === 0
          ? 'There was no one else to notify.'
          : `${notified} ${notified === 1 ? 'person was' : 'people were'} notified.`
      }`,
    ),
  );
  const update = useActionSubmit(updateHolidayAction, ({ updatedAt }) => {
    savedUpdatedAt.current = updatedAt;
    savedValues.current = lastSent.current;
    if (!confirmAfterSave.current) onDone(`${nameRef.current} saved.`);
  });
  const confirm = useActionSubmit(confirmHolidayAction, () =>
    onDone(`${nameRef.current} confirmed.`),
  );

  const save = mode === 'add' ? create : mode === 'declare' ? declare : update;
  const fieldErrors = { ...save.fieldErrors, ...confirm.fieldErrors };
  const formError = confirm.formError ?? save.formError;
  const busy = save.pending || confirm.pending || confirmingDraft;

  useShortcut(SUBMIT, () => submitFormFromShortcut(formRef.current), { scope: formRef });

  function focusFirstError() {
    requestAnimationFrame(() => {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    });
  }

  /** The form's fields, with the `updatedAt` of the last save (edit mode). */
  function withSavedUpdatedAt(data: FormData): FormData {
    if (editing) data.set('expectedUpdatedAt', savedUpdatedAt.current);
    return data;
  }

  async function runSave(data: FormData) {
    confirm.reset();
    confirmAfterSave.current = false;
    if (formRef.current) lastSent.current = formValues(formRef.current);
    const ok = await save.run(withSavedUpdatedAt(data));
    if (!ok) focusFirstError();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    nameRef.current = String(data.get('name') ?? '').trim();
    if (confirmed) {
      // Changing a confirmed holiday changes attendance, leave and payroll: ask first.
      pendingSave.current = data;
      setAskingToSave(true);
      return;
    }
    void runSave(data);
  }

  /** Confirm a draft: saves the form first when it changed, then confirms it. */
  async function confirmDraft() {
    const form = formRef.current;
    if (!form || !holiday) return;
    nameRef.current = formValues(form).name || holiday.name;
    confirm.reset();
    update.reset();
    setConfirmingDraft(true);
    try {
      if (!savedValues.current || changedFrom(savedValues.current, form)) {
        confirmAfterSave.current = true;
        lastSent.current = formValues(form);
        const saved = await update.run(withSavedUpdatedAt(new FormData(form)));
        confirmAfterSave.current = false;
        if (!saved) {
          focusFirstError();
          return;
        }
        // The edit is saved even if the confirm is then refused: show it in the list behind.
        router.refresh();
      }
      // The save, if any, refreshed `savedUpdatedAt`.
      const ok = await confirm.run({ id: holiday.id, expectedUpdatedAt: savedUpdatedAt.current });
      if (!ok) focusFirstError();
    } finally {
      setConfirmingDraft(false);
    }
  }

  function checkDate(value: string) {
    const request = ++checkRequest.current;
    setSameDate(null);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    void findHolidaysOnDateAction(null, { date: value, exceptId: holiday?.id ?? null })
      .then((result) => {
        if (request !== checkRequest.current || !result.ok) return;
        setSameDate(result.data.length > 0 ? result.data : null);
      })
      .catch(() => {
        // The warning is only a hint; without it the form still saves.
      });
  }

  const title =
    mode === 'add' ? 'Add holiday' : mode === 'declare' ? 'Declare holiday' : (holiday?.name ?? '');
  const LeadingIcon = mode === 'add' ? CalendarPlus : mode === 'declare' ? Megaphone : CalendarDays;
  const legalBasisRequired = mode === 'declare' || confirmed;
  const yearBounds = editing
    ? { min: `${holiday.year}-01-01`, max: `${holiday.year}-12-31` }
    : undefined;

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={submit}
      className="flex min-h-0 flex-1 flex-col"
      aria-busy={busy || undefined}
    >
      <SheetHeader
        title={title}
        description={
          editing
            ? `${HOLIDAY_STATUS_LABELS[holiday.status]} · ${formatDate(holiday.date)}`
            : undefined
        }
        leading={
          <IconTile className="size-11 rounded-xl [&_svg]:size-5">
            <LeadingIcon strokeWidth={1.75} />
          </IconTile>
        }
      />
      <SheetBody>
        {editing ? (
          <>
            <input type="hidden" name="id" value={holiday.id} />
          </>
        ) : null}
        <input type="hidden" name="scope" value={scope} />
        {mode === 'declare' ? (
          <p className="flex items-start gap-2 rounded-card bg-accent-subtle px-4 py-3 text-footnote font-medium text-accent">
            <Megaphone aria-hidden="true" className="mt-px size-4 shrink-0" />
            <span>
              For a holiday announced at short notice. It’s confirmed at once, and every active user
              is notified.
            </span>
          </p>
        ) : null}
        {confirmed ? (
          <p className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-footnote text-text-secondary shadow-card">
            <PencilLine aria-hidden="true" className="mt-px size-4 shrink-0" />
            <span>
              This holiday is confirmed, so it counts for attendance, leave and payroll. You’ll be
              asked before a change is saved.
            </span>
          </p>
        ) : null}
        <FormAlert message={formError} />
        <FormSection title="Holiday">
          <FormField label="Name" required error={fieldErrors.name}>
            <Input
              name="name"
              defaultValue={holiday?.name ?? ''}
              maxLength={HOLIDAY_NAME_MAX_LENGTH}
              autoComplete="off"
              autoFocus={!editing}
              required
            />
          </FormField>
          <FormField
            label="Date"
            required
            hint={editing ? `It can move within ${holiday.year} only.` : undefined}
            error={fieldErrors.date}
          >
            <Input
              type="date"
              name="date"
              defaultValue={holiday?.date ?? ''}
              min={yearBounds?.min}
              max={yearBounds?.max}
              required
              aria-describedby={sameDate ? warningId : undefined}
              onChange={(event) => checkDate(event.currentTarget.value)}
              className="numeric sm:max-w-60"
            />
            <div aria-live="polite">
              {sameDate ? (
                <p
                  id={warningId}
                  className="flex items-start gap-1.5 text-footnote font-medium text-warning-text"
                >
                  <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
                  <span>{sameDateWarning(sameDate)}</span>
                </p>
              ) : null}
            </div>
          </FormField>
          <FormField label="Type" required error={fieldErrors.type}>
            <Select name="type" defaultValue={holiday?.type ?? ''} required>
              <option value="" disabled>
                Choose a type
              </option>
              {HOLIDAY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {HOLIDAY_TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
          </FormField>
        </FormSection>
        <FormSection title="Where it applies">
          <div className="flex flex-col gap-1.5 px-4 py-3">
            <SegmentedControl
              label="Scope"
              options={SCOPE_SEGMENTS}
              value={scope}
              onValueChange={setScope}
              tone="accent"
              fullWidth
            />
            {fieldErrors.scope ? (
              <p className="text-footnote font-medium text-destructive-text" role="alert">
                {fieldErrors.scope}
              </p>
            ) : null}
          </div>
          {scope === 'local' ? (
            <FormField
              label="Location"
              required
              hint="The city or municipality where it applies."
              error={fieldErrors.location}
            >
              <Input
                name="location"
                defaultValue={holiday?.location ?? ''}
                maxLength={HOLIDAY_LOCATION_MAX_LENGTH}
                autoComplete="off"
                required
              />
            </FormField>
          ) : null}
        </FormSection>
        <FormSection title="Legal basis">
          <FormField
            label="Legal basis"
            required={legalBasisRequired}
            hint={
              legalBasisRequired
                ? LEGAL_BASIS_EXAMPLE
                : `Optional on a draft, but needed to confirm it. ${LEGAL_BASIS_EXAMPLE}`
            }
            error={fieldErrors.legalBasis}
          >
            <Input
              name="legalBasis"
              defaultValue={holiday?.legalBasis ?? ''}
              maxLength={HOLIDAY_LEGAL_BASIS_MAX_LENGTH}
              autoComplete="off"
              required={legalBasisRequired}
            />
          </FormField>
        </FormSection>
        {editing ? (
          <FormSection title="Details">
            <ReadOnlyField label="Status">
              {HOLIDAY_STATUS_LABELS[holiday.status]}
              {holiday.declared ? ', declared' : null}
              {holiday.confirmedAt ? ` on ${formatDate(holiday.confirmedAt)}` : null}
            </ReadOnlyField>
            <ReadOnlyField label="Source">{HOLIDAY_SOURCE_LABELS[holiday.source]}</ReadOnlyField>
          </FormSection>
        ) : null}
      </SheetBody>
      <SheetFooter>
        {editing ? (
          <DeleteHolidayButton
            holiday={holiday}
            savedUpdatedAt={() => savedUpdatedAt.current}
            onDeleted={onDone}
          />
        ) : null}
        <SheetClose asChild>
          <Button variant="secondary" className="pr-3">
            Cancel
            <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
          </Button>
        </SheetClose>
        {editing && holiday.status === 'draft' ? (
          <Button
            variant="tinted"
            loading={confirmingDraft}
            disabled={busy}
            onClick={() => void confirmDraft()}
          >
            Confirm
          </Button>
        ) : null}
        <Button
          type="submit"
          loading={save.pending && !confirmingDraft}
          disabled={busy}
          aria-keyshortcuts={ariaKeyShortcuts(SUBMIT)}
          className="pr-3"
        >
          {mode === 'add' ? 'Add holiday' : mode === 'declare' ? 'Declare holiday' : 'Save'}
          <ShortcutHint keys={SUBMIT} tone="on-fill" className="hidden sm:inline-flex" />
        </Button>
      </SheetFooter>
      {confirmed ? (
        <ConfirmDialog
          open={askingToSave}
          onOpenChange={setAskingToSave}
          icon={<PencilLine strokeWidth={1.75} />}
          title={`Save changes to ${holiday.name}?`}
          description="It’s a confirmed holiday, so the change applies to attendance, leave and payroll."
          confirmLabel="Save changes"
          onConfirm={() => {
            setAskingToSave(false);
            const data = pendingSave.current;
            pendingSave.current = null;
            if (data) void runSave(data);
          }}
        />
      ) : null}
    </form>
  );
}

/** Delete, after the destructive confirmation. A refused delete is shown in the dialog. */
function DeleteHolidayButton({
  holiday,
  savedUpdatedAt,
  onDeleted,
}: {
  holiday: HolidayView;
  /** The `updatedAt` of the sheet's last save (the loaded one before any). */
  savedUpdatedAt: () => string;
  onDeleted: (message: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const remove = useActionSubmit(deleteHolidayAction, () => onDeleted(`${holiday.name} deleted.`));

  const description = [
    holiday.status === 'confirmed'
      ? 'It stops counting for attendance, leave and payroll.'
      : 'The draft is removed from the calendar.',
    holiday.source === 'rule' ? 'The auto-draft won’t add it again for this year.' : null,
    'This can’t be undone.',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <Button
        variant="plain"
        onClick={() => {
          remove.reset();
          setConfirming(true);
        }}
        className="mr-auto text-destructive-text hover:bg-bg-grouped hover:text-destructive-text"
      >
        Delete
      </Button>
      <DestructiveConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${holiday.name}?`}
        description={description}
        confirmLabel="Delete holiday"
        error={remove.formError}
        onConfirm={async () => {
          const ok = await remove.run({
            id: holiday.id,
            expectedUpdatedAt: savedUpdatedAt(),
          });
          // Keeps the dialog open, showing why, when the delete was refused.
          if (!ok) throw new Error('Delete refused');
        }}
      />
    </>
  );
}
