'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, CalendarClock, ChevronRight, HandCoins, Plus } from 'lucide-react';
import { type BusinessDate, formatDate, formatDateTime } from '@pulse/core';
import type {
  PayrollCreatableCutOff,
  PayrollRunListRow,
  PayrollRunListView,
} from '@pulse/talent/server';
import { cn } from '@pulse/ui';
import { Button, buttonVariants } from '@pulse/ui/components/button';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { PageHeader } from '@pulse/ui/components/page-header';
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
} from '@pulse/ui/components/sheet';
import { useReturnFocus } from '@pulse/ui/hooks/use-return-focus';
import { FormAlert } from '@/components/form-alert';
import { plural, useActionSubmit } from '@/components/org-structure';
import { createPayrollDraftRunAction } from '@/lib/actions/talent-payroll-runs';
import { PAYROLL_HREF } from '@/lib/navigation';
import { dayOfMonth } from '../timesheet-ui/format';
import { RunStatusBadge } from './payroll-badges';
import { monthShortText } from '../time-off-ui/format';

// Spec: docs/modules/talent.md#payroll-run-computation-build-step-29 ("Creating a draft",
// "Screens": `/talent/payroll`) and docs/DESIGN_SYSTEM.md#layout--components ("Payroll runs on a
// phone": the runs list) — the payroll runs, newest first (the server's order), as a list: rows at
// least 64px tall, each with a date tile for the pay date, the period and number, the status as a
// text badge, the employee count and "Computed <when>". No amount is on this page.
//
// - While the go-live date isn't set: the server's words ("Set the go-live date in Payroll settings
//   › Leave first."), linking to Payroll settings.
// - "Compute draft run" (the page's primary button, for the server's `canCompute`) opens a sheet
//   listing the ended cut-offs with no run as a radio list; creating one opens its run page.

const DESCRIPTION =
  'Draft payroll runs per cut-off, computed from the DTR, time off, reimbursements and pay settings.';
const SAVE_FAILED = 'The draft wasn’t computed. Check your connection and try again.';

/** The pay date's month and day in an `accent-subtle` rounded square. */
function PayDateTile({ date }: { date: BusinessDate }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-12 shrink-0 flex-col items-center justify-center rounded-lg bg-accent-subtle text-accent"
    >
      <span className="text-caption font-medium uppercase">{monthShortText(date)}</span>
      <span className="text-headline leading-none numeric">{dayOfMonth(date)}</span>
    </span>
  );
}

/** "Computed Oct 19, 2026, 5:00 AM by Ana Cruz", or "… by the nightly job". */
export function computedText(row: Pick<PayrollRunListRow, 'computedAt' | 'computedByName'>) {
  return `Computed ${formatDateTime(new Date(row.computedAt))} by ${
    row.computedByName ?? 'the nightly job'
  }`;
}

function RunRow({ run }: { run: PayrollRunListRow }) {
  const counts = [
    plural(run.employeeCount, 'employee', 'employees'),
    run.leftOutCount > 0 ? `${run.leftOutCount} left out` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li>
      <Link
        href={`${PAYROLL_HREF}/${run.id}`}
        aria-label={`${run.periodText}, ${run.number}, paid ${formatDate(run.payDate)}, ${run.statusLabel}`}
        className={cn(
          'flex min-h-16 w-full items-center gap-3 px-4 py-3 transition-colors duration-fast',
          'hover:bg-accent-subtle/40 focus-visible:outline-offset-[-2px] md:px-5',
        )}
      >
        <PayDateTile date={run.payDate} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-subheadline font-semibold break-words numeric">
              {run.periodText}
            </span>
            <span className="text-footnote text-text-secondary numeric">{run.number}</span>
            <RunStatusBadge status={run.status} label={run.statusLabel} />
          </span>
          <span className="text-footnote break-words text-text-secondary numeric">
            Paid {formatDate(run.payDate)} · {counts}
          </span>
          <span className="text-footnote break-words text-text-secondary numeric">
            {computedText(run)}
          </span>
        </span>
        <ChevronRight aria-hidden="true" className="size-4.5 shrink-0 text-text-tertiary" />
      </Link>
    </li>
  );
}

/** "Compute draft run": the ended cut-offs with no run, as a radio list. */
function ComputeDraftSheet({ creatable }: { creatable: PayrollCreatableCutOff[] }) {
  const router = useRouter();
  const groupId = useId();
  const [periodStart, setPeriodStart] = useState<string | null>(creatable[0]?.periodStart ?? null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const save = useActionSubmit(createPayrollDraftRunAction, (data) => router.push(data.href));
  const error = save.fieldErrors.periodStart ?? save.formError ?? networkError;

  async function submit() {
    if (!periodStart) return;
    setNetworkError(null);
    try {
      await save.run({ periodStart });
    } catch {
      setNetworkError(SAVE_FAILED);
    }
  }

  return (
    <>
      <SheetHeader
        title="Compute draft run"
        description="Pick an ended cut-off with no run yet. The draft is computed from today’s data and can be recomputed until it is finalized."
      />
      <SheetBody>
        <FormAlert message={error} />
        {creatable.length > 0 ? (
          <fieldset className="flex flex-col" aria-busy={save.pending || undefined}>
            <legend className="mb-2 px-4 text-footnote font-semibold text-text-secondary">
              Cut-off
            </legend>
            <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
              {creatable.map((cutOff) => {
                const optionId = `${groupId}-${cutOff.periodStart}`;
                return (
                  <div
                    key={cutOff.periodStart}
                    className="relative flex min-h-11 cursor-pointer items-start gap-3 px-4 py-3"
                  >
                    <input
                      id={optionId}
                      type="radio"
                      name="periodStart"
                      value={cutOff.periodStart}
                      checked={periodStart === cutOff.periodStart}
                      aria-describedby={`${optionId}-hint`}
                      onChange={() => {
                        setPeriodStart(cutOff.periodStart);
                        save.reset();
                      }}
                      className="mt-0.5 size-5 shrink-0 cursor-[inherit] accent-accent"
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <label
                        htmlFor={optionId}
                        className="cursor-pointer text-subheadline font-medium numeric after:absolute after:inset-0 after:content-['']"
                      >
                        {cutOff.periodText}
                      </label>
                      <span
                        id={`${optionId}-hint`}
                        className="text-footnote text-text-secondary numeric"
                      >
                        Paid {formatDate(cutOff.payDate)}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          </fieldset>
        ) : (
          <EmptyState
            icon={<CalendarClock strokeWidth={1.75} />}
            title="Every ended cut-off has a run"
            description="A new cut-off can be computed the day after it ends. The nightly job also creates the latest one."
          />
        )}
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="secondary">Cancel</Button>
        </SheetClose>
        {creatable.length > 0 ? (
          <Button onClick={() => void submit()} loading={save.pending} disabled={!periodStart}>
            Compute draft
          </Button>
        ) : null}
      </SheetFooter>
    </>
  );
}

export function PayrollRunsList({ view }: { view: PayrollRunListView }) {
  const focus = useReturnFocus();
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  const canCreate = view.canCompute && view.goLiveDate !== null;

  return (
    <>
      <div className="flex flex-col gap-3">
        <Link
          href="/talent"
          className={buttonVariants({ variant: 'plain', className: '-ml-3 w-fit text-accent' })}
        >
          <ArrowLeft aria-hidden="true" className="size-4.5" />
          Employees
        </Link>
        <PageHeader
          title="Payroll"
          description={DESCRIPTION}
          actions={
            canCreate ? (
              <Button
                onClick={(event) => {
                  focus.remember(event.currentTarget);
                  setSession((count) => count + 1);
                  setOpen(true);
                }}
              >
                <Plus aria-hidden="true" className="size-4.5" />
                Compute draft run
              </Button>
            ) : null
          }
        />
      </div>

      {view.goLiveMissingMessage ? (
        <EmptyState
          icon={<CalendarClock strokeWidth={1.75} />}
          title={view.goLiveMissingMessage}
          description="Payroll starts with the first cut-off on or after the go-live date. A Talent Owner in HR sets it in Payroll settings › Leave."
          action={
            <Link href="/talent/payroll-settings" className={buttonVariants({ variant: 'tinted' })}>
              Payroll settings
            </Link>
          }
        />
      ) : view.firstPeriodStart ? (
        <p className="text-footnote text-text-secondary numeric">
          The first payroll cut-off starts {formatDate(view.firstPeriodStart)}.
        </p>
      ) : null}

      {view.runs.length > 0 ? (
        <section aria-label="Payroll runs" className="flex flex-col gap-2">
          <p className="text-footnote text-text-secondary numeric">
            {plural(view.runs.length, 'run', 'runs')}
          </p>
          <ul className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
            {view.runs.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </ul>
        </section>
      ) : view.goLiveMissingMessage ? null : (
        <EmptyState
          icon={<HandCoins strokeWidth={1.75} />}
          title="No payroll runs yet"
          description={
            canCreate
              ? 'Compute the draft of an ended cut-off, or wait for the nightly job to create the latest one.'
              : 'The nightly job creates the latest cut-off’s draft once its timesheets are in. HR can also compute one.'
          }
          action={
            canCreate && view.creatable.length > 0 ? (
              <Button
                variant="tinted"
                onClick={(event) => {
                  focus.remember(event.currentTarget);
                  setSession((count) => count + 1);
                  setOpen(true);
                }}
              >
                Compute draft run
              </Button>
            ) : undefined
          }
        />
      )}

      {canCreate ? (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent onCloseAutoFocus={focus.onCloseAutoFocus}>
            <ComputeDraftSheet key={session} creatable={view.creatable} />
          </SheetContent>
        </Sheet>
      ) : null}
    </>
  );
}
