'use client';

import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { CircleAlert, FileText, Info, TriangleAlert, XCircle } from 'lucide-react';
import { addDays, type BusinessDate } from '@pulse/core';
import {
  formatDayCount,
  formatOffsetHours,
  formatShortDay,
  leaveFilingWindowText,
  leaveSplitText,
  MY_RECORD_HREF,
  TIME_OFF_CANCEL_REASON_MAX_LENGTH,
  TIME_OFF_REASON_MAX_LENGTH,
  type TimeOffKind,
  type TimeOffPortion,
  type TimeOffPreviewView,
  type TimeOffRequestView,
  timeOffProblemMessage,
  timeOffWhenText,
} from '@pulse/talent';
import type { OwnTimeOffView, TimeOffSheetLeaveType } from '@pulse/talent/server';
import { Button } from '@pulse/ui/components/button';
import { FormField, FormSection, Input, Select, Textarea } from '@pulse/ui/components/form';
import { SegmentedControl } from '@pulse/ui/components/segmented-control';
import { SheetBody, SheetClose, SheetFooter, SheetHeader } from '@pulse/ui/components/sheet';
import {
  ariaKeyShortcuts,
  ShortcutHint,
  submitFormFromShortcut,
  useShortcut,
} from '@pulse/ui/components/shortcut-hint';
import { cn } from '@pulse/ui/lib/utils';
import { FormAlert } from '@/components/form-alert';
import { useActionSubmit } from '@/components/org-structure';
import {
  cancelTimeOffAction,
  fileTimeOffAction,
  previewTimeOffAction,
  resendTimeOffAction,
  type TimeOffSubmitResult,
} from '@/lib/actions/talent-time-off';
import { ONBOARDING_HREF } from '@/lib/navigation';
import type { UploadHint } from '@/lib/upload-hints';
import { excludedDaysByReason, requestAmountText } from './format';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Filing a
// leave request", "Insufficient balance", "Filing offset time off", "Screens": the request sheet)
// and docs/DESIGN_SYSTEM.md#layout--components ("Time off on a phone": the request sheet) — the
// request sheet, full height on a phone, in inset grouped sections:
//
// - the segmented control "Leave | Offset" (fixed on "Edit and send again": a returned request
//   keeps its kind), the type (leave), the first and last day as native date inputs with the
//   filing window under them ("File VL by Oct 15 for Oct 29"), "Whole day | First half | Second
//   half" on a single day of a type with half days (offset: "Whole day | Part of the day" with
//   native time inputs in the offset step), the attachment when the type takes one ("Take a photo
//   or choose a file", no `capture` attribute, naming the accepted types and size limit; a medical
//   file is never previewed), and the reason;
// - the summary before Submit, worked out by the server as the values change (no write): the
//   chargeable days or hours, the rest days and holidays left out, the paid and unpaid split with
//   "1 day without pay (deducted from pay)" in `warning-text`, and every problem found so far in
//   the server's words (a missing sex on the record links to My record);
// - the gate's notice above the fields while `reportingTo` isn't set, with Submit disabled.
//
// Submit sends the values with no employee id; a refusal comes back next to its field in the
// server's words. The cancel sheet ("Cancel request") takes an optional reason. Nothing is logged.

const SAVE = ['mod', 's'] as const;
const SUBMIT_FAILED = 'The request wasn’t sent. Check your connection and try again.';
const CANCEL_FAILED = 'The request wasn’t cancelled. Check your connection and try again.';
const PREVIEW_FAILED = 'The summary isn’t available right now. You can still submit.';
const PREVIEW_DELAY_MS = 350;

export type TimeOffSheetMode = { kind: 'file' } | { kind: 'resend'; request: TimeOffRequestView };

type Sheet = OwnTimeOffView['sheet'];

/** The type as the filing rules read it, from the sheet's offer. */
function filingOf(type: TimeOffSheetLeaveType) {
  return {
    name: type.name,
    shortName: type.shortName,
    filing: {
      minNoticeDays: type.minNoticeDays,
      allowFuture: type.allowFuture,
      allowPast: type.allowPast,
    },
  };
}

/** The first day the sheet suggests: VL's notice ahead, SL today, offset tomorrow. */
function suggestedStart(
  kind: TimeOffKind,
  type: TimeOffSheetLeaveType | null,
  today: BusinessDate,
): BusinessDate {
  if (kind === 'offset') return addDays(today, 1);
  if (type?.minNoticeDays) return addDays(today, type.minNoticeDays);
  return today;
}

/** My record's link beside the one problem that offers it: the type needs the record's sex. */
function problemLink(problem: string, type: TimeOffSheetLeaveType | null): string | null {
  if (!type) return null;
  const sexMissing = timeOffProblemMessage({
    kind: 'sexMissing',
    typeName: type.name,
    href: MY_RECORD_HREF,
  });
  return problem === sexMissing ? MY_RECORD_HREF : null;
}

function ProblemLine({ problem, href }: { problem: string; href: string | null }) {
  return (
    <li className="flex items-start gap-2 text-footnote font-medium text-destructive-text">
      <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
      <span>
        {problem}
        {href ? (
          <>
            {' '}
            <Link href={href} className="font-semibold text-accent underline underline-offset-2">
              Open My record
            </Link>
          </>
        ) : null}
      </span>
    </li>
  );
}

/** The summary section: what the request covers, what it leaves out, and its split. */
function Summary({
  kind,
  type,
  preview,
  loading,
  failed,
}: {
  kind: TimeOffKind;
  type: TimeOffSheetLeaveType | null;
  preview: TimeOffPreviewView | null;
  loading: boolean;
  failed: boolean;
}) {
  const unpaid = preview?.unpaidHalfDays ?? 0;
  const excluded = preview ? excludedDaysByReason(preview.days) : [];
  const minutes = preview?.minutes ?? null;
  const halfDays = preview?.chargeableHalfDays ?? null;
  const chargeable =
    kind === 'offset'
      ? minutes === null
        ? null
        : formatOffsetHours(minutes)
      : halfDays === null
        ? null
        : formatDayCount(halfDays);
  return (
    <FormSection title="Summary">
      <div className="flex flex-col gap-2 px-4 py-3" aria-live="polite" aria-busy={loading}>
        {failed ? (
          <p className="text-footnote text-text-secondary">{PREVIEW_FAILED}</p>
        ) : !preview ? (
          <p className="text-footnote text-text-secondary">
            {loading ? 'Working out the days…' : 'Choose the days to see what this request covers.'}
          </p>
        ) : (
          <>
            {chargeable ? (
              <p className="flex items-baseline justify-between gap-3">
                <span className="text-subheadline">
                  {kind === 'offset' ? 'Offset hours used' : 'Days charged'}
                </span>
                <span className="text-headline numeric">{chargeable}</span>
              </p>
            ) : null}
            {excluded.map(([label, dates]) => (
              <p key={label} className="text-footnote text-text-secondary numeric">
                Left out ({label.toLowerCase()}): {dates.map(formatShortDay).join(', ')}
              </p>
            ))}
            {kind === 'leave' && type && preview.chargeableHalfDays ? (
              <p
                className={cn(
                  'flex items-start gap-1.5 text-footnote numeric',
                  unpaid > 0 ? 'font-medium text-warning-text' : 'text-text-secondary',
                )}
              >
                {unpaid > 0 ? (
                  <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
                ) : null}
                <span>
                  {leaveSplitText({
                    type,
                    chargeableHalfDays: preview.chargeableHalfDays,
                    paidHalfDays: preview.paidHalfDays,
                    unpaidHalfDays: preview.unpaidHalfDays,
                  })}
                </span>
              </p>
            ) : null}
            {preview.problems.length > 0 ? (
              <ul className="flex flex-col gap-1.5" aria-label="What stops this request">
                {preview.problems.map((problem) => (
                  <ProblemLine key={problem} problem={problem} href={problemLink(problem, type)} />
                ))}
              </ul>
            ) : loading ? null : (
              <p className="text-footnote text-success-text">Ready to submit.</p>
            )}
          </>
        )}
      </div>
    </FormSection>
  );
}

export function TimeOffRequestForm({
  mode,
  sheet,
  today,
  upload,
  onDone,
}: {
  mode: TimeOffSheetMode;
  sheet: Sheet;
  today: BusinessDate;
  /** The attachment field's accepted types and size limit, from today's upload settings. */
  upload: UploadHint;
  /** Sent. */
  onDone: () => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const original = mode.kind === 'resend' ? mode.request : null;
  const types = sheet.leaveTypes;

  const [kind, setKind] = useState<TimeOffKind>(original?.kind ?? 'leave');
  const [typeKey, setTypeKey] = useState(
    original?.leaveTypeKey ?? (original ? '' : (types[0]?.key ?? '')),
  );
  const initialType = types.find((type) => type.key === typeKey) ?? null;
  const [startDate, setStartDate] = useState<string>(
    original?.startDate ?? suggestedStart(original?.kind ?? 'leave', initialType, today),
  );
  const [endDate, setEndDate] = useState<string>(
    original?.endDate ?? suggestedStart(original?.kind ?? 'leave', initialType, today),
  );
  const [portion, setPortion] = useState<TimeOffPortion>(original?.portion ?? 'whole');
  const [fromTime, setFromTime] = useState(original?.fromTime ?? '');
  const [toTime, setToTime] = useState(original?.toTime ?? '');
  const [reason, setReason] = useState(original?.reason ?? '');
  const [file, setFile] = useState<File | null>(null);
  // The latest summary the server sent, with the values it was worked out for.
  const [previewResult, setPreviewResult] = useState<{
    key: string;
    preview: TimeOffPreviewView | null;
    failed: boolean;
  } | null>(null);
  const [refused, setRefused] = useState<Extract<TimeOffSubmitResult, { kind: 'refused' }> | null>(
    null,
  );
  const [networkError, setNetworkError] = useState<string | null>(null);

  function sent(result: TimeOffSubmitResult) {
    if (result.kind === 'filed') onDone();
    else setRefused(result);
  }
  const filing = useActionSubmit(fileTimeOffAction, sent);
  const resending = useActionSubmit(resendTimeOffAction, sent);
  const save = original ? resending : filing;

  useShortcut(SAVE, () => submitFormFromShortcut(formRef.current), { scope: formRef });

  const type = kind === 'leave' ? (types.find((option) => option.key === typeKey) ?? null) : null;
  const singleDay = startDate !== '' && (endDate === '' || endDate === startDate);
  const keptAttachment = Boolean(original?.canOpenAttachment && type?.attachment);
  const hasAttachment = Boolean(type?.attachment && (file || keptAttachment));

  const portionOptions: { value: TimeOffPortion; label: string }[] =
    kind === 'offset'
      ? singleDay
        ? [
            { value: 'whole', label: 'Whole day' },
            { value: 'part', label: 'Part of the day' },
          ]
        : []
      : singleDay && type?.halfDays
        ? [
            { value: 'whole', label: 'Whole day' },
            { value: 'firstHalf', label: 'First half' },
            { value: 'secondHalf', label: 'Second half' },
          ]
        : [];
  // A portion the days or type no longer allow falls back to the whole day.
  const effectivePortion: TimeOffPortion = portionOptions.some((option) => option.value === portion)
    ? portion
    : 'whole';

  /** The request's fields as the services take them (no employee id). */
  function fieldsOf(): Record<string, string> {
    const fields: Record<string, string> = {
      kind,
      startDate,
      endDate: endDate || startDate,
      portion: effectivePortion,
      reason,
    };
    if (kind === 'leave') fields.leaveTypeKey = typeKey;
    if (kind === 'offset' && effectivePortion === 'part') {
      fields.fromTime = fromTime;
      fields.toTime = toTime;
    }
    return fields;
  }

  // The live summary: the server works it out (no write) a moment after the values settle. The
  // last summary stays shown, marked busy, until the one for the current values arrives; an older
  // answer that comes back late is dropped.
  const previewFields = fieldsOf();
  // The reason changes nothing the summary shows, so typing it asks the server nothing.
  delete previewFields.reason;
  const previewReady =
    previewFields.startDate !== '' && (kind === 'offset' || previewFields.leaveTypeKey !== '');
  const previewKey = JSON.stringify({ ...previewFields, hasAttachment });
  const previewRun = useRef(0);
  useEffect(() => {
    const run = ++previewRun.current;
    if (!previewReady) return;
    const fields = JSON.parse(previewKey) as Record<string, unknown>;
    const timer = setTimeout(async () => {
      let next: { preview: TimeOffPreviewView | null; failed: boolean };
      try {
        const result = await previewTimeOffAction(null, {
          ...fields,
          hasAttachment: fields.hasAttachment ? '1' : '0',
        });
        next = { preview: result.ok ? result.data : null, failed: !result.ok };
      } catch {
        next = { preview: null, failed: true };
      }
      if (run === previewRun.current) setPreviewResult({ key: previewKey, ...next });
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [previewKey, previewReady]);
  const preview = previewReady ? (previewResult?.preview ?? null) : null;
  const previewLoading = previewReady && previewResult?.key !== previewKey;
  const previewFailed = previewReady && !previewLoading && (previewResult?.failed ?? false);

  const errors: Record<string, string | undefined> = { ...save.fieldErrors };
  if (refused?.field) errors[refused.field] = refused.message;
  const formError =
    save.formError ??
    (refused && !refused.field ? refused.message : null) ??
    errors.kind ??
    errors.requestId ??
    networkError;

  function changeKind(next: TimeOffKind) {
    setKind(next);
    setRefused(null);
    save.reset();
    const nextType =
      next === 'leave' ? (types.find((option) => option.key === typeKey) ?? null) : null;
    const start = suggestedStart(next, nextType, today);
    setStartDate(start);
    setEndDate(start);
    setPortion('whole');
  }

  function changeType(nextKey: string) {
    setTypeKey(nextKey);
    setRefused(null);
    if (original) return;
    const nextType = types.find((option) => option.key === nextKey) ?? null;
    const start = suggestedStart('leave', nextType, today);
    setStartDate(start);
    setEndDate(start);
  }

  function changeStart(value: string) {
    setStartDate(value);
    setRefused(null);
    // The last day follows a first day that moves past it.
    if (endDate === '' || endDate < value || endDate === startDate) setEndDate(value);
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0];
    setFile(picked && picked.size > 0 ? picked : null);
    setRefused(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNetworkError(null);
    setRefused(null);
    const data = new FormData();
    for (const [key, value] of Object.entries(fieldsOf())) data.set(key, value);
    if (original) data.set('requestId', original.id);
    if (file && type?.attachment) data.set('attachment', file);
    try {
      const ok = await save.run(data);
      if (!ok) {
        requestAnimationFrame(() => {
          formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
        });
      }
    } catch {
      setNetworkError(SUBMIT_FAILED);
    }
  }

  const windowText = type ? leaveFilingWindowText(filingOf(type), startDate || null) : null;
  const offsetHint = `At least ${formatOffsetHours(sheet.offset.minimumMinutes)}, in ${sheet.offset.stepMinutes}-minute steps, starting after you file it.`;
  const gated = sheet.gateMessage !== null;

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={submit}
      className="flex min-h-0 flex-1 flex-col"
      aria-busy={save.pending || undefined}
    >
      <SheetHeader
        title={original ? 'Edit and send again' : 'File time off'}
        description={original ? `${original.number} · ${timeOffWhenText(original)}` : undefined}
      />
      <SheetBody>
        {sheet.gateMessage ? (
          <p className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-footnote shadow-card">
            <Info aria-hidden="true" className="mt-px size-4 shrink-0 text-warning-text" />
            <span>
              {sheet.gateMessage}{' '}
              <Link
                href={ONBOARDING_HREF}
                className="font-semibold text-accent underline underline-offset-2"
              >
                Open your onboarding checklist
              </Link>
            </span>
          </p>
        ) : null}
        <FormAlert message={formError} />
        {refused ? (
          <Link
            href={refused.href}
            className="self-start text-subheadline font-semibold text-accent underline underline-offset-2"
          >
            Open My record
          </Link>
        ) : null}
        {original?.remarks ? (
          <p className="rounded-card bg-surface px-4 py-3 text-footnote shadow-card">
            <span className="font-semibold">Returned: </span>“{original.remarks}”
          </p>
        ) : null}

        {original ? null : (
          <SegmentedControl
            label="Kind of time off"
            fullWidth
            track="page"
            value={kind}
            onValueChange={changeKind}
            options={[
              { value: 'leave', label: 'Leave' },
              { value: 'offset', label: 'Offset' },
            ]}
          />
        )}

        <FormSection title={kind === 'leave' ? 'Leave' : 'Offset time off'}>
          {kind === 'leave' ? (
            <FormField label="Type" required error={errors.leaveTypeKey}>
              <Select
                name="leaveTypeKey"
                value={typeKey}
                onChange={(event) => changeType(event.target.value)}
              >
                {typeKey === '' || !types.some((option) => option.key === typeKey) ? (
                  <option value={typeKey}>Choose the type</option>
                ) : null}
                {types.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.name} ({option.shortName})
                  </option>
                ))}
              </Select>
            </FormField>
          ) : null}
          <FormField
            label="First day"
            required
            hint={kind === 'leave' ? (windowText ?? undefined) : offsetHint}
            error={errors.startDate}
          >
            <Input
              type="date"
              name="startDate"
              value={startDate}
              onChange={(event) => changeStart(event.target.value)}
              className="numeric sm:max-w-60"
            />
          </FormField>
          <FormField label="Last day" required error={errors.endDate}>
            <Input
              type="date"
              name="endDate"
              value={endDate}
              min={startDate || undefined}
              onChange={(event) => {
                setEndDate(event.target.value);
                setRefused(null);
              }}
              className="numeric sm:max-w-60"
            />
          </FormField>
          {portionOptions.length > 0 ? (
            // Not a FormField: the segmented control names itself (a label would point at nothing).
            <div className="flex flex-col gap-1.5 px-4 py-3">
              <span aria-hidden="true" className="text-subheadline font-medium">
                Part of the day
              </span>
              <SegmentedControl
                label="Part of the day"
                fullWidth
                value={effectivePortion}
                onValueChange={(next) => {
                  setPortion(next);
                  setRefused(null);
                }}
                options={portionOptions}
              />
              <div aria-live="polite">
                {errors.portion ? (
                  <p className="flex items-start gap-1.5 text-footnote font-medium text-destructive-text">
                    <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
                    <span>{errors.portion}</span>
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
          {kind === 'offset' && effectivePortion === 'part' ? (
            <>
              <FormField label="From" required error={errors.fromTime}>
                <Input
                  type="time"
                  name="fromTime"
                  value={fromTime}
                  step={sheet.offset.stepMinutes * 60}
                  onChange={(event) => setFromTime(event.target.value)}
                  className="numeric sm:max-w-40"
                />
              </FormField>
              <FormField label="To" required error={errors.toTime}>
                <Input
                  type="time"
                  name="toTime"
                  value={toTime}
                  step={sheet.offset.stepMinutes * 60}
                  onChange={(event) => setToTime(event.target.value)}
                  className="numeric sm:max-w-40"
                />
              </FormField>
            </>
          ) : null}
        </FormSection>

        {type?.attachment ? (
          <FormSection
            title="Attachment"
            footer="Opened only by you, HR and the System Administrator, and the people who approve this request."
          >
            {keptAttachment && !file ? (
              <div className="flex items-center gap-3 px-4 py-3">
                <FileText
                  aria-hidden="true"
                  className="size-5 shrink-0 text-text-secondary"
                  strokeWidth={1.75}
                />
                <span className="text-subheadline">The file you sent is kept</span>
              </div>
            ) : null}
            <FormField
              label={type.attachment.label}
              required={type.attachment.required && !keptAttachment}
              hint={`Take a photo or choose a file. ${upload.hint}${
                keptAttachment ? ' Leave it empty to keep the file you sent.' : ''
              }`}
              error={errors.attachment}
            >
              {/* No `capture` attribute: a phone offers the camera and the files. */}
              <Input
                type="file"
                name="attachment"
                accept={upload.accept || undefined}
                disabled={!upload.accept}
                onChange={chooseFile}
                className={cn(
                  'h-auto min-h-11 cursor-pointer py-1.5',
                  'file:mr-3 file:h-8 file:cursor-pointer file:rounded-md file:border-0 file:bg-accent-subtle file:px-3 file:text-subheadline file:font-semibold file:text-accent',
                )}
              />
            </FormField>
            {file ? (
              // The file's name only: a medical file is never previewed.
              <div className="flex items-center gap-3 px-4 py-3">
                <FileText
                  aria-hidden="true"
                  className="size-5 shrink-0 text-text-secondary"
                  strokeWidth={1.75}
                />
                <span className="min-w-0 truncate text-subheadline">{file.name}</span>
              </div>
            ) : null}
          </FormSection>
        ) : null}

        <FormSection title="Reason">
          <FormField label="Reason" hint="Optional." error={errors.reason}>
            <Textarea
              name="reason"
              value={reason}
              maxLength={TIME_OFF_REASON_MAX_LENGTH}
              onChange={(event) => setReason(event.target.value)}
            />
          </FormField>
        </FormSection>

        <Summary
          kind={kind}
          type={type}
          preview={preview}
          loading={previewLoading}
          failed={previewFailed}
        />
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="secondary" className="pr-3">
            Cancel
            <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
          </Button>
        </SheetClose>
        <Button
          type="submit"
          loading={save.pending}
          disabled={gated}
          aria-keyshortcuts={ariaKeyShortcuts(SAVE)}
          className="pr-3"
        >
          {original ? 'Send again' : 'Submit'}
          <ShortcutHint keys={SAVE} tone="on-fill" className="hidden sm:inline-flex" />
        </Button>
      </SheetFooter>
    </form>
  );
}

/**
 * "Cancel request": a returned request (it won't be sent again), or an approved one before its
 * first day (its paid days or hours come back, and its approvers are told). Final.
 */
export function CancelRequestForm({
  request,
  onDone,
}: {
  request: TimeOffRequestView;
  onDone: () => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [reason, setReason] = useState('');
  const [networkError, setNetworkError] = useState<string | null>(null);
  const cancel = useActionSubmit(cancelTimeOffAction, onDone);
  const approved = request.status === 'approved';
  const amount = requestAmountText(request);
  const giveBack =
    request.kind === 'offset'
      ? amount
        ? `${amount} come back to your offset balance`
        : 'The offset hours come back to your balance'
      : request.paidHalfDays && request.typeLabel
        ? `${formatDayCount(request.paidHalfDays)} come back to your ${request.typeLabel} balance`
        : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNetworkError(null);
    try {
      await cancel.run({ requestId: request.id, reason });
    } catch {
      setNetworkError(CANCEL_FAILED);
    }
  }

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={submit}
      className="flex min-h-0 flex-1 flex-col"
      aria-busy={cancel.pending || undefined}
    >
      <SheetHeader
        title="Cancel this request?"
        description={`${request.number} · ${timeOffWhenText(request)}`}
      />
      <SheetBody>
        <FormAlert message={cancel.formError ?? cancel.fieldErrors.requestId ?? networkError} />
        <p className="px-1 text-subheadline">
          {approved
            ? `${giveBack ? `${giveBack}, and the` : 'The'} people who approved it are told. This can’t be undone.`
            : 'It won’t be sent again. This can’t be undone.'}
        </p>
        <FormSection title="Reason">
          <FormField label="Reason" hint="Optional." error={cancel.fieldErrors.reason}>
            <Textarea
              name="reason"
              value={reason}
              maxLength={TIME_OFF_CANCEL_REASON_MAX_LENGTH}
              onChange={(event) => setReason(event.target.value)}
            />
          </FormField>
        </FormSection>
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="secondary">Keep request</Button>
        </SheetClose>
        <Button type="submit" variant="destructive" loading={cancel.pending}>
          <XCircle aria-hidden="true" className="size-4" />
          Cancel request
        </Button>
      </SheetFooter>
    </form>
  );
}
