'use client';

import { type FormEvent, useState } from 'react';
import { CheckCheck, RotateCw, Send, TriangleAlert } from 'lucide-react';
import {
  PAYROLL_ACKNOWLEDGE_ALL_LABEL,
  PAYROLL_ACKNOWLEDGE_LABEL,
  PAYROLL_ACKNOWLEDGE_REASON_MAX_LENGTH,
  PAYROLL_FLAG_LABELS,
  PAYROLL_RECOMPUTED_AT_SUBMIT_MESSAGE,
  PAYROLL_RUN_CHANGED_MESSAGE,
  PAYROLL_SUBMIT_LABEL,
  type PayrollAcknowledgeableFlag,
  payrollFlaggedRefusal,
  payrollSubmitSummary,
} from '@pulse/talent';
import { Button } from '@pulse/ui/components/button';
import { FormField, FormSection, Textarea } from '@pulse/ui/components/form';
import { SheetBody, SheetClose, SheetFooter, SheetHeader } from '@pulse/ui/components/sheet';
import { FormAlert } from '@/components/form-alert';
import { plural, useActionSubmit } from '@/components/org-structure';
import {
  acknowledgeAllPayrollFlagAction,
  acknowledgePayrollFlagAction,
  submitPayrollRunAction,
} from '@/lib/actions/talent-payroll-runs';

// Spec: docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 ("Review
// flags": acknowledging; "Submitting"; "Screens") and docs/DESIGN_SYSTEM.md#layout--components
// ("Payroll review and payslips on a phone") — the run page's review sheets:
//
// - "Acknowledge" (one person's flag) and "Acknowledge all" (every person with that flag not yet
//   acknowledged), each with a required reason (1–300 characters). Acknowledging changes no pay.
// - "Submit for approval": what will be sent in counts only ("2 employees · 1 manual entry · 1 flag
//   acknowledged"), the company details warning in `warning-text` while any detail is a
//   placeholder, and the submit. The server refuses in its own words; when it recomputed the run
//   at submit (or the run changed since the page loaded) the sheet offers "Reload the page".

const ACKNOWLEDGE_FAILED = 'The flag wasn’t acknowledged. Check your connection and try again.';
const SUBMIT_FAILED = 'The run wasn’t submitted. Check your connection and try again.';
const REASON_EXAMPLE = 'For example “Paid by check; bank details to follow”.';

/** "Acknowledge" or "Acknowledge all": the sheet's content. */
export function AcknowledgeSheet({
  runId,
  flag,
  person,
  count,
  onDone,
}: {
  runId: string;
  flag: PayrollAcknowledgeableFlag;
  /** One person ("Acknowledge"), or null for everyone with the flag ("Acknowledge all"). */
  person: { employeeId: string; name: string; flagText: string } | null;
  /** "Acknowledge all": how many people it covers. */
  count: number;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [networkError, setNetworkError] = useState<string | null>(null);
  const one = useActionSubmit(acknowledgePayrollFlagAction, onDone);
  const all = useActionSubmit(acknowledgeAllPayrollFlagAction, onDone);
  const save = person ? one : all;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNetworkError(null);
    try {
      if (person) await one.run({ runId, employeeId: person.employeeId, flag, reason });
      else await all.run({ runId, flag, reason });
    } catch {
      setNetworkError(ACKNOWLEDGE_FAILED);
    }
  }

  const label = PAYROLL_FLAG_LABELS[flag];
  return (
    <form noValidate onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <SheetHeader
        title={person ? `Acknowledge: ${label}` : `${PAYROLL_ACKNOWLEDGE_ALL_LABEL}: ${label}`}
        description={
          person
            ? `${person.name} · ${person.flagText}`
            : `${plural(count, 'employee', 'employees')} with this flag not yet acknowledged`
        }
      />
      <SheetBody>
        <FormAlert
          message={
            save.formError ??
            save.fieldErrors.runId ??
            save.fieldErrors.employeeId ??
            save.fieldErrors.flag ??
            networkError
          }
        />
        <p className="text-subheadline text-text-secondary">
          Acknowledging records that you have seen this and that the line is paid as computed. It
          changes no pay.
        </p>
        <FormSection>
          <FormField label="Reason" required hint={REASON_EXAMPLE} error={save.fieldErrors.reason}>
            <Textarea
              value={reason}
              maxLength={PAYROLL_ACKNOWLEDGE_REASON_MAX_LENGTH}
              onChange={(event) => setReason(event.target.value)}
            />
          </FormField>
        </FormSection>
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="secondary" type="button">
            Cancel
          </Button>
        </SheetClose>
        <Button type="submit" loading={save.pending}>
          <CheckCheck aria-hidden="true" className="size-4.5" />
          {person ? PAYROLL_ACKNOWLEDGE_LABEL : PAYROLL_ACKNOWLEDGE_ALL_LABEL}
        </Button>
      </SheetFooter>
    </form>
  );
}

/** Refusals after which the page must load the run again. */
const RELOAD_MESSAGES = new Set([
  PAYROLL_RECOMPUTED_AT_SUBMIT_MESSAGE,
  PAYROLL_RUN_CHANGED_MESSAGE,
]);

/** "Submit for approval": the confirmation sheet's content. */
export function SubmitSheet({
  runId,
  version,
  employeeCount,
  manualEntryCount,
  acknowledgedFlagCount,
  unresolvedFlaggedEmployees,
  companyWarning,
  onDone,
  onReload,
}: {
  runId: string;
  version: number;
  employeeCount: number;
  manualEntryCount: number;
  acknowledgedFlagCount: number;
  unresolvedFlaggedEmployees: number;
  /** "Company details are still placeholders, so payslips will print them.", or null. */
  companyWarning: string | null;
  onDone: () => void;
  onReload: () => void;
}) {
  const [networkError, setNetworkError] = useState<string | null>(null);
  const save = useActionSubmit(submitPayrollRunAction, onDone);
  const message = save.formError ?? save.fieldErrors.runId ?? save.fieldErrors.version ?? null;

  async function submit() {
    setNetworkError(null);
    try {
      await save.run({ runId, version });
    } catch {
      setNetworkError(SUBMIT_FAILED);
    }
  }

  const reload = message !== null && RELOAD_MESSAGES.has(message);
  return (
    <>
      <SheetHeader
        title="Submit for Board approval?"
        description="Any one Board of Directors member approves or returns it in Approvals."
      />
      <SheetBody>
        <FormAlert message={message ?? networkError} />
        {reload ? (
          <Button variant="tinted" onClick={onReload} className="w-fit">
            <RotateCw aria-hidden="true" className="size-4.5" />
            Reload the page
          </Button>
        ) : null}
        <section className="flex flex-col gap-2">
          <h3 className="px-4 text-footnote font-semibold text-text-secondary">What is sent</h3>
          <p className="rounded-card bg-surface px-4 py-3 text-subheadline shadow-card numeric">
            {payrollSubmitSummary({ employeeCount, manualEntryCount, acknowledgedFlagCount })}
          </p>
        </section>
        {unresolvedFlaggedEmployees > 0 ? (
          <p className="flex items-start gap-2 px-4 text-footnote font-medium text-warning-text">
            <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0" strokeWidth={2} />
            <span>{payrollFlaggedRefusal(unresolvedFlaggedEmployees)}</span>
          </p>
        ) : null}
        {companyWarning ? (
          <p className="flex items-start gap-2 px-4 text-footnote font-medium text-warning-text">
            <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0" strokeWidth={2} />
            <span>{companyWarning}</span>
          </p>
        ) : null}
        <p className="text-subheadline text-text-secondary">
          The run is recomputed first; if anything changed you review it before submitting again.
          While it waits for the Board it can’t be recomputed or changed. Approval finalizes it, and
          each employee’s payslip is then prepared.
        </p>
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="secondary">Cancel</Button>
        </SheetClose>
        <Button onClick={() => void submit()} loading={save.pending}>
          <Send aria-hidden="true" className="size-4.5" />
          {PAYROLL_SUBMIT_LABEL}
        </Button>
      </SheetFooter>
    </>
  );
}
