'use client';

import { type ReactNode, useId } from 'react';
import Link from 'next/link';
import {
  CircleCheck,
  Clock,
  ExternalLink,
  FileText,
  Landmark,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import { formatDateTime } from '@pulse/core';
import {
  PAYROLL_ACKNOWLEDGE_LABEL,
  PAYROLL_DRAFT_NOTE,
  PAYROLL_FISCAL_PLACEHOLDER_TEXT,
  PAYROLL_FLAG_NOT_ACKNOWLEDGEABLE_MESSAGE,
  payrollOverriddenText,
} from '@pulse/talent';
import type {
  PayrollRunApproverView,
  PayrollRunFlagRow,
  PayrollRunManualEntryRow,
  PayrollRunPersonRow,
  PayrollRunView,
} from '@pulse/talent/server';
import { Button, buttonVariants } from '@pulse/ui/components/button';
import type { PayrollManualEntryAmount } from '@/lib/actions/talent-payroll-runs';
import { ManualBadge } from './payroll-badges';
import { pesoText } from './payroll-format';

// Spec: docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 ("Review
// flags", "Manual entries", "The Board's view while approving", "The Fiscal posting placeholder",
// "Screens": `/talent/payroll/<runId>`) and docs/DESIGN_SYSTEM.md#layout--components ("Payroll
// review and payslips on a phone") — the run page's step 2.10 sections, plain (no amount until
// "Show amounts"):
//
// - The status panel under the title: the draft note; on a returned run the Board's remarks in a
//   callout; on a pending run "Waiting for Board approval since <when>" and, for a pending
//   approver, "Approve or return in Approvals" as a link (never decision buttons here); on a
//   finalized run "Finalized <when> by <name>", the payslip count and the Fiscal placeholder.
// - "Needs review": each flag still in the way of a submit, with "Acknowledge" where HR may
//   acknowledge it, or the way to resolve it (a manual entry in the breakdown).
// - "Manual entries": the run's live entries (employee, kind, label, reason, who), each with the
//   "Manual" badge; their amounts (and an override's computed amount) after "Show amounts".

const when = (date: Date | null) => (date ? formatDateTime(new Date(date)) : null);

function Callout({
  tone,
  icon,
  children,
}: {
  tone: 'warning' | 'neutral' | 'success';
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-card bg-surface px-4 py-3 shadow-card">
      <span
        className={
          tone === 'warning'
            ? 'mt-0.5 shrink-0 text-warning-text'
            : tone === 'success'
              ? 'mt-0.5 shrink-0 text-success-text'
              : 'mt-0.5 shrink-0 text-text-secondary'
        }
      >
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
    </div>
  );
}

/** The status panel under the run's title. */
export function RunStatusPanel({
  view,
  approver,
}: {
  view: PayrollRunView;
  approver: PayrollRunApproverView['approver'] | null;
}) {
  const iconClass = 'size-5';
  if (view.status === 'draft') {
    return <p className="text-footnote text-text-secondary">{PAYROLL_DRAFT_NOTE}</p>;
  }
  if (view.status === 'returned') {
    return (
      <Callout
        tone="warning"
        icon={<Undo2 aria-hidden="true" className={iconClass} strokeWidth={2} />}
      >
        <p className="text-subheadline font-semibold">
          Returned
          {view.returnedByName ? ` by ${view.returnedByName}` : ''}
          {view.returnedAt ? (
            <span className="font-normal text-text-secondary numeric">
              {` · ${when(view.returnedAt)}`}
            </span>
          ) : null}
        </p>
        {view.returnRemarks ? (
          <p className="text-subheadline break-words">“{view.returnRemarks}”</p>
        ) : null}
        <p className="text-footnote text-text-secondary">
          {approver
            ? 'HR reviews it and submits it again.'
            : 'Review it as a draft, then submit it again.'}{' '}
          {PAYROLL_DRAFT_NOTE}
        </p>
      </Callout>
    );
  }
  if (view.status === 'pendingApproval') {
    return (
      <Callout tone="neutral" icon={<Clock aria-hidden="true" className={iconClass} />}>
        <p className="text-subheadline font-semibold numeric">
          Waiting for Board approval{view.submittedAt ? ` since ${when(view.submittedAt)}` : ''}
        </p>
        {view.submittedByName ? (
          <p className="text-footnote text-text-secondary">Submitted by {view.submittedByName}</p>
        ) : null}
        {approver?.pending && approver.approvalHref ? (
          <Link
            href={approver.approvalHref}
            className={buttonVariants({ variant: 'tinted', className: 'mt-1 w-full sm:w-fit' })}
          >
            <ExternalLink aria-hidden="true" className="size-4.5" />
            {approver.approveInApprovalsLabel}
          </Link>
        ) : (
          <p className="text-footnote text-text-secondary">
            Nothing can change while it waits. A Board member approves or returns it in Approvals.
          </p>
        )}
      </Callout>
    );
  }
  // Finalized.
  const total = view.employeeCount;
  return (
    <Callout
      tone="success"
      icon={<CircleCheck aria-hidden="true" className={iconClass} strokeWidth={2} />}
    >
      <p className="text-subheadline font-semibold numeric">
        Finalized{view.finalizedAt ? ` ${when(view.finalizedAt)}` : ''}
        {view.finalizedByName ? ` by ${view.finalizedByName}` : ''}
      </p>
      {approver ? null : (
        <p className="flex items-start gap-1.5 text-footnote text-text-secondary numeric">
          <FileText aria-hidden="true" className="mt-px size-4 shrink-0" />
          <span>{`Payslips: ${Math.min(view.payslipsReadyCount, total)} of ${total} ready`}</span>
        </p>
      )}
      <p className="flex items-start gap-1.5 text-footnote text-text-secondary">
        <Landmark aria-hidden="true" className="mt-px size-4 shrink-0" />
        <span>{PAYROLL_FISCAL_PLACEHOLDER_TEXT}</span>
      </p>
      {approver?.approvalHref ? (
        <Link
          href={approver.approvalHref}
          className="w-fit text-footnote font-semibold text-accent underline underline-offset-2"
        >
          Open in Approvals
        </Link>
      ) : null}
    </Callout>
  );
}

/** "Needs review": each flag still in the way of a submit, with "Acknowledge" where it applies. */
export function NeedsReview({
  people,
  canAcknowledge,
  onAcknowledge,
  onOpen,
}: {
  people: PayrollRunPersonRow[];
  canAcknowledge: boolean;
  onAcknowledge: (
    person: PayrollRunPersonRow,
    flag: PayrollRunFlagRow,
    trigger: HTMLElement,
  ) => void;
  /** Opens the person's breakdown (a `reveal`), or null when there is none. */
  onOpen: ((person: PayrollRunPersonRow, trigger: HTMLElement) => void) | null;
}) {
  const titleId = useId();
  const rows = people.flatMap((person) =>
    person.flags.filter((flag) => flag.unresolved).map((flag) => ({ person, flag })),
  );
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <h2 id={titleId} className="px-4 text-footnote font-semibold text-text-secondary">
        Needs review before submitting
      </h2>
      <ul className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
        {rows.map(({ person, flag }) => (
          <li
            key={`${person.lineId}:${flag.kind}`}
            className="flex min-h-16 flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between md:px-5"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-subheadline font-semibold break-words">{person.name}</span>
              <span className="flex items-start gap-1.5 text-footnote font-medium break-words text-warning-text">
                <TriangleAlert
                  aria-hidden="true"
                  className="mt-px size-4 shrink-0"
                  strokeWidth={2}
                />
                <span>
                  <span className="numeric">{person.employeeNumber}</span> · {flag.text}
                </span>
              </span>
              {flag.acknowledgeable ? null : (
                <span className="text-footnote text-text-secondary">
                  {PAYROLL_FLAG_NOT_ACKNOWLEDGEABLE_MESSAGE}
                </span>
              )}
            </span>
            {flag.acknowledgeable && canAcknowledge ? (
              <Button
                variant="tinted"
                onClick={(event) => onAcknowledge(person, flag, event.currentTarget)}
                aria-label={`${PAYROLL_ACKNOWLEDGE_LABEL}: ${person.name}, ${flag.text}`}
                className="w-full shrink-0 sm:w-auto"
              >
                {PAYROLL_ACKNOWLEDGE_LABEL}
              </Button>
            ) : !flag.acknowledgeable && onOpen ? (
              <Button
                variant="plain"
                onClick={(event) => onOpen(person, event.currentTarget)}
                aria-label={`Open the breakdown for ${person.name}`}
                className="w-full shrink-0 text-accent sm:w-auto"
              >
                Open breakdown
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Manual entries": the run's live entries, plain until "Show amounts". */
export function RunManualEntries({
  entries,
  amounts,
  amountsShown,
  first = false,
}: {
  entries: PayrollRunManualEntryRow[];
  amounts: Map<string, PayrollManualEntryAmount>;
  amountsShown: boolean;
  /** The Board's view lists them first, and says so when there are none. */
  first?: boolean;
}) {
  const titleId = useId();
  if (entries.length === 0 && !first) return null;
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <h2 id={titleId} className="px-4 text-footnote font-semibold text-text-secondary">
        Manual entries
      </h2>
      {entries.length === 0 ? (
        <p className="rounded-card bg-surface px-4 py-3 text-subheadline text-text-secondary shadow-card">
          No manual entries in this run.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
          {entries.map((entry) => {
            const amount = amounts.get(entry.id) ?? null;
            return (
              <li key={entry.id} className="flex min-h-16 flex-col gap-1 px-4 py-3 md:px-5">
                <span className="flex items-start justify-between gap-3">
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-subheadline font-semibold break-words">
                        {entry.label}
                      </span>
                      <ManualBadge />
                    </span>
                    <span className="text-footnote break-words text-text-secondary">
                      {entry.name} · <span className="numeric">{entry.employeeNumber}</span> ·{' '}
                      {entry.kindLabel}
                      {entry.edited ? ' · Edited' : ''}
                    </span>
                  </span>
                  {amountsShown && amount ? (
                    <span className="shrink-0 text-right text-subheadline numeric">
                      {pesoText(amount.amountCentavos)}
                    </span>
                  ) : null}
                </span>
                {amountsShown && amount && amount.computedAmountCentavos !== null ? (
                  <span className="text-footnote text-text-secondary numeric">
                    {payrollOverriddenText(amount.computedAmountCentavos)}
                  </span>
                ) : null}
                {entry.staleText ? (
                  <span className="flex items-start gap-1.5 text-footnote font-medium text-warning-text">
                    <TriangleAlert
                      aria-hidden="true"
                      className="mt-px size-4 shrink-0"
                      strokeWidth={2}
                    />
                    <span>Needs review: {entry.staleText}</span>
                  </span>
                ) : null}
                <span className="text-footnote break-words text-text-secondary">
                  Reason: {entry.reason}
                </span>
                <span className="text-footnote text-text-secondary numeric">
                  Entered by {entry.enteredByName ?? 'someone no longer listed'} ·{' '}
                  {when(entry.enteredAt)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
