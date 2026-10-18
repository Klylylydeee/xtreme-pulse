'use client';

import { useRef, useState } from 'react';
import { ChevronRight, CircleAlert, Lock, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { type BusinessDate, type FieldErrors, formatDate, isBusinessDate } from '@pulse/core';
import {
  LEAVE_BALANCE_KIND_LABELS,
  LEAVE_BALANCE_KINDS,
  LEAVE_COUNT_DAYS,
  LEAVE_COUNT_DAYS_LABELS,
  LEAVE_ELIGIBLE_STATUSES,
  LEAVE_MIN_NOTICE_DAYS_MAX,
  LEAVE_MIN_SERVICE_MONTHS_MAX,
  LEAVE_TYPE_DAYS_MAX,
  type LeaveBalanceKind,
  type LeaveCountDays,
  type LeaveEligibleStatus,
  type LeaveSettings,
  type LeaveType,
  OFFSET_TIME_OFF_MINUTES_MAX,
  OFFSET_TIME_OFF_MINUTES_MIN,
  PAYROLL_SOURCE_MAX_LENGTH,
  type Sex,
  SEX_LABELS,
  SEXES,
} from '@pulse/talent';
import type { LeaveSettingsView } from '@pulse/talent/server';
import { cn } from '@pulse/ui';
import { Button } from '@pulse/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pulse/ui/components/dialog';
import { FormField, FormSection, Input, Select, Switch } from '@pulse/ui/components/form';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { SheetBody, SheetClose, SheetFooter, SheetHeader } from '@pulse/ui/components/sheet';
import {
  ariaKeyShortcuts,
  ShortcutHint,
  submitFormFromShortcut,
  useShortcut,
} from '@pulse/ui/components/shortcut-hint';
import { FormAlert } from '@/components/form-alert';
import { useActionSubmit } from '@/components/org-structure';
import { addLeaveSettingsVersionAction } from '@/lib/actions/talent-payroll';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Leave
// settings"; decisions 300 and 306 in docs/BUILD_PLAN.md) — "Add version" on Payroll settings ›
// Leave, for a Talent Owner who is HR or the System Administrator (the segment shows it only
// then; the action and the service check again).
//
// - Filled in with the latest version, so every type key is there: a type already stored keeps
//   its key and can't be removed, only retired (Active off). A new type can be added and removed
//   before saving.
// - The go-live date can be set or changed until an opening balance exists; after that it is
//   shown locked and sent unchanged (the service refuses a change anyway).
// - Whole numbers are sent as numbers (text that isn't digits stays text, so the schema names the
//   field); days as text, "2.5" for two and a half days, as the setting stores them; a blank
//   optional figure means none. A type's crediting rules are sent only for a credited type.
// - Saving (the button, or ⌘S / Ctrl+S) asks for confirmation first, since a version can't be
//   changed or withdrawn. Errors come back under `value.<path>` and show on their field; a type
//   with an error opens. Nothing here is logged.

const SAVE = ['mod', 's'] as const;
const SAVE_FAILED = 'The version wasn’t added. Check your connection and try again.';
const CONFIRMATION =
  'Versions can’t be changed or withdrawn once added. Check every leave type and figure.';

type AttachmentChoice = 'none' | 'optional' | 'required';

/** One leave type as typed in the sheet. */
interface LeaveTypeDraft {
  key: string;
  name: string;
  shortName: string;
  active: boolean;
  paid: boolean;
  balance: LeaveBalanceKind;
  days: string;
  countDays: LeaveCountDays;
  halfDays: boolean;
  annualCreditOn: string;
  prorateFromRegularization: boolean;
  /** '' for no cap. */
  carryOverCapDays: string;
  employmentStatuses: LeaveEligibleStatus[];
  sex: Sex | '';
  minServiceMonths: string;
  maxRequests: string;
  minNoticeDays: string;
  allowFuture: boolean;
  allowPast: boolean;
  attachment: AttachmentChoice;
  attachmentLabel: string;
  confidential: boolean;
  legalBasis: string;
}

interface LeaveDraft {
  goLiveDate: string;
  minimumMinutes: string;
  stepMinutes: string;
  types: LeaveTypeDraft[];
}

const text = (value: number | null | undefined) =>
  value === null || value === undefined ? '' : String(value);

function typeDraft(type: LeaveType): LeaveTypeDraft {
  return {
    key: type.key,
    name: type.name,
    shortName: type.shortName,
    active: type.active,
    paid: type.paid,
    balance: type.balance,
    days: type.days,
    countDays: type.countDays,
    halfDays: type.halfDays,
    annualCreditOn: type.crediting?.annualCreditOn ?? '01-01',
    prorateFromRegularization: type.crediting?.prorateFromRegularization ?? true,
    carryOverCapDays: type.crediting?.carryOverCapDays ?? '',
    employmentStatuses: [...type.eligibility.employmentStatuses],
    sex: type.eligibility.sex ?? '',
    minServiceMonths: text(type.eligibility.minServiceMonths),
    maxRequests: text(type.eligibility.maxRequests),
    minNoticeDays: text(type.filing.minNoticeDays),
    allowFuture: type.filing.allowFuture,
    allowPast: type.filing.allowPast,
    attachment: type.attachment ? (type.attachment.required ? 'required' : 'optional') : 'none',
    attachmentLabel: type.attachment?.label ?? '',
    confidential: type.confidential,
    legalBasis: type.legalBasis ?? '',
  };
}

function newTypeDraft(): LeaveTypeDraft {
  return {
    key: '',
    name: '',
    shortName: '',
    active: true,
    paid: true,
    balance: 'perEvent',
    days: '',
    countDays: 'workDays',
    halfDays: false,
    annualCreditOn: '01-01',
    prorateFromRegularization: true,
    carryOverCapDays: '',
    employmentStatuses: [...LEAVE_ELIGIBLE_STATUSES],
    sex: '',
    minServiceMonths: '',
    maxRequests: '',
    minNoticeDays: '',
    allowFuture: true,
    allowPast: true,
    attachment: 'none',
    attachmentLabel: '',
    confidential: false,
    legalBasis: '',
  };
}

function toDraft(value: LeaveSettings | null): LeaveDraft {
  return {
    goLiveDate: value?.goLiveDate ?? '',
    minimumMinutes: text(value?.offsetTimeOff.minimumMinutes ?? 60),
    stepMinutes: text(value?.offsetTimeOff.stepMinutes ?? 30),
    types: value ? value.types.map(typeDraft) : [],
  };
}

/** A whole number typed as digits, as a number; blank as `blank`; anything else left as text. */
function wholeNumber(value: string, blank: null | undefined): number | string | null | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return blank;
  return /^\d{1,6}$/.test(trimmed) ? Number(trimmed) : trimmed;
}

/** The draft as the setting's value (the action and the service parse it). */
function draftToValue(draft: LeaveDraft) {
  return {
    goLiveDate: draft.goLiveDate.trim() === '' ? null : draft.goLiveDate,
    offsetTimeOff: {
      minimumMinutes: wholeNumber(draft.minimumMinutes, undefined),
      stepMinutes: wholeNumber(draft.stepMinutes, undefined),
    },
    types: draft.types.map((type) => ({
      key: type.key,
      name: type.name,
      shortName: type.shortName,
      active: type.active,
      paid: type.paid,
      balance: type.balance,
      days: type.days,
      countDays: type.countDays,
      halfDays: type.halfDays,
      crediting:
        type.balance === 'credited'
          ? {
              annualCreditOn: type.annualCreditOn,
              prorateFromRegularization: type.prorateFromRegularization,
              carryOverCapDays: type.carryOverCapDays.trim() === '' ? null : type.carryOverCapDays,
            }
          : null,
      eligibility: {
        employmentStatuses: LEAVE_ELIGIBLE_STATUSES.filter((status) =>
          type.employmentStatuses.includes(status),
        ),
        sex: type.sex === '' ? null : type.sex,
        minServiceMonths: wholeNumber(type.minServiceMonths, null),
        maxRequests: wholeNumber(type.maxRequests, null),
      },
      filing: {
        minNoticeDays: wholeNumber(type.minNoticeDays, null),
        allowFuture: type.allowFuture,
        allowPast: type.allowPast,
      },
      attachment:
        type.attachment === 'none'
          ? null
          : { label: type.attachmentLabel, required: type.attachment === 'required' },
      confidential: type.confidential,
      legalBasis: type.legalBasis,
    })),
  };
}

export interface AddedLeaveVersion {
  id: string;
  effectiveFrom: BusinessDate;
}

/** A labelled text input in a FormSection. */
function TextField({
  label,
  value,
  onChange,
  error,
  hint,
  numeric = false,
  required = true,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  numeric?: boolean;
  required?: boolean;
  maxLength?: number;
}) {
  return (
    <FormField label={label} required={required} error={error} hint={hint}>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode={numeric ? 'decimal' : undefined}
        autoComplete="off"
        spellCheck={false}
        required={required}
        maxLength={maxLength}
        className={cn(numeric && 'numeric sm:max-w-40')}
      />
    </FormField>
  );
}

function SwitchField({
  label,
  checked,
  onChange,
  error,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  error?: string;
  hint?: string;
}) {
  return (
    <FormField label={label} layout="inline" error={error} hint={hint}>
      <Switch checked={checked} onCheckedChange={onChange} />
    </FormField>
  );
}

/** One leave type's fields, in a collapsible block. */
function LeaveTypeFields({
  type,
  index,
  locked,
  open,
  onToggle,
  onChange,
  onRemove,
  errors,
}: {
  type: LeaveTypeDraft;
  index: number;
  locked: boolean;
  open: boolean;
  onToggle: (open: boolean) => void;
  onChange: (type: LeaveTypeDraft) => void;
  onRemove: () => void;
  errors: FieldErrors;
}) {
  const prefix = `value.types.${index}`;
  const e = (path: string) => errors[`${prefix}.${path}`];
  const errorCount = Object.keys(errors).filter(
    (key) => key === prefix || key.startsWith(`${prefix}.`),
  ).length;
  const set = <K extends keyof LeaveTypeDraft>(field: K, value: LeaveTypeDraft[K]) =>
    onChange({ ...type, [field]: value });
  const title = type.name.trim() || 'New leave type';

  return (
    <details
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
      className="group overflow-hidden rounded-card bg-surface shadow-card"
    >
      <summary
        className={cn(
          'flex min-h-11 cursor-pointer list-none items-center gap-3 px-4 py-2.5 [&::-webkit-details-marker]:hidden',
          'transition-colors duration-fast hover:bg-accent-subtle focus-visible:outline-offset-[-2px]',
        )}
      >
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 text-text-secondary transition-transform duration-fast group-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-subheadline font-semibold break-words">{title}</span>
          {type.shortName.trim() ? (
            <span className="text-footnote text-text-secondary">({type.shortName.trim()})</span>
          ) : null}
          {type.active ? null : (
            <span className="text-footnote text-text-secondary">· Retired</span>
          )}
        </span>
        {errorCount > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-footnote font-medium text-destructive-text">
            <CircleAlert aria-hidden="true" className="size-4" />
            {errorCount === 1 ? '1 error' : `${errorCount} errors`}
          </span>
        ) : null}
      </summary>
      <div className="flex flex-col gap-5 border-t border-separator bg-bg-grouped px-3 py-4 sm:px-4">
        <FormSection title="Type">
          {locked ? (
            <div className="flex flex-col gap-0.5 px-4 py-3">
              <span className="text-subheadline font-medium text-text-primary">Key</span>
              <span className="font-mono text-subheadline">{type.key}</span>
              <span className="text-footnote text-text-secondary">
                Fixed once added. Retire a type you no longer use.
              </span>
            </div>
          ) : (
            <TextField
              label="Key"
              value={type.key}
              onChange={(value) => set('key', value)}
              error={e('key')}
              hint="Letters and digits, starting with a lowercase letter, like bereavement. Fixed once added."
            />
          )}
          <TextField
            label="Name"
            value={type.name}
            onChange={(value) => set('name', value)}
            error={e('name')}
            maxLength={100}
          />
          <TextField
            label="Short name"
            value={type.shortName}
            onChange={(value) => set('shortName', value)}
            error={e('shortName')}
            hint="Up to 10 characters, like VL. Shown on the DTR and the balance cards."
            maxLength={10}
          />
          <SwitchField
            label="Active"
            checked={type.active}
            onChange={(checked) => set('active', checked)}
            error={e('active')}
            hint="A retired type can’t be filed. Past requests keep it."
          />
          <SwitchField
            label="Paid"
            checked={type.paid}
            onChange={(checked) => set('paid', checked)}
            error={e('paid')}
            hint="An unpaid type’s days show on the DTR as leave without pay."
          />
          <SwitchField
            label="Confidential"
            checked={type.confidential}
            onChange={(checked) => set('confidential', checked)}
            error={e('confidential')}
            hint="Goes to HR only, and shows as “Leave” to everyone but the employee, HR and the System Administrator."
          />
          <TextField
            label="Legal basis"
            value={type.legalBasis}
            onChange={(value) => set('legalBasis', value)}
            error={e('legalBasis')}
            hint="Optional, like RA 11210."
            required={false}
            maxLength={200}
          />
        </FormSection>

        <FormSection title="Limit and counting">
          <FormField label="How the limit works" required error={e('balance')}>
            <Select
              value={type.balance}
              onChange={(event) => set('balance', event.target.value as LeaveBalanceKind)}
            >
              {LEAVE_BALANCE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {LEAVE_BALANCE_KIND_LABELS[kind]}
                </option>
              ))}
            </Select>
          </FormField>
          <TextField
            label={
              type.balance === 'credited'
                ? 'Days credited a year'
                : type.balance === 'perEvent'
                  ? 'Most days per request'
                  : 'Most days per calendar year'
            }
            value={type.days}
            onChange={(value) => set('days', value)}
            error={e('days')}
            hint={`Whole or half days, like 5 or 2.5, up to ${LEAVE_TYPE_DAYS_MAX}.`}
            numeric
          />
          <FormField label="Days that count" required error={e('countDays')}>
            <Select
              value={type.countDays}
              onChange={(event) => set('countDays', event.target.value as LeaveCountDays)}
            >
              {LEAVE_COUNT_DAYS.map((count) => (
                <option key={count} value={count}>
                  {LEAVE_COUNT_DAYS_LABELS[count]}
                </option>
              ))}
            </Select>
          </FormField>
          <SwitchField
            label="Half days allowed"
            checked={type.halfDays}
            onChange={(checked) => set('halfDays', checked)}
            error={e('halfDays')}
          />
        </FormSection>

        {type.balance === 'credited' ? (
          <FormSection
            title="Crediting"
            footer="Credits start on the regularization date, then come every year on the credit day."
          >
            <TextField
              label="Annual credit day"
              value={type.annualCreditOn}
              onChange={(value) => set('annualCreditOn', value)}
              error={e('crediting.annualCreditOn') ?? e('crediting')}
              hint="Month and day, MM-DD, like 01-01."
              numeric
            />
            <SwitchField
              label="Prorate from the regularization date"
              checked={type.prorateFromRegularization}
              onChange={(checked) => set('prorateFromRegularization', checked)}
              error={e('crediting.prorateFromRegularization')}
            />
            <TextField
              label="Carry-over cap"
              value={type.carryOverCapDays}
              onChange={(value) => set('carryOverCapDays', value)}
              error={e('crediting.carryOverCapDays')}
              hint="Days, like 5 or 2.5. Leave blank for no cap."
              numeric
              required={false}
            />
          </FormSection>
        ) : null}

        <FormSection title="Who may file">
          <FormField
            label="Employment status"
            required
            error={e('eligibility.employmentStatuses')}
            hint="Statutory leaves follow the law, not the probation rule."
          >
            <div
              role="group"
              aria-label="Employment status"
              className="flex flex-wrap gap-x-5 gap-y-1"
            >
              {LEAVE_ELIGIBLE_STATUSES.map((status) => (
                <label
                  key={status}
                  className="inline-flex min-h-11 items-center gap-2 text-subheadline"
                >
                  <input
                    type="checkbox"
                    checked={type.employmentStatuses.includes(status)}
                    onChange={(event) =>
                      set(
                        'employmentStatuses',
                        event.target.checked
                          ? [...type.employmentStatuses, status]
                          : type.employmentStatuses.filter((item) => item !== status),
                      )
                    }
                    className="size-5 shrink-0 cursor-pointer accent-accent"
                  />
                  {status}
                </label>
              ))}
            </div>
          </FormField>
          <FormField label="Sex" error={e('eligibility.sex')}>
            <Select value={type.sex} onChange={(event) => set('sex', event.target.value as Sex)}>
              <option value="">Anyone</option>
              {SEXES.map((sex) => (
                <option key={sex} value={sex}>
                  {SEX_LABELS[sex]} only
                </option>
              ))}
            </Select>
          </FormField>
          <TextField
            label="Months since hired"
            value={type.minServiceMonths}
            onChange={(value) => set('minServiceMonths', value)}
            error={e('eligibility.minServiceMonths')}
            hint={`A whole number from 1 to ${LEAVE_MIN_SERVICE_MONTHS_MAX}. Leave blank for none.`}
            numeric
            required={false}
          />
          <TextField
            label="Most approved requests ever"
            value={type.maxRequests}
            onChange={(value) => set('maxRequests', value)}
            error={e('eligibility.maxRequests')}
            hint="A whole number, like 4 for paternity leave. Leave blank for no limit."
            numeric
            required={false}
          />
        </FormSection>

        <FormSection title="Filing">
          <SwitchField
            label="May be filed ahead"
            checked={type.allowFuture}
            onChange={(checked) => set('allowFuture', checked)}
            error={e('filing.allowFuture') ?? e('filing')}
          />
          {type.allowFuture ? (
            <TextField
              label="Days of notice"
              value={type.minNoticeDays}
              onChange={(value) => set('minNoticeDays', value)}
              error={e('filing.minNoticeDays')}
              hint={`Days between filing and the first day, from 0 to ${LEAVE_MIN_NOTICE_DAYS_MAX}. Leave blank for none.`}
              numeric
              required={false}
            />
          ) : null}
          <SwitchField
            label="May be filed after the day"
            checked={type.allowPast}
            onChange={(checked) => set('allowPast', checked)}
            error={e('filing.allowPast')}
            hint="Up to the timesheet deadline of the cut-off holding the first day."
          />
        </FormSection>

        <FormSection title="Attachment">
          <FormField label="Attachment" required error={e('attachment')}>
            <Select
              value={type.attachment}
              onChange={(event) => set('attachment', event.target.value as AttachmentChoice)}
            >
              <option value="none">None</option>
              <option value="optional">Optional</option>
              <option value="required">Required</option>
            </Select>
          </FormField>
          {type.attachment !== 'none' ? (
            <TextField
              label="What to attach"
              value={type.attachmentLabel}
              onChange={(value) => set('attachmentLabel', value)}
              error={e('attachment.label')}
              hint="Like Medical certificate. Attachments open only for the employee, HR, the System Administrator and the approvers."
              maxLength={100}
            />
          ) : null}
        </FormSection>

        {locked ? null : (
          <div className="px-1">
            <Button
              variant="plain"
              onClick={onRemove}
              className="text-destructive-text hover:bg-surface hover:text-destructive-text"
            >
              <Trash2 aria-hidden="true" className="size-4.5" />
              Remove this type
            </Button>
          </div>
        )}
      </div>
    </details>
  );
}

export function LeaveVersionSheet({
  view,
  onSaved,
}: {
  view: LeaveSettingsView;
  onSaved: (version: AddedLeaveVersion) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const latest = view.history[0] ?? null;
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [source, setSource] = useState('');
  const [draft, setDraft] = useState<LeaveDraft>(() => toDraft(latest?.value ?? null));
  const [lockedCount] = useState(() => latest?.value.types.length ?? 0);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const save = useActionSubmit(addLeaveSettingsVersionAction, onSaved);
  const errors = save.fieldErrors;
  const valueErrors = Object.keys(errors).filter((key) => key.startsWith('value.')).length;
  const goLiveLocked = view.goLiveDateLocked;

  useShortcut(SAVE, () => submitFormFromShortcut(formRef.current), {
    scope: formRef,
    enabled: !confirming,
  });

  function setType(index: number, type: LeaveTypeDraft) {
    setDraft((previous) => ({
      ...previous,
      types: previous.types.map((item, i) => (i === index ? type : item)),
    }));
  }

  function toggle(index: number, open: boolean) {
    setExpanded((previous) => {
      if (previous.has(index) === open) return previous;
      const next = new Set(previous);
      if (open) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  async function confirm() {
    setNetworkError(null);
    try {
      const ok = await save.run({
        effectiveFrom,
        source,
        value: draftToValue(draft),
      });
      if (!ok) {
        setConfirming(false);
        // A type with an error opens on the next render (`typesInError`); then focus the field.
        requestAnimationFrame(() => {
          formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
        });
      }
    } catch {
      setConfirming(false);
      setNetworkError(SAVE_FAILED);
    }
  }

  // After a refused save the errors arrive with the next render; types with an error stay open.
  const typesInError = new Set(
    Object.keys(errors).flatMap((key) => {
      const match = /^value\.types\.(\d+)/.exec(key);
      return match ? [Number(match[1])] : [];
    }),
  );

  const dateHint = view.earliestEffectiveFrom
    ? `From ${formatDate(view.earliestEffectiveFrom)}, the day after the latest version, to ${formatDate(view.latestEffectiveFrom)}. The version in effect on a day sets that day’s rules.`
    : `Up to ${formatDate(view.latestEffectiveFrom)}.`;

  return (
    <>
      <form
        ref={formRef}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setConfirming(true);
        }}
        className="flex min-h-0 flex-1 flex-col"
        aria-busy={save.pending || undefined}
      >
        <SheetHeader
          title="Add version: Leave"
          description={
            latest
              ? `Filled in with the version from ${formatDate(latest.effectiveFrom)}. Change what the new policy changes.`
              : 'Enter the leave types and the go-live date.'
          }
        />
        <SheetBody>
          <FormAlert message={save.formError ?? networkError ?? errors.value} />
          {valueErrors > 0 ? (
            <p
              role="status"
              className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-footnote font-medium text-destructive-text shadow-card"
            >
              <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
              <span>
                {valueErrors === 1
                  ? 'One field needs checking. It’s marked below.'
                  : `${valueErrors} fields need checking. They’re marked below.`}
              </span>
            </p>
          ) : null}
          <FormSection
            title="Version"
            footer="Versions can’t be changed or withdrawn. A wrong version is replaced by a newer one from its own date."
          >
            <FormField label="Effective date" required hint={dateHint} error={errors.effectiveFrom}>
              <Input
                type="date"
                name="effectiveFrom"
                value={effectiveFrom}
                onChange={(event) => setEffectiveFrom(event.target.value)}
                min={view.earliestEffectiveFrom ?? undefined}
                max={view.latestEffectiveFrom}
                required
                className="numeric sm:max-w-56"
              />
            </FormField>
            <FormField
              label="Source"
              required
              hint={
                latest?.source
                  ? `The policy or memo behind the change. The latest version cites: ${latest.source}`
                  : 'The policy or memo behind the change. For example: HR memo on leave, November 2026.'
              }
              error={errors.source}
            >
              <Input
                name="source"
                value={source}
                onChange={(event) => setSource(event.target.value)}
                maxLength={PAYROLL_SOURCE_MAX_LENGTH}
                autoComplete="off"
                required
              />
            </FormField>
          </FormSection>

          <FormSection
            title="Go-live"
            footer="Leave is credited from the go-live date, and HR enters each existing employee’s opening balances as of it."
          >
            {goLiveLocked ? (
              <div className="flex flex-col gap-0.5 px-4 py-3">
                <span className="text-subheadline font-medium text-text-primary">Go-live date</span>
                <span className="numeric text-subheadline">
                  {draft.goLiveDate ? formatDate(draft.goLiveDate) : 'Not set'}
                </span>
                <span className="flex items-start gap-1.5 text-footnote text-text-secondary">
                  <Lock aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                  Opening balances have been entered, so it can’t change.
                </span>
                {errors['value.goLiveDate'] ? (
                  <span className="text-footnote font-medium text-destructive-text">
                    {errors['value.goLiveDate']}
                  </span>
                ) : null}
              </div>
            ) : (
              <FormField
                label="Go-live date"
                hint="The day Pulse Talent goes live. Leave blank until it’s decided. It can’t change once an opening balance is entered."
                error={errors['value.goLiveDate']}
              >
                <Input
                  type="date"
                  value={draft.goLiveDate}
                  onChange={(event) =>
                    setDraft((previous) => ({ ...previous, goLiveDate: event.target.value }))
                  }
                  className="numeric sm:max-w-56"
                />
              </FormField>
            )}
          </FormSection>

          <FormSection title="Offset time off">
            <TextField
              label="Minimum, in minutes"
              value={draft.minimumMinutes}
              onChange={(value) => setDraft((previous) => ({ ...previous, minimumMinutes: value }))}
              error={errors['value.offsetTimeOff.minimumMinutes']}
              hint={`A whole number from ${OFFSET_TIME_OFF_MINUTES_MIN} to ${OFFSET_TIME_OFF_MINUTES_MAX}, like 60 for 1 hour.`}
              numeric
            />
            <TextField
              label="Step, in minutes"
              value={draft.stepMinutes}
              onChange={(value) => setDraft((previous) => ({ ...previous, stepMinutes: value }))}
              error={errors['value.offsetTimeOff.stepMinutes']}
              hint={`A whole number from ${OFFSET_TIME_OFF_MINUTES_MIN} to ${OFFSET_TIME_OFF_MINUTES_MAX}, like 30. A request’s minutes are a multiple of it.`}
              numeric
            />
          </FormSection>

          <div className="flex flex-col gap-2">
            <h3 className="px-4 text-footnote font-semibold text-text-secondary">Leave types</h3>
            <p className="px-4 text-footnote text-text-secondary">
              A type’s key never changes and a type is never removed: turn Active off to retire one.
              A request keeps the rules in effect when it was filed.
            </p>
            {draft.types.map((type, index) => (
              <LeaveTypeFields
                key={index}
                type={type}
                index={index}
                locked={index < lockedCount}
                open={expanded.has(index) || typesInError.has(index)}
                onToggle={(open) => toggle(index, open)}
                onChange={(next) => setType(index, next)}
                onRemove={() => {
                  setDraft((previous) => ({
                    ...previous,
                    types: previous.types.filter((_, i) => i !== index),
                  }));
                  setExpanded(new Set());
                }}
                errors={errors}
              />
            ))}
            <div className="px-1">
              <Button
                variant="tinted"
                onClick={() => {
                  setDraft((previous) => ({
                    ...previous,
                    types: [...previous.types, newTypeDraft()],
                  }));
                  setExpanded((previous) => new Set(previous).add(draft.types.length));
                }}
              >
                <Plus aria-hidden="true" className="size-4.5" />
                Add leave type
              </Button>
            </div>
          </div>
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
            aria-keyshortcuts={ariaKeyShortcuts(SAVE)}
            className="pr-3"
          >
            Add version
            <ShortcutHint keys={SAVE} tone="on-fill" className="hidden sm:inline-flex" />
          </Button>
        </SheetFooter>
      </form>

      {/* Outside the form: React events bubble through portals. */}
      <Dialog
        open={confirming}
        onOpenChange={(next) => {
          if (!next && !save.pending) setConfirming(false);
        }}
      >
        <DialogContent
          onEscapeKeyDown={(event) => {
            if (save.pending) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (save.pending) event.preventDefault();
          }}
          className={[
            'top-1/2 left-1/2 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-5',
            'rounded-panel bg-surface p-6 text-text-primary shadow-float',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          ].join(' ')}
        >
          <div className="flex items-start gap-4">
            <IconTile className="size-11 shrink-0 rounded-xl [&_svg]:size-5">
              <ShieldAlert strokeWidth={1.75} />
            </IconTile>
            <div className="flex min-w-0 flex-col gap-1.5">
              <DialogTitle>
                Add Leave
                {isBusinessDate(effectiveFrom) ? ` from ${formatDate(effectiveFrom)}` : ''}?
              </DialogTitle>
              <DialogDescription>{CONFIRMATION}</DialogDescription>
            </div>
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              onClick={() => setConfirming(false)}
              disabled={save.pending}
              autoFocus
              className="gap-2.5"
            >
              Check again
              <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
            </Button>
            <Button loading={save.pending} onClick={() => void confirm()}>
              Add version
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
