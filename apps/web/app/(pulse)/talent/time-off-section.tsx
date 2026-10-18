'use client';

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { CalendarDays, ClipboardList, Plus, TriangleAlert } from 'lucide-react';
import { formatDate } from '@pulse/core';
import {
  formatLeaveDays,
  formatOffsetHours,
  formatSignedLeaveDays,
  LEAVE_ENTRY_KIND_LABELS,
  type LeaveBalancesView,
  type LeaveEntryView,
  leaveBalanceLines,
  offsetAvailableText,
  type OffsetAvailableBalanceView,
  regularizationMissingText,
} from '@pulse/talent';
import { cn } from '@pulse/ui';
import { Button, buttonVariants } from '@pulse/ui/components/button';
import { getTimeOffSectionAction } from '@/lib/actions/talent-opening-balances';
import { OPENING_BALANCES_HREF } from '@/lib/navigation';
import { PayrollOpeningCards } from './employee-record-sections';
import { BlockStatus, usePayrollOpening } from './opening-balances/opening-balance-sheets';
import { RecordCard, RecordSection, Row } from './record-ui';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Screens":
// the employee inspector's Time off section; "Who may see what") — two blocks of the `/talent`
// inspector that load on their own beside the record, so a failure never blanks it:
//
// - **Time off** (Talent Read; the service checks again and hides a confidential type from anyone
//   but the employee, HR and the System Administrator): each credited balance (VL, SL) with what
//   pending requests hold, offset, the per-year types used this year, the regularization flag,
//   and the latest leave entries. "Time off" opens `/talent/time-off/<employeeId>`. For HR and the
//   System Administrator with Talent Write, never on their own record (`canCorrect`): "Enter
//   opening balances" (the opening balances page, this employee's sheet) and "Add correction"
//   (`onCorrect`, a sheet beside the panel). Balances aren't sensitive.
// - **Year-to-date pay at go-live** (the Compensation section's end): only for a viewer who may
//   reveal `salary`, masked until revealed (audit-logged); "Enter" or "Correct" opens the opening
//   balances page when the server's `canEnter` allows it.

const LOAD_FAILED = 'Time off couldn’t load. Check your connection and try again.';

/** The Time off section's data, as `getTimeOffSectionAction` answers it. */
export interface TimeOffSectionData {
  leave: LeaveBalancesView;
  offset: OffsetAvailableBalanceView;
  entries: LeaveEntryView[];
  canCorrect: boolean;
}

type TimeOffState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; data: TimeOffSectionData | null };

/** The Time off section, loaded on its own beside the record. */
export function useTimeOffSection(employeeId: string | null, session: number) {
  const [state, setState] = useState<TimeOffState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  const key = employeeId ? `${employeeId}:${session}` : null;
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (key !== loadedFor) {
    setLoadedFor(key);
    setState({ status: 'loading' });
  }

  useEffect(() => {
    if (!employeeId) return;
    let current = true;
    getTimeOffSectionAction(null, { employeeId })
      .then((result) => {
        if (!current) return;
        if (!result.ok) setState({ status: 'error', message: result.formError ?? LOAD_FAILED });
        else setState({ status: 'done', data: result.data });
      })
      .catch(() => {
        if (current) setState({ status: 'error', message: LOAD_FAILED });
      });
    return () => {
      current = false;
    };
  }, [employeeId, session, attempt]);

  return { state, reload: () => setAttempt((count) => count + 1) };
}

const openingHref = (employeeId: string) =>
  `${OPENING_BALANCES_HREF}?employee=${encodeURIComponent(employeeId)}`;

function EntryRow({ entry, shortName }: { entry: LeaveEntryView; shortName: string }) {
  return (
    <li className="flex flex-col gap-0.5 px-4 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-subheadline">
          {shortName} · {LEAVE_ENTRY_KIND_LABELS[entry.kind]}
        </span>
        <span
          className={cn(
            'numeric text-subheadline font-medium',
            entry.halfDays < 0 ? 'text-text-primary' : 'text-success-text',
          )}
        >
          {formatSignedLeaveDays(entry.halfDays)}
        </span>
      </div>
      <span className="numeric text-footnote text-text-secondary">
        {formatDate(entry.effectiveOn)}
      </span>
      {entry.reason ? (
        <span className="text-footnote break-words text-text-primary">{entry.reason}</span>
      ) : null}
    </li>
  );
}

/** The inspector's Time off section, or its skeleton or error while it loads. */
export function TimeOffBlock({
  state,
  onRetry,
  employeeId,
  name,
  onCorrect,
}: {
  state: TimeOffState;
  onRetry: () => void;
  employeeId: string;
  name: string;
  onCorrect: (data: TimeOffSectionData) => void;
}) {
  const entriesId = useId();
  if (state.status !== 'done') {
    return <BlockStatus state={state} what="time off" onRetry={onRetry} />;
  }
  const data = state.data;
  if (!data) return null;
  const { leave, offset, entries, canCorrect } = data;
  const shortNames = new Map(leave.balances.map((balance) => [balance.typeKey, balance.shortName]));
  const offsetAvailable = offsetAvailableText(offset);

  return (
    <RecordSection
      title="Time off"
      action={
        canCorrect ? (
          <Button variant="plain" onClick={() => onCorrect(data)}>
            <Plus aria-hidden="true" className="size-4.5" />
            Add correction
          </Button>
        ) : null
      }
    >
      {leave.regularizationDateMissing ? (
        <p className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-footnote font-medium text-warning-text shadow-card">
          <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
          <span>{regularizationMissingText(leave.balances.map((b) => b.shortName))}</span>
        </p>
      ) : null}
      <RecordCard footer="Balances come from dated entries: openings, credits, carry-over, leave taken and corrections.">
        {leave.balances.map((balance) => {
          const lines = leaveBalanceLines(balance);
          return (
            <Row key={balance.typeKey} term={`${balance.name} (${balance.shortName})`}>
              <span className="numeric font-medium">{lines.balance}</span>
              {lines.available ? (
                <span className="numeric block text-footnote text-text-secondary">
                  {lines.available}
                </span>
              ) : null}
            </Row>
          );
        })}
        <Row term="Offset">
          <span className="numeric font-medium">{formatOffsetHours(offset.balanceMinutes)}</span>
          {offsetAvailable ? (
            <span className="numeric block text-footnote text-text-secondary">
              {offsetAvailable}
            </span>
          ) : null}
        </Row>
        {leave.perYear.map((usage) => (
          <Row key={usage.typeKey} term={`${usage.name} (${usage.shortName}) in ${usage.year}`}>
            <span className="numeric">
              {formatLeaveDays(usage.usedHalfDays)} used of {formatLeaveDays(usage.limitHalfDays)}
            </span>
          </Row>
        ))}
      </RecordCard>

      {entries.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 id={entriesId} className="px-4 text-footnote font-semibold text-text-secondary">
            Latest leave entries
          </h4>
          <ol
            aria-labelledby={entriesId}
            className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card"
          >
            {entries.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                shortName={shortNames.get(entry.typeKey) ?? entry.typeKey}
              />
            ))}
          </ol>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Link
          href={`/talent/time-off/${employeeId}`}
          className={buttonVariants({ variant: 'tinted' })}
          aria-label={`Time off for ${name}`}
        >
          <CalendarDays aria-hidden="true" className="size-4.5" />
          Time off
        </Link>
        {canCorrect ? (
          <Link
            href={openingHref(employeeId)}
            className={buttonVariants({ variant: 'secondary' })}
            aria-label={`Enter opening balances for ${name}`}
          >
            <ClipboardList aria-hidden="true" className="size-4.5" />
            Enter opening balances
          </Link>
        ) : null}
      </div>
    </RecordSection>
  );
}

/** Year-to-date pay at go-live in the Compensation section; nothing for other viewers. */
export function PayrollOpeningBlock({
  state,
  onRetry,
  employeeId,
}: {
  state: ReturnType<typeof usePayrollOpening>['state'];
  onRetry: () => void;
  employeeId: string;
}) {
  if (state.status !== 'done') {
    return <BlockStatus state={state} what="year-to-date pay" onRetry={onRetry} />;
  }
  if (!state.data) return null;
  const { section, fields } = state.data;
  return (
    <PayrollOpeningCards
      section={section}
      fields={fields}
      action={
        section.canEnter ? (
          <Link
            href={openingHref(employeeId)}
            className={buttonVariants({ variant: 'plain' })}
            aria-label={section.current ? 'Correct year-to-date pay' : 'Enter year-to-date pay'}
          >
            {section.current ? 'Correct' : 'Enter'}
          </Link>
        ) : null
      }
    />
  );
}
