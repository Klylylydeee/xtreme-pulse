'use client';

import { type FormEvent, useRef, useState } from 'react';
import { CircleAlert, Save, Trash2 } from 'lucide-react';
import { centavosToDecimalString } from '@pulse/core';
import {
  PAYROLL_AUTHORIZED_IN_WRITING_LABEL,
  PAYROLL_MANUAL_ENTRY_KIND_LABELS,
  PAYROLL_MANUAL_LABEL_MAX_LENGTH,
  PAYROLL_MANUAL_REASON_HINT,
  PAYROLL_MANUAL_REASON_MAX_LENGTH,
  type PayrollManualEntryKind,
} from '@pulse/talent';
import type { PayrollBreakdownManualEntry, PayrollOverrideTarget } from '@pulse/talent/server';
import { Button } from '@pulse/ui/components/button';
import { FormField, FormSection, Input, Select, Switch, Textarea } from '@pulse/ui/components/form';
import { SegmentedControl } from '@pulse/ui/components/segmented-control';
import { SheetBody, SheetFooter, SheetHeader } from '@pulse/ui/components/sheet';
import { FormAlert } from '@/components/form-alert';
import { useActionSubmit } from '@/components/org-structure';
import {
  addPayrollManualEntryAction,
  editPayrollManualEntryAction,
  removePayrollManualEntryAction,
} from '@/lib/actions/talent-payroll-runs';
import { pesoText } from './payroll-format';

// Spec: docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 ("Manual
// entries", "Screens": the manual entry sheet) and docs/DESIGN_SYSTEM.md#layout--components
// ("Payroll review and payslips on a phone": full height on a phone, inset grouped sections) —
// "Add manual entry", "Edit" and "Remove" on one person's line, for the server's
// `canEnterManualEntries` on an editable run.
//
// - The segmented control "Earning | Deduction | Override" (fixed when editing: the kind and the
//   line an override replaces can't change), then the kind's fields: the label (printed on the
//   payslip), the amount typed in pesos (`inputmode="decimal"`), the switches (Taxable, Counts as
//   basic salary, Reduces taxable pay, and for a deduction after tax "Authorized in writing by the
//   employee or required by law"), or the line to override with the amount it replaces; then the
//   reason with "Don't type amounts in the reason.", and Save.
// - The amount goes to the server as typed; the server converts it to whole centavos (no floating
//   point here). Refusals show next to their field, or above the form, in the server's words.
// - Each save recomputes the run on the server; the caller reloads the page and the breakdown.

const SAVE_FAILED = 'The entry wasn’t saved. Check your connection and try again.';
const REMOVE_FAILED = 'The entry wasn’t removed. Check your connection and try again.';

const KIND_OPTIONS = (['earning', 'deduction', 'override'] as const).map((value) => ({
  value,
  label: PAYROLL_MANUAL_ENTRY_KIND_LABELS[value],
}));

/** One switch row in an inset section. */
function SwitchField({
  label,
  hint,
  error,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  error?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <FormField label={label} hint={hint} error={error} layout="inline">
      <Switch checked={checked} onCheckedChange={onChange} />
    </FormField>
  );
}

export interface ManualEntrySheetProps {
  runId: string;
  employeeId: string;
  /** The person's name, for the sheet's description. */
  name: string;
  /** The entry being edited (the latest of its chain), or null to add one. */
  entry: PayrollBreakdownManualEntry | null;
  overrideTargets: PayrollOverrideTarget[];
  onSaved: () => void;
  /** "Cancel": back to the breakdown. */
  onCancel: () => void;
}

/** "Add manual entry" or "Edit": the sheet's content. */
export function ManualEntrySheet({
  runId,
  employeeId,
  name,
  entry,
  overrideTargets,
  onSaved,
  onCancel,
}: ManualEntrySheetProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const editing = entry !== null;
  const [kind, setKind] = useState<PayrollManualEntryKind>(entry?.kind ?? 'earning');
  const [label, setLabel] = useState(entry && entry.kind !== 'override' ? entry.label : '');
  const [amount, setAmount] = useState(
    entry?.amountCentavos !== null && entry?.amountCentavos !== undefined
      ? centavosToDecimalString(entry.amountCentavos)
      : '',
  );
  const [taxable, setTaxable] = useState(entry?.taxable ?? true);
  const [countsAsBasicSalary, setCountsAsBasicSalary] = useState(
    entry?.countsAsBasicSalary ?? false,
  );
  const [reducesTaxablePay, setReducesTaxablePay] = useState(entry?.reducesTaxablePay ?? false);
  const [authorizedInWriting, setAuthorizedInWriting] = useState(
    entry?.authorizedInWriting ?? false,
  );
  const [targetLineKey, setTargetLineKey] = useState(
    entry?.targetLineKey ??
      overrideTargets.find((target) => !target.overridden)?.key ??
      overrideTargets[0]?.key ??
      '',
  );
  const [reason, setReason] = useState('');
  const [networkError, setNetworkError] = useState<string | null>(null);

  const add = useActionSubmit(addPayrollManualEntryAction, onSaved);
  const edit = useActionSubmit(editPayrollManualEntryAction, onSaved);
  const save = editing ? edit : add;
  const errors = save.fieldErrors;
  const amountError = errors.amount ?? errors.amountCentavos;
  const target = overrideTargets.find((candidate) => candidate.key === targetLineKey) ?? null;

  function changeKind(next: PayrollManualEntryKind) {
    setKind(next);
    save.reset();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNetworkError(null);
    const values: Record<string, unknown> = { runId, kind, amount, reason };
    if (kind === 'earning') Object.assign(values, { label, taxable, countsAsBasicSalary });
    if (kind === 'deduction') {
      Object.assign(values, {
        label,
        reducesTaxablePay,
        authorizedInWriting: reducesTaxablePay ? false : authorizedInWriting,
        countsAsBasicSalary,
      });
    }
    if (kind === 'override') values.targetLineKey = targetLineKey;
    if (entry) values.entryId = entry.id;
    else values.employeeId = employeeId;
    try {
      const ok = await save.run(values);
      if (!ok) {
        requestAnimationFrame(() => {
          formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
        });
      }
    } catch {
      setNetworkError(SAVE_FAILED);
    }
  }

  const sectionTitle = PAYROLL_MANUAL_ENTRY_KIND_LABELS[kind];
  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={submit}
      className="flex min-h-0 flex-1 flex-col"
      aria-busy={save.pending || undefined}
    >
      <SheetHeader title={editing ? 'Edit manual entry' : 'Add manual entry'} description={name} />
      <SheetBody>
        <FormAlert
          message={
            save.formError ??
            errors.runId ??
            errors.employeeId ??
            errors.entryId ??
            errors.kind ??
            networkError
          }
        />
        {editing ? null : (
          <SegmentedControl
            label="Kind of entry"
            fullWidth
            track="page"
            tone="accent"
            value={kind}
            onValueChange={changeKind}
            options={KIND_OPTIONS}
          />
        )}

        <FormSection title={sectionTitle}>
          {kind === 'override' ? (
            editing ? (
              <FormField label="Line to override" hint="Fixed: remove the entry to change it.">
                <Input value={target?.label ?? entry?.label ?? ''} readOnly />
              </FormField>
            ) : (
              <FormField
                label="Line to override"
                required
                hint={
                  target
                    ? `Computed ${pesoText(target.computedAmountCentavos)}${target.overridden ? ' · already overridden' : ''}`
                    : undefined
                }
                error={errors.targetLineKey}
              >
                <Select
                  value={targetLineKey}
                  onChange={(event) => {
                    setTargetLineKey(event.target.value);
                    save.reset();
                  }}
                >
                  {overrideTargets.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.overridden ? `${option.label} (overridden)` : option.label}
                    </option>
                  ))}
                </Select>
              </FormField>
            )
          ) : (
            <FormField
              label="Label"
              required
              hint="Printed on the payslip, for example “Back pay: salary increase from Sep 15”."
              error={errors.label}
            >
              <Input
                value={label}
                maxLength={PAYROLL_MANUAL_LABEL_MAX_LENGTH}
                onChange={(event) => setLabel(event.target.value)}
              />
            </FormField>
          )}
          <FormField
            label={kind === 'override' ? 'New amount' : 'Amount'}
            required
            hint={
              kind === 'override'
                ? editing &&
                  entry?.computedAmountCentavos !== null &&
                  entry?.computedAmountCentavos !== undefined
                  ? `₱0.00 or more. Computed ${pesoText(entry.computedAmountCentavos)}.`
                  : '₱0.00 or more.'
                : 'In pesos, for example 1,000.00.'
            }
            error={amountError}
          >
            <Input
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="numeric sm:max-w-60"
            />
          </FormField>
        </FormSection>

        {kind === 'earning' ? (
          <FormSection>
            <SwitchField
              label="Taxable"
              hint="Counts in the compensation for contributions and the taxable compensation."
              error={errors.taxable}
              checked={taxable}
              onChange={setTaxable}
            />
            <SwitchField
              label="Counts as basic salary"
              hint="For back pay of basic salary, so 13th month pay counts it."
              error={errors.countsAsBasicSalary}
              checked={countsAsBasicSalary}
              onChange={setCountsAsBasicSalary}
            />
          </FormSection>
        ) : null}

        {kind === 'deduction' ? (
          <FormSection>
            <SwitchField
              label="Reduces taxable pay"
              hint="Yes for a correction of taxable pay paid earlier; no for a deduction after tax, such as a loan or cash advance."
              error={errors.reducesTaxablePay}
              checked={reducesTaxablePay}
              onChange={(next) => {
                setReducesTaxablePay(next);
                save.reset();
              }}
            />
            {reducesTaxablePay ? null : (
              <SwitchField
                label={PAYROLL_AUTHORIZED_IN_WRITING_LABEL}
                hint="Required for a deduction after tax."
                error={errors.authorizedInWriting}
                checked={authorizedInWriting}
                onChange={setAuthorizedInWriting}
              />
            )}
            <SwitchField
              label="Counts as basic salary"
              hint="For a correction of basic pay."
              error={errors.countsAsBasicSalary}
              checked={countsAsBasicSalary}
              onChange={setCountsAsBasicSalary}
            />
          </FormSection>
        ) : null}

        <FormSection>
          <FormField
            label="Reason"
            required
            hint={PAYROLL_MANUAL_REASON_HINT}
            error={errors.reason}
          >
            <Textarea
              value={reason}
              maxLength={PAYROLL_MANUAL_REASON_MAX_LENGTH}
              onChange={(event) => setReason(event.target.value)}
            />
          </FormField>
        </FormSection>
      </SheetBody>
      <SheetFooter>
        <Button variant="secondary" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={save.pending}>
          <Save aria-hidden="true" className="size-4.5" />
          Save
        </Button>
      </SheetFooter>
    </form>
  );
}

/** "Remove": the confirmation with its reason. */
export function RemoveManualEntrySheet({
  runId,
  entry,
  onRemoved,
  onCancel,
}: {
  runId: string;
  entry: PayrollBreakdownManualEntry;
  onRemoved: () => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [networkError, setNetworkError] = useState<string | null>(null);
  const remove = useActionSubmit(removePayrollManualEntryAction, onRemoved);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNetworkError(null);
    try {
      await remove.run({ runId, entryId: entry.id, reason });
    } catch {
      setNetworkError(REMOVE_FAILED);
    }
  }

  return (
    <form noValidate onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <SheetHeader
        title="Remove this entry?"
        description={`${PAYROLL_MANUAL_ENTRY_KIND_LABELS[entry.kind]} · ${entry.label}`}
      />
      <SheetBody>
        <FormAlert message={remove.formError ?? remove.fieldErrors.entryId ?? networkError} />
        <p className="flex items-start gap-2 text-subheadline text-text-secondary">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            The run is recomputed without it. The entry and its history stay in the record.
          </span>
        </p>
        <FormSection>
          <FormField
            label="Reason"
            required
            hint={PAYROLL_MANUAL_REASON_HINT}
            error={remove.fieldErrors.reason}
          >
            <Textarea
              value={reason}
              maxLength={PAYROLL_MANUAL_REASON_MAX_LENGTH}
              onChange={(event) => setReason(event.target.value)}
            />
          </FormField>
        </FormSection>
      </SheetBody>
      <SheetFooter>
        <Button variant="secondary" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="destructive" loading={remove.pending}>
          <Trash2 aria-hidden="true" className="size-4.5" />
          Remove
        </Button>
      </SheetFooter>
    </form>
  );
}
