import { CalendarDays } from 'lucide-react';
import { formatTime } from '@pulse/core';
import {
  DTR_DAY_STATUS_LABELS,
  DTR_TIME_OFF_STATUSES,
  type DtrDay,
  dtrTimeOffLabel,
  formatDayCount,
  formatHours,
  ISO_WEEKDAY_SHORT_LABELS,
  type TimesheetDtrSegmentView,
} from '@pulse/talent';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { DtrStatusBadge, DtrTimeOffBadge, PreviewBadge } from './badges';
import { dayOfMonth, longDayText } from './format';

// Spec: docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27
// ("The Daily Time Record", "Screens") and docs/DESIGN_SYSTEM.md#layout--components ("Timesheets
// on a phone": the DTR segment) — the third segment, "DTR": one row per day, newest first (the
// server orders them), at least 64px tall, as a list, never a table. Each row has the date tile,
// the status as a text badge (Present, Absent (unpaid), Rest day, Holiday), the first time in, and
// on the right the late and undertime minutes, night differential, and overtime or offset in
// tabular numerals. A day whose timesheet isn't approved carries "Not approved yet". The DTR is
// derived when read, never stored. The totals sit in the sticky footer (`DtrFooter`) while the
// segment shows.
//
// Step 2.8 (docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28, "On
// the DTR"; decision 315): a day's approved time off shows as text badges ("On leave (paid) · VL",
// "Half day VL (paid)", "Offset (paid) 4.0 h", "Leave without pay" in `warning-text`); a day the
// time off covers in full shows those badges in place of its status, a partly covered day its
// status beside them, with its absent minutes beside late and undertime. The footer adds the paid
// leave, leave without pay, offset used and absent minutes when there are any.

function minutesText(minutes: number): string {
  return `${minutes} min`;
}

/** Days in whole or half days (0.5, 1, 1.5): "1.5 days". */
function daysText(days: number): string {
  return formatDayCount(Math.round(days * 2));
}

/** The day's figures on the right; only the ones above zero. */
function DayFigures({ day }: { day: DtrDay }) {
  const lines: { label: string; value: string; strong?: boolean; warn?: boolean }[] = [];
  if (day.lateMinutes > 0) {
    lines.push({ label: 'Late', value: minutesText(day.lateMinutes), warn: true });
  }
  if (day.undertimeMinutes > 0) {
    lines.push({ label: 'Undertime', value: minutesText(day.undertimeMinutes), warn: true });
  }
  if (day.absentMinutes > 0) {
    lines.push({ label: 'Absent', value: minutesText(day.absentMinutes), warn: true });
  }
  if (day.nightDifferentialMinutes > 0) {
    lines.push({ label: 'Night diff.', value: formatHours(day.nightDifferentialMinutes) });
  }
  if (day.treatment === 'overtime' && day.overtime.totalMinutes > 0) {
    lines.push({ label: 'OT', value: formatHours(day.overtime.totalMinutes), strong: true });
  }
  if (day.treatment === 'offset' && day.offsetMinutes > 0) {
    lines.push({ label: 'Offset', value: formatHours(day.offsetMinutes), strong: true });
  }
  if (lines.length === 0) {
    if (day.workedMinutes <= 0) return null;
    lines.push({ label: 'Worked', value: formatHours(day.workedMinutes) });
  }
  return (
    <dl className="flex shrink-0 flex-col items-end gap-0.5 text-right">
      {lines.map((line) => (
        <div key={line.label} className="flex items-baseline gap-1.5">
          <dt className="text-footnote text-text-secondary">{line.label}</dt>
          <dd
            className={
              line.strong
                ? 'text-subheadline font-semibold numeric'
                : line.warn
                  ? 'text-footnote font-medium text-warning-text numeric'
                  : 'text-footnote numeric'
            }
          >
            {line.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Whether the day's status is its time off's (covered in full), so the badges stand for it. */
function statusIsTimeOff(day: DtrDay): boolean {
  return (
    day.timeOff.length > 0 && (DTR_TIME_OFF_STATUSES as readonly string[]).includes(day.status)
  );
}

function DtrRow({ day }: { day: DtrDay }) {
  const holiday = day.holidayNames.join(', ');
  const timeOffOnly = statusIsTimeOff(day);
  const spoken = [
    ...(timeOffOnly ? [] : [DTR_DAY_STATUS_LABELS[day.status]]),
    ...day.timeOff.map(dtrTimeOffLabel),
  ].join(', ');
  return (
    <div className="flex min-h-16 items-center gap-3 px-4 py-3">
      <span
        aria-hidden="true"
        className="flex size-12 shrink-0 flex-col items-center justify-center rounded-lg bg-accent-subtle text-accent"
      >
        <span className="text-caption font-medium uppercase">
          {ISO_WEEKDAY_SHORT_LABELS[day.weekday]}
        </span>
        <span className="text-headline leading-none numeric">{dayOfMonth(day.date)}</span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="sr-only">
          {longDayText(day.date)}, {spoken}
        </span>
        <span aria-hidden="true" className="flex flex-wrap items-center gap-1.5">
          {timeOffOnly ? null : <DtrStatusBadge status={day.status} />}
          {day.timeOff.map((part) => (
            <DtrTimeOffBadge key={`${part.requestId}-${part.portion}`} part={part} />
          ))}
        </span>
        {day.firstTimeIn ? (
          <span className="text-footnote text-text-secondary numeric">
            In {formatTime(day.firstTimeIn)}
          </span>
        ) : null}
        {holiday ? (
          <span className="truncate text-footnote text-text-secondary">{holiday}</span>
        ) : null}
        {day.final ? null : (
          <span className="flex">
            <PreviewBadge />
          </span>
        )}
      </span>
      <DayFigures day={day} />
    </div>
  );
}

export function DtrList({ dtr }: { dtr: TimesheetDtrSegmentView }) {
  if (dtr.days.length === 0) {
    return (
      <EmptyState
        icon={<CalendarDays strokeWidth={1.75} />}
        title="No days yet"
        description="This cut-off has no days on the DTR yet."
      />
    );
  }
  return (
    <ul
      aria-label="Daily Time Record"
      className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card"
    >
      {dtr.days.map((day) => (
        <li key={day.date}>
          <DtrRow day={day} />
        </li>
      ))}
    </ul>
  );
}

/** The DTR's totals in the sticky glass footer while the segment shows. */
export function DtrFooter({ dtr }: { dtr: TimesheetDtrSegmentView }) {
  const { totals } = dtr;
  const overtime = dtr.treatment === 'overtime';
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 flex-col">
          <span className="text-footnote text-text-secondary">
            {overtime ? 'DTR · Total overtime' : 'DTR · Offset'}
          </span>
          {dtr.final ? null : (
            <span className="text-footnote text-text-secondary">Not approved yet</span>
          )}
        </span>
        <span className="text-title-2 numeric">
          {formatHours(overtime ? totals.totalOvertimeMinutes : totals.offsetMinutes)}
        </span>
      </div>
      <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-footnote text-text-secondary numeric">
        <span>Present {totals.days.present}</span>
        <span>Absent {totals.days.absentUnpaid}</span>
        <span>
          Late {totals.lateDays} ({minutesText(totals.lateMinutes)})
        </span>
        <span>Undertime {minutesText(totals.undertimeMinutes)}</span>
        {totals.nightDifferentialMinutes > 0 ? (
          <span>Night diff. {formatHours(totals.nightDifferentialMinutes)}</span>
        ) : null}
        {totals.absentMinutes > 0 ? <span>Absent {minutesText(totals.absentMinutes)}</span> : null}
        {totals.paidLeaveDays > 0 ? <span>Paid leave {daysText(totals.paidLeaveDays)}</span> : null}
        {totals.leaveWithoutPayDays > 0 ? (
          <span className="text-warning-text">
            Leave without pay {daysText(totals.leaveWithoutPayDays)}
          </span>
        ) : null}
        {totals.offsetMinutesUsed > 0 ? (
          <span>Offset used {formatHours(totals.offsetMinutesUsed)}</span>
        ) : null}
      </p>
    </div>
  );
}
