'use client';

import type { ReactNode } from 'react';
import { Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { formatDateTime, TIMESHEET_TYPE_LABELS } from '@pulse/core';
import {
  CONTRIBUTION_BASE_KIND_LABELS,
  formatOffsetHours,
  PAYROLL_AUTHORIZED_IN_WRITING_LABEL,
  PAYROLL_HOW_COMPUTED_LABEL,
  PAYROLL_MANUAL_ENTRY_KIND_LABELS,
  PAYROLL_NEGATIVE_NET_LABEL,
  PAYROLL_OFFSET_EARNED_LABEL,
  PAYROLL_PROVISIONAL_NOTE,
  type PayrollLine,
  payrollOverriddenText,
  RATE_TYPE_LABELS,
  TIMESHEET_STATUS_LABELS,
} from '@pulse/talent';
import type {
  PayrollBreakdownManualEntry,
  PayrollManualEntryVersion,
  PayrollRunBreakdownView,
} from '@pulse/talent/server';
import { Button } from '@pulse/ui/components/button';
import { ErrorState } from '@pulse/ui/components/error-state';
import { SheetBody, SheetHeader } from '@pulse/ui/components/sheet';
import { Skeleton } from '@pulse/ui/components/skeleton';
import { getPayrollBreakdownAction } from '@/lib/actions/talent-payroll-runs';
import { ManualBadge } from './payroll-badges';
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
//
// Step 2.10 (docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210, "Screens":
// the breakdown sheet): an overridden line reads "Overridden (computed ₱X)", a manual line carries
// "Manual", and a "Manual entries" group lists each entry (label, kind, amount, reason, who and
// when, its earlier values under "History"), with "Add manual entry", "Edit" and "Remove" for the
// server's `canEnterManualEntries` on an editable run. Saving one reloads the breakdown (another
// `reveal`, from that explicit save).

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

/** A line's detail: its quantity and rate, and "Overridden (computed ₱X)" or "Manual entry". */
function breakdownLineDetail(line: PayrollLine): string | null {
  const parts = [
    lineDetailText(line),
    line.override ? payrollOverriddenText(line.override.computedAmountCentavos) : null,
  ].filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join(' · ') : null;
}

const yesNo = (value: boolean | null) => (value ? 'Yes' : 'No');

/** An entry's switches in words: "Taxable · Counts as basic salary". */
function switchesText(entry: PayrollManualEntryVersion): string | null {
  const parts: string[] = [];
  if (entry.kind === 'earning') {
    parts.push(entry.taxable ? 'Taxable' : 'Not taxable');
  }
  if (entry.kind === 'deduction') {
    parts.push(entry.reducesTaxablePay ? 'Reduces taxable pay' : 'After tax');
    if (!entry.reducesTaxablePay) {
      parts.push(`${PAYROLL_AUTHORIZED_IN_WRITING_LABEL}: ${yesNo(entry.authorizedInWriting)}`);
    }
  }
  if (entry.kind !== 'override' && entry.countsAsBasicSalary) parts.push('Counts as basic salary');
  return parts.length > 0 ? parts.join(' · ') : null;
}

const enteredText = (entry: PayrollManualEntryVersion) =>
  `${entry.removed ? 'Removed' : 'Entered'} by ${entry.enteredByName ?? 'someone no longer listed'} · ${formatDateTime(new Date(entry.enteredAt))}`;

/** One version in an entry's History. */
function HistoryVersion({ version }: { version: PayrollManualEntryVersion }) {
  return (
    <li className="flex flex-col gap-0.5 py-2">
      <span className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-footnote font-medium break-words">
          {version.removed ? `Removed · ${version.label}` : version.label}
        </span>
        {version.amountCentavos !== null && !version.removed ? (
          <span className="text-footnote numeric">{pesoText(version.amountCentavos)}</span>
        ) : null}
      </span>
      {switchesText(version) ? (
        <span className="text-footnote break-words text-text-secondary">
          {switchesText(version)}
        </span>
      ) : null}
      <span className="text-footnote break-words text-text-secondary">
        Reason: {version.reason}
      </span>
      <span className="text-footnote text-text-secondary numeric">{enteredText(version)}</span>
    </li>
  );
}

/** One entry chain in the "Manual entries" group. */
function ManualEntryRow({
  entry,
  canEdit,
  onEdit,
  onRemove,
}: {
  entry: PayrollBreakdownManualEntry;
  canEdit: boolean;
  onEdit: (entry: PayrollBreakdownManualEntry) => void;
  onRemove: (entry: PayrollBreakdownManualEntry) => void;
}) {
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-subheadline font-semibold break-words">
              {entry.live ? entry.label : `Removed · ${entry.label}`}
            </span>
            <ManualBadge />
          </span>
          <span className="text-footnote break-words text-text-secondary">
            {[PAYROLL_MANUAL_ENTRY_KIND_LABELS[entry.kind], switchesText(entry)]
              .filter(Boolean)
              .join(' · ')}
          </span>
          {entry.kind === 'override' && entry.computedAmountCentavos !== null ? (
            <span className="text-footnote text-text-secondary numeric">
              {payrollOverriddenText(entry.computedAmountCentavos)}
            </span>
          ) : null}
        </div>
        {entry.amountCentavos !== null && entry.live ? (
          <span className="shrink-0 text-right text-subheadline numeric">
            {pesoText(entry.amountCentavos)}
          </span>
        ) : null}
      </div>
      {entry.staleText ? (
        <p className="flex items-start gap-1.5 text-footnote font-medium text-warning-text">
          <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0" strokeWidth={2} />
          <span>Needs review: {entry.staleText}</span>
        </p>
      ) : null}
      <p className="text-footnote break-words text-text-secondary">Reason: {entry.reason}</p>
      <p className="text-footnote text-text-secondary numeric">{enteredText(entry)}</p>
      {entry.history.length > 0 ? (
        <details className="group">
          <summary className="flex min-h-11 cursor-pointer items-center text-subheadline font-medium text-accent">
            History ({entry.history.length} earlier)
          </summary>
          <ul className="flex flex-col divide-y divide-separator border-t border-separator">
            {entry.history.map((version) => (
              <HistoryVersion key={version.id} version={version} />
            ))}
          </ul>
        </details>
      ) : null}
      {canEdit && entry.live ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="tinted" onClick={() => onEdit(entry)}>
            <Pencil aria-hidden="true" className="size-4.5" />
            Edit
          </Button>
          <Button variant="plain" onClick={() => onRemove(entry)}>
            <Trash2 aria-hidden="true" className="size-4.5" />
            Remove
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** Manual-entry controls the run page hands the breakdown (HR on an editable run). */
export interface BreakdownManualControls {
  onAdd: () => void;
  onEdit: (entry: PayrollBreakdownManualEntry) => void;
  onRemove: (entry: PayrollBreakdownManualEntry) => void;
}

function ManualEntriesGroup({
  view,
  controls,
}: {
  view: PayrollRunBreakdownView;
  controls: BreakdownManualControls | null;
}) {
  const canEdit = controls !== null && view.canEnterManualEntries;
  if (view.manualEntries.length === 0 && !canEdit) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-4 text-footnote font-semibold text-text-secondary">Manual entries</h3>
      {view.manualEntries.length > 0 ? (
        <ul className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
          {view.manualEntries.map((entry) => (
            <ManualEntryRow
              key={entry.id}
              entry={entry}
              canEdit={canEdit}
              onEdit={(chosen) => controls?.onEdit(chosen)}
              onRemove={(chosen) => controls?.onRemove(chosen)}
            />
          ))}
        </ul>
      ) : (
        <p className="px-4 text-footnote text-text-secondary">No manual entries on this line.</p>
      )}
      {canEdit ? (
        <Button variant="tinted" onClick={() => controls?.onAdd()} className="w-full sm:w-fit">
          <Plus aria-hidden="true" className="size-4.5" />
          Add manual entry
        </Button>
      ) : null}
    </section>
  );
}

function BreakdownContent({
  view,
  controls,
}: {
  view: PayrollRunBreakdownView;
  controls: BreakdownManualControls | null;
}) {
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
              detail={breakdownLineDetail(line)}
              value={lineAmountText(line)}
            />
          ))}
        </Section>
      ))}

      <ManualEntriesGroup view={view} controls={controls} />

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
  controls = null,
}: {
  name: string;
  loaded: PayrollBreakdownLoad;
  onRetry: () => void;
  /** "Add manual entry", "Edit" and "Remove" (HR on an editable run), or null. */
  controls?: BreakdownManualControls | null;
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
        {view ? <BreakdownContent view={view} controls={controls} /> : null}
      </SheetBody>
    </>
  );
}
