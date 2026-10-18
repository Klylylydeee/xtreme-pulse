'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronRight, CircleAlert, Info, Send, TriangleAlert } from 'lucide-react';
import { formatPeso } from '@pulse/core';
import {
  EMPTY_TIMESHEET_WARNING,
  formatHours,
  SUBMIT_LOCK_NOTICE,
  type TimesheetSubmitProblemView,
  type TimesheetSubmitSummaryView,
} from '@pulse/talent';
import { Button } from '@pulse/ui/components/button';
import { SheetBody, SheetClose, SheetFooter, SheetHeader } from '@pulse/ui/components/sheet';
import { cn } from '@pulse/ui/lib/utils';
import { useActionSubmit } from '@/components/org-structure';
import { submitTimesheetAction } from '@/lib/actions/talent-timesheets';

// Spec: docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27
// ("Submitting", "Screens") and docs/DESIGN_SYSTEM.md#layout--components ("Timesheets on a phone":
// Submit) — the confirmation sheet behind "Submit timesheet" (or "Resubmit"), full height on a
// phone: the cut-off's summary in an inset grouped list (days present, absent and late, the total
// overtime or offset, the reimbursement total, the count of manual times), each blocking problem
// named with a link to fix it, the empty-timesheet warning, "You can't change it while it's
// waiting for approval.", and the primary "Submit". With a blocking problem the Submit button is
// disabled (the server refuses anyway, with the same words). A problem on this timesheet (a day,
// a reimbursement line) opens that day's or line's sheet here; an onboarding item links to
// `/talent/onboarding`. The action sends only the timesheet's id.

const SUBMIT_FAILED = 'That didn’t go through. Check your connection and try again.';

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 px-4 py-2.5">
      <dt className="text-subheadline">{label}</dt>
      <dd className="text-subheadline font-semibold numeric">{value}</dd>
    </div>
  );
}

function ProblemRow({
  problem,
  onFix,
}: {
  problem: TimesheetSubmitProblemView;
  /** True when the screen opened the day or line itself; false to follow the link. */
  onFix: (problem: TimesheetSubmitProblemView) => boolean;
}) {
  const body = (
    <>
      <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0 text-warning-text" />
      <span className="min-w-0 flex-1 break-words">{problem.message}</span>
      {problem.href ? (
        <ChevronRight aria-hidden="true" className="mt-px size-4 shrink-0 text-text-tertiary" />
      ) : null}
    </>
  );
  const row = 'flex min-h-11 w-full items-start gap-2.5 px-4 py-3 text-left text-footnote';
  if (!problem.href) return <div className={row}>{body}</div>;
  return (
    <Link
      href={problem.href}
      onClick={(event) => {
        if (onFix(problem)) event.preventDefault();
      }}
      className={cn(
        row,
        'font-medium transition-colors duration-fast hover:bg-accent-subtle/40 focus-visible:outline-offset-[-2px]',
      )}
    >
      {body}
    </Link>
  );
}

export function SubmitSheetContent({
  submit,
  timesheetId,
  periodText,
  onFix,
  onDone,
}: {
  submit: TimesheetSubmitSummaryView;
  timesheetId: string;
  /** "Sep 11 – 25, 2026". */
  periodText: string;
  onFix: (problem: TimesheetSubmitProblemView) => boolean;
  onDone: () => void;
}) {
  const [networkError, setNetworkError] = useState<string | null>(null);
  const action = useActionSubmit(submitTimesheetAction, onDone);
  const blocked = submit.problems.length > 0;
  const error = action.formError ?? action.fieldErrors.timesheetId ?? networkError;
  const extraLabel = submit.treatment === 'overtime' ? 'Total overtime' : 'Offset';
  const title = submit.resubmit ? 'Resubmit timesheet' : 'Submit timesheet';

  async function send() {
    setNetworkError(null);
    action.reset();
    try {
      await action.run({ timesheetId });
    } catch {
      setNetworkError(SUBMIT_FAILED);
    }
  }

  return (
    <>
      <SheetHeader title={title} description={`Cut-off ${periodText}`} />
      <SheetBody>
        <section aria-labelledby="submit-summary" className="flex flex-col gap-2">
          <h3 id="submit-summary" className="px-4 text-footnote font-semibold text-text-secondary">
            Summary
          </h3>
          <dl className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
            <SummaryRow label="Days present" value={String(submit.daysPresent)} />
            <SummaryRow label="Days absent" value={String(submit.daysAbsent)} />
            <SummaryRow label="Days late" value={String(submit.daysLate)} />
            <SummaryRow label={extraLabel} value={formatHours(submit.extraMinutes)} />
            <SummaryRow
              label={`Reimbursements (${plural(submit.reimbursementCount, 'receipt', 'receipts')})`}
              value={formatPeso(submit.reimbursementTotalCentavos)}
            />
            <SummaryRow label="Manual times" value={String(submit.manualTimeCount)} />
          </dl>
        </section>

        {blocked ? (
          <section aria-labelledby="submit-problems" className="flex flex-col gap-2">
            <h3
              id="submit-problems"
              className="px-4 text-footnote font-semibold text-destructive-text"
            >
              Fix these before you submit
            </h3>
            <ul className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
              {submit.problems.map((problem, index) => (
                <li key={`${problem.problem.kind}-${index}`}>
                  <ProblemRow problem={problem} onFix={onFix} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {submit.empty ? (
          <p className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-footnote font-medium text-warning-text shadow-card">
            <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
            <span>{EMPTY_TIMESHEET_WARNING}</span>
          </p>
        ) : null}

        <p className="flex items-start gap-2 px-4 text-footnote text-text-secondary">
          <Info aria-hidden="true" className="mt-px size-4 shrink-0" />
          <span>{SUBMIT_LOCK_NOTICE}</span>
        </p>

        <div role="alert" className="empty:hidden">
          {error ? (
            <p className="flex items-start gap-1.5 px-4 text-footnote font-medium text-destructive-text">
              <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
              <span>{error}</span>
            </p>
          ) : null}
        </div>
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="secondary" className="flex-1 sm:flex-none">
            Cancel
          </Button>
        </SheetClose>
        <Button
          onClick={send}
          loading={action.pending}
          disabled={blocked}
          className="flex-1 sm:flex-none"
        >
          <Send aria-hidden="true" className="size-4" />
          {submit.resubmit ? 'Resubmit' : 'Submit'}
        </Button>
      </SheetFooter>
    </>
  );
}
