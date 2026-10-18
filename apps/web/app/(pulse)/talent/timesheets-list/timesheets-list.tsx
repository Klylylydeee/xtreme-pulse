'use client';

import { useId, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  CalendarClock,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock,
  Search,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { formatDate, TIMESHEET_TYPE_LABELS } from '@pulse/core';
import {
  SUBMITTED_LATE_LABEL,
  TIMESHEET_LIST_FILTER_LABELS,
  TIMESHEET_LIST_FILTERS,
  type TimesheetListFilter,
  type TimesheetListRowView,
  type TimesheetListView,
} from '@pulse/talent';
import { cn } from '@pulse/ui';
import { Button, buttonVariants } from '@pulse/ui/components/button';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { Select } from '@pulse/ui/components/form';
import { PageHeader } from '@pulse/ui/components/page-header';
import { Badge, plural } from '@/components/org-structure';

// Spec: docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27
// ("Screens", `/talent/timesheets`), decision 294 in docs/BUILD_PLAN.md and
// docs/DESIGN_SYSTEM.md#layout--components ("The timesheets list") — the timesheets list: the
// cut-off picker (ended cut-offs, newest first), then the status tiles (Not submitted, Waiting
// for supervisor, Waiting for HR, Returned, Approved), each a filter (`?status=`, a second press
// shows everyone), then a list of people, never a table: name with "Submitted late", employee
// number, department and timesheet type, and the status in words with its icon, so color is never
// the only signal. A row opens `/talent/timesheets/<employeeId>?cutOff=<period start>`. The server
// filters and counts; the tiles count every row whatever the filter.

const countFormat = new Intl.NumberFormat('en-PH');

const DESCRIPTION = 'Everyone’s timesheet status for a cut-off, with who still has to submit.';

/** The tone and icon of a row's status: returned warns, overdue is destructive, approved succeeds. */
function statusLook(row: TimesheetListRowView): { Icon: LucideIcon; className: string } {
  if (row.filter === 'approved') return { Icon: CircleCheck, className: 'text-success-text' };
  if (row.filter === 'returned') return { Icon: Undo2, className: 'text-warning-text' };
  if (row.filter === 'notSubmitted') {
    return row.overdue
      ? { Icon: CircleAlert, className: 'text-destructive-text' }
      : { Icon: CircleDashed, className: 'text-text-secondary' };
  }
  return { Icon: Clock, className: 'text-text-secondary' };
}

function TimesheetRow({ row }: { row: TimesheetListRowView }) {
  const { Icon, className } = statusLook(row);
  const details = [row.department, TIMESHEET_TYPE_LABELS[row.timesheetType]]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="rounded-card bg-surface shadow-card md:rounded-none md:bg-transparent md:shadow-none">
      <Link
        href={row.href}
        aria-label={[
          `${row.name}’s timesheet`,
          row.statusText,
          row.submittedLate ? SUBMITTED_LATE_LABEL : null,
        ]
          .filter(Boolean)
          .join(', ')}
        className={cn(
          'flex min-h-16 w-full items-center gap-3 rounded-card px-4 py-3 transition-colors duration-fast',
          'hover:bg-bg-grouped/60 focus-visible:outline-offset-[-2px] md:rounded-none md:px-5',
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 md:flex-row md:items-center md:gap-6">
          <span className="flex min-w-0 flex-col gap-0.5 md:flex-1">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 text-subheadline font-semibold break-words">{row.name}</span>
              {row.submittedLate ? <Badge>{SUBMITTED_LATE_LABEL}</Badge> : null}
            </span>
            <span className="text-footnote break-words text-text-secondary">
              <span className="numeric">{row.employeeNumber}</span>
              {details ? ` · ${details}` : null}
            </span>
          </span>
          <span
            className={cn(
              'flex items-center gap-1.5 text-footnote font-medium md:w-52 md:shrink-0',
              className,
            )}
          >
            <Icon aria-hidden="true" className="size-4 shrink-0" />
            {row.statusText}
          </span>
        </span>
        <ChevronRight aria-hidden="true" className="size-4.5 shrink-0 text-text-tertiary" />
      </Link>
    </li>
  );
}

export function TimesheetsList({ view }: { view: TimesheetListView }) {
  const router = useRouter();
  const pathname = usePathname();
  const [loading, startLoading] = useTransition();
  const cutOffId = useId();
  const tilesId = useId();
  const total = TIMESHEET_LIST_FILTERS.reduce((sum, filter) => sum + view.counts[filter], 0);

  function setParams(changes: Record<string, string | null>) {
    const params = new URLSearchParams(window.location.search);
    for (const [name, value] of Object.entries(changes)) {
      if (value) params.set(name, value);
      else params.delete(name);
    }
    const next = params.toString();
    startLoading(() => {
      router.replace(`${pathname}${next ? `?${next}` : ''}`, { scroll: false });
    });
  }

  function toggleFilter(filter: TimesheetListFilter) {
    setParams({ cutOff: view.cutOff.periodStart, status: view.filter === filter ? null : filter });
  }

  return (
    <>
      <PageHeader title="Timesheets" description={DESCRIPTION} />

      <div className="flex flex-col gap-1.5">
        <label htmlFor={cutOffId} className="text-footnote font-semibold text-text-secondary">
          Cut-off
        </label>
        <div className="flex flex-col gap-x-4 gap-y-1.5 sm:flex-row sm:items-center">
          <Select
            id={cutOffId}
            value={view.cutOff.periodStart}
            onChange={(event) => setParams({ cutOff: event.target.value })}
            disabled={loading}
            aria-busy={loading || undefined}
            className="w-full sm:w-64"
          >
            {view.cutOffs.map((option) => (
              <option key={option.periodStart} value={option.periodStart}>
                {option.label}
              </option>
            ))}
          </Select>
          <p className="text-footnote text-text-secondary">
            Due <span className="numeric">{formatDate(view.deadline)}</span>
          </p>
        </div>
      </div>

      <section aria-labelledby={tilesId} className="flex flex-col gap-2">
        <h2 id={tilesId} className="sr-only">
          Timesheets by status, {countFormat.format(total)} in all
        </h2>
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {TIMESHEET_LIST_FILTERS.map((filter) => {
            const label = TIMESHEET_LIST_FILTER_LABELS[filter];
            const count = view.counts[filter];
            const pressed = view.filter === filter;
            return (
              <li key={filter} className="flex min-w-0">
                <button
                  type="button"
                  onClick={() => toggleFilter(filter)}
                  disabled={loading}
                  aria-pressed={pressed}
                  aria-label={`${label}: ${countFormat.format(count)}. ${
                    pressed ? 'Show everyone' : 'Show only these timesheets'
                  }`}
                  className={cn(
                    'flex min-w-0 flex-1 flex-col gap-1 rounded-card bg-surface p-4 text-left shadow-card md:p-5',
                    'hover:bg-accent-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                    'disabled:cursor-progress',
                    pressed && 'ring-2 ring-accent',
                  )}
                >
                  <span className="text-subheadline font-semibold text-text-secondary">
                    {label}
                  </span>
                  <span className="numeric text-display">{countFormat.format(count)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="numeric text-footnote text-text-secondary">
          {view.filter
            ? `${plural(view.rows.length, 'employee', 'employees')} · ${
                TIMESHEET_LIST_FILTER_LABELS[view.filter]
              }`
            : plural(view.rows.length, 'employee', 'employees')}
        </p>
        {view.filter ? (
          <Button
            variant="plain"
            onClick={() => setParams({ status: null })}
            disabled={loading}
            className="min-h-11"
          >
            Show everyone
          </Button>
        ) : null}
      </div>

      <div
        className={cn('flex min-w-0 flex-col gap-4', loading && 'opacity-60')}
        aria-busy={loading || undefined}
      >
        {view.rows.length > 0 ? (
          <ul
            aria-label={`Timesheets for ${view.cutOff.label}`}
            className="flex flex-col gap-2 md:gap-0 md:divide-y md:divide-separator md:overflow-hidden md:rounded-card md:bg-surface md:shadow-card"
          >
            {view.rows.map((row) => (
              <TimesheetRow key={row.employeeId} row={row} />
            ))}
          </ul>
        ) : view.filter ? (
          <EmptyState
            icon={<Search strokeWidth={1.75} />}
            title={`None ${TIMESHEET_LIST_FILTER_LABELS[view.filter].toLowerCase()}`}
            description={`No timesheet for ${view.cutOff.label} is in this status.`}
            action={
              <Button variant="tinted" onClick={() => setParams({ status: null })}>
                Show everyone
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={<CalendarClock strokeWidth={1.75} />}
            title="No one to list"
            description={`No employee was employed during ${view.cutOff.label}.`}
          />
        )}
      </div>
    </>
  );
}

/**
 * When the service returns no list: the asked cut-off isn't an ended one (an old or mistyped link),
 * or no cut-off has ended yet.
 */
export function TimesheetsListUnavailable({ askedCutOff }: { askedCutOff: boolean }) {
  return (
    <>
      <PageHeader title="Timesheets" description={DESCRIPTION} />
      {askedCutOff ? (
        <EmptyState
          icon={<CalendarClock strokeWidth={1.75} />}
          title="This cut-off isn’t in the list"
          description="The list shows cut-offs that have ended. Open the latest one instead."
          action={
            <Link href="/talent/timesheets" className={buttonVariants({ variant: 'tinted' })}>
              Show the latest cut-off
            </Link>
          }
        />
      ) : (
        <EmptyState
          icon={<CalendarClock strokeWidth={1.75} />}
          title="No cut-off has ended yet"
          description="Timesheets show up here once their cut-off ends and submission opens."
        />
      )}
    </>
  );
}
