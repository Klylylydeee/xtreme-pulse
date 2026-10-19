'use client';

import type { ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { TIMESHEET_TYPE_LABELS } from '@pulse/core';
import {
  CONTRIBUTION_BASE_KIND_LABELS,
  formatOffsetHours,
  PAYROLL_HOW_COMPUTED_LABEL,
  PAYROLL_NEGATIVE_NET_LABEL,
  PAYROLL_OFFSET_EARNED_LABEL,
  PAYROLL_PROVISIONAL_NOTE,
  RATE_TYPE_LABELS,
  TIMESHEET_STATUS_LABELS,
} from '@pulse/talent';
import type { PayrollRunBreakdownView } from '@pulse/talent/server';
import { Button } from '@pulse/ui/components/button';
import { ErrorState } from '@pulse/ui/components/error-state';
import { SheetBody, SheetHeader } from '@pulse/ui/components/sheet';
import { Skeleton } from '@pulse/ui/components/skeleton';
import { getPayrollBreakdownAction } from '@/lib/actions/talent-payroll-runs';
import { lineAmountText, lineDetailText, pesoText } from './payroll-format';

// Spec: docs/modules/talent.md#payroll-run-computation-build-step-29 ("The employee line",
// "Screens": the breakdown sheet) and docs/DESIGN_SYSTEM.md#layout--components ("Payroll runs on
// a phone": full height on a phone, inset grouped sections) — one person's breakdown: Earnings,
// Deductions, "Settled from earlier cut-offs" (each line naming its period), Employer shares, then
// "How it was computed", closed by gross, total deductions and net pay in bold. Amounts are
// right-aligned tabular numerals with a minus sign when negative, never color alone.
//
// The breakdown is fetched once each time the sheet opens, from the click that opens it (never in
// an effect or on render): the action writes and commits a `reveal` on the line before anything is
// decrypted. It is held in the run page's state only, never in a URL, storage or a log.

const LOAD_FAILED = 'The breakdown couldn’t load. Check your connection and try again.';
const GONE = 'This employee’s line is no longer in the run. Reload the page.';

export type PayrollBreakdownLoad =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; view: PayrollRunBreakdownView };

/** An inset grouped section with a heading. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-4 text-footnote font-semibold text-text-secondary">{title}</h3>
      <dl className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
        {children}
      </dl>
    </section>
  );
}

/** One row: the label (and its detail) at the start, the value right-aligned. */
function Row({
  label,
  detail,
  value,
  strong = false,
}: {
  label: string;
  detail?: string | null;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex min-h-11 items-start justify-between gap-4 px-4 py-2.5">
      <dt className="flex min-w-0 flex-col gap-0.5">
        <span
          className={
            strong ? 'text-subheadline font-semibold break-words' : 'text-subheadline break-words'
          }
        >
          {label}
        </span>
        {detail ? (
          <span className="text-footnote break-words text-text-secondary numeric">{detail}</span>
        ) : null}
      </dt>
      <dd
        className={
          strong
            ? 'shrink-0 text-right text-subheadline font-semibold numeric'
            : 'shrink-0 text-right text-subheadline numeric'
        }
      >
        {value}
      </dd>
    </div>
  );
}

function BreakdownLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">Loading the breakdown…</span>
      {Array.from({ length: 3 }, (_, section) => (
        <div key={section} aria-hidden="true" className="flex flex-col gap-2">
          <Skeleton className="ml-4 h-4 w-24" />
          <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
            {Array.from({ length: 3 }, (_, row) => (
              <div key={row} className="flex min-h-11 items-center justify-between gap-4 px-4">
                <Skeleton className="h-4 w-40 max-w-[60%]" />
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function BreakdownContent({ view }: { view: PayrollRunBreakdownView }) {
  const { breakdown } = view;
  const { facts, totals, contributions } = breakdown;
  const money = (value: number | null) => (value === null ? '—' : pesoText(value));
  const agencies = [
    { label: 'SSS', agency: contributions.sss },
    { label: 'PhilHealth', agency: contributions.philhealth },
    { label: 'Pag-IBIG', agency: contributions.pagibig },
  ];
  return (
    <>
      {facts.provisional ? (
        <p className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-footnote font-medium text-warning-text shadow-card">
          <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0" strokeWidth={2} />
          <span>{PAYROLL_PROVISIONAL_NOTE}</span>
        </p>
      ) : null}

      {view.groups.map((group) => (
        <Section key={group.group} title={group.label}>
          {group.lines.map((line) => (
            <Row
              key={`${line.group}:${line.periodStart}:${line.key}`}
              label={line.label}
              detail={lineDetailText(line)}
              value={lineAmountText(line)}
            />
          ))}
        </Section>
      ))}

      {facts.offsetEarnedMinutes > 0 ? (
        <Section title="Not paid">
          <Row
            label={PAYROLL_OFFSET_EARNED_LABEL}
            value={formatOffsetHours(facts.offsetEarnedMinutes)}
          />
        </Section>
      ) : null}

      <Section title={PAYROLL_HOW_COMPUTED_LABEL}>
        <Row label="Rate type" value={facts.rateType ? RATE_TYPE_LABELS[facts.rateType] : '—'} />
        <Row label="Salary" value={money(facts.salaryCentavos)} />
        <Row
          label="Daily rate"
          detail={`Factor ${facts.dailyRateFactor}`}
          value={money(facts.dailyRateCentavos)}
        />
        <Row
          label="Hourly rate"
          detail={`${facts.hoursPerDay} hours a day`}
          value={money(facts.hourlyRateCentavos)}
        />
        <Row
          label="Base days"
          detail={
            facts.employedBaseDays === facts.baseDays
              ? null
              : `${facts.employedBaseDays} while employed`
          }
          value={String(facts.baseDays)}
        />
        <Row label="Days present" value={String(facts.presentDays)} />
        <Row
          label="Timesheet"
          value={[
            facts.timesheetType ? TIMESHEET_TYPE_LABELS[facts.timesheetType] : null,
            facts.timesheetStatus ? TIMESHEET_STATUS_LABELS[facts.timesheetStatus] : 'None',
          ]
            .filter(Boolean)
            .join(' · ')}
        />
        {facts.minimumWageEarner ? <Row label="Minimum wage earner" value="Yes" /> : null}
        <Row
          label="Compensation for contributions"
          value={pesoText(breakdown.compensationForContributionsCentavos)}
        />
        {agencies.map(({ label, agency }) => (
          <Row
            key={label}
            label={`${label} basis`}
            detail={CONTRIBUTION_BASE_KIND_LABELS[agency.basis]}
            value={pesoText(agency.basisCentavos)}
          />
        ))}
        <Row label="SSS salary credit" value={pesoText(contributions.sss.mscCentavos)} />
        <Row label="Taxable compensation" value={pesoText(breakdown.taxableCompensationCentavos)} />
        <Row label="Tax withheld" value={pesoText(breakdown.taxCentavos)} />
      </Section>

      <Section title="Net pay">
        <Row label="Gross pay" value={pesoText(totals.grossCentavos)} strong />
        <Row label="Total deductions" value={pesoText(totals.deductionsCentavos)} strong />
        <Row label="Net pay" value={pesoText(totals.netPayCentavos)} strong />
      </Section>
      {breakdown.negativeNet ? (
        <p className="flex items-start gap-2 px-4 text-footnote font-medium text-warning-text">
          <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0" strokeWidth={2} />
          <span>{PAYROLL_NEGATIVE_NET_LABEL}</span>
        </p>
      ) : null}
    </>
  );
}

/** Fetches one person's breakdown (one `reveal`). Call it only from the user's explicit open. */
export async function loadPayrollBreakdown(
  runId: string,
  lineId: string,
): Promise<PayrollBreakdownLoad> {
  try {
    const result = await getPayrollBreakdownAction(null, { runId, lineId });
    if (!result.ok) return { state: 'error', message: result.formError ?? LOAD_FAILED };
    if (!result.data) return { state: 'error', message: GONE };
    return { state: 'ready', view: result.data };
  } catch {
    return { state: 'error', message: LOAD_FAILED };
  }
}

/**
 * The sheet's content for one person, as `loaded` stands. `name` is the row's name, shown while it
 * loads; `onRetry` loads it again (another `reveal`).
 */
export function PayrollBreakdownSheet({
  name,
  loaded,
  onRetry,
}: {
  name: string;
  loaded: PayrollBreakdownLoad;
  onRetry: () => void;
}) {
  const view = loaded.state === 'ready' ? loaded.view : null;
  return (
    <>
      <SheetHeader
        title={view?.employee.name ?? name}
        description={
          view
            ? [view.employee.employeeNumber, view.employee.department, view.periodText]
                .filter(Boolean)
                .join(' · ')
            : 'Breakdown'
        }
      />
      <SheetBody>
        {loaded.state === 'loading' ? <BreakdownLoading /> : null}
        {loaded.state === 'error' ? (
          <ErrorState
            variant="inline"
            headingLevel={3}
            title="Breakdown unavailable"
            description={loaded.message}
            action={
              <Button variant="tinted" onClick={onRetry}>
                Try again
              </Button>
            }
          />
        ) : null}
        {view ? <BreakdownContent view={view} /> : null}
      </SheetBody>
    </>
  );
}
