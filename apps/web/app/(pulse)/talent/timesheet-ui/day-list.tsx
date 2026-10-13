'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatTime } from '@pulse/core';
import {
  formatHours,
  ISO_WEEKDAY_SHORT_LABELS,
  type TimeEntryView,
  type TimesheetDayView,
} from '@pulse/talent';
import { cn } from '@pulse/ui/lib/utils';
import { DayKindBadge, ManualBadge, NotClaimedBadge, NoTimeOutBadge } from './badges';
import { dayOfMonth, longDayText, shortDayText } from './format';

// Spec: docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24 ("Day list")
// and docs/DESIGN_SYSTEM.md#layout--components ("Timesheets on a phone": Day rows) — one row per
// day from the date hired up to today, newest first, at least 72px tall: a date tile, the times
// with a "Manual" badge on each manual side, the activity and client on one truncated line, and
// the day's hours on the right ("OT 2.0 h" over "Ordinary day", or "Offset 2.6 h"). Rest days and
// holidays carry their label, "Not claimed" and "No time out" are text badges, and a run of empty
// rest days folds into one row that opens to show them. A list, never a table.

type Row =
  | { kind: 'day'; day: TimesheetDayView }
  | {
      kind: 'restRun';
      /** Newest first. */
      days: TimesheetDayView[];
      newest: TimesheetDayView;
      oldest: TimesheetDayView;
    };

function isEmptyRestDay(day: TimesheetDayView): boolean {
  return day.hours.kind === 'restDay' && day.entries.length === 0;
}

/** Newest first, with each run of two or more empty rest days folded into one row. */
function rowsOf(days: readonly TimesheetDayView[]): Row[] {
  const rows: Row[] = [];
  let run: TimesheetDayView[] = [];
  const flush = () => {
    const [newest] = run;
    const oldest = run.at(-1);
    if (newest && oldest && run.length > 1)
      rows.push({ kind: 'restRun', days: run, newest, oldest });
    else if (newest) rows.push({ kind: 'day', day: newest });
    run = [];
  };
  for (const day of [...days].reverse()) {
    if (isEmptyRestDay(day)) {
      run.push(day);
      continue;
    }
    flush();
    rows.push({ kind: 'day', day });
  }
  flush();
  return rows;
}

/** "8:00 AM [Manual] – 7:00 PM", with "No time out" on an open entry. */
export function EntryTimes({ entry }: { entry: TimeEntryView }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1 numeric">
      <span>{formatTime(entry.timeIn)}</span>
      {entry.timeInSource === 'manual' ? <ManualBadge /> : null}
      <span aria-hidden="true">–</span>
      <span className="sr-only">to</span>
      {entry.timeOut ? (
        <>
          <span>{formatTime(entry.timeOut)}</span>
          {entry.endsNextDay ? (
            <span className="text-footnote text-text-secondary">next day</span>
          ) : null}
          {entry.timeOutSource === 'manual' ? <ManualBadge /> : null}
        </>
      ) : (
        <NoTimeOutBadge />
      )}
    </span>
  );
}

/** The day's hours on the right: overtime by kind, offset, or the worked hours. */
function DayHours({ day }: { day: TimesheetDayView }) {
  const { hours } = day;
  if (hours.treatment === 'overtime' && hours.overtime.totalMinutes > 0) {
    return (
      <span className="flex flex-col items-end text-right">
        <span className="text-subheadline font-semibold numeric">
          OT {formatHours(hours.overtime.totalMinutes)}
        </span>
        <span className="text-footnote text-text-secondary">{day.kindLabel}</span>
      </span>
    );
  }
  if (hours.treatment === 'offset' && hours.offsetMinutes > 0) {
    return (
      <span className="text-subheadline font-semibold numeric">
        Offset {formatHours(hours.offsetMinutes)}
      </span>
    );
  }
  if (hours.workedMinutes > 0) {
    return (
      <span className="flex flex-col items-end text-right">
        <span className="text-subheadline numeric">{formatHours(hours.workedMinutes)}</span>
        <span className="text-footnote text-text-secondary">Worked</span>
      </span>
    );
  }
  return null;
}

/** The weekday and day number in an `accent-subtle` rounded square. */
function DateTile({ day }: { day: TimesheetDayView }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-12 shrink-0 flex-col items-center justify-center rounded-lg bg-accent-subtle text-accent"
    >
      <span className="text-caption font-medium uppercase">
        {ISO_WEEKDAY_SHORT_LABELS[day.hours.weekday]}
      </span>
      <span className="text-headline leading-none numeric">{dayOfMonth(day.hours.date)}</span>
    </span>
  );
}

/** The day's labels: its kind when not ordinary, holidays, Not claimed. */
export function DayLabels({ day }: { day: TimesheetDayView }) {
  const { hours } = day;
  const labels = [
    hours.kind !== 'ordinary' ? <DayKindBadge key="kind">{day.kindLabel}</DayKindBadge> : null,
    ...hours.holidayNames.map((name) => (
      <span key={`holiday-${name}`} className="text-footnote text-text-secondary">
        {name}
      </span>
    )),
    ...hours.localHolidayNames.map((name) => (
      <span key={`local-${name}`} className="text-footnote text-text-secondary">
        {name} (local, not applied)
      </span>
    )),
    hours.notClaimedMinutes > 0 ? (
      <NotClaimedBadge key="not-claimed" hours={formatHours(hours.notClaimedMinutes)} />
    ) : null,
  ].filter(Boolean);
  if (labels.length === 0) return null;
  return <span className="flex flex-wrap items-center gap-1.5">{labels}</span>;
}

const ROW = cn(
  'flex min-h-18 w-full cursor-pointer items-center gap-3 px-4 py-3 text-left',
  'transition-colors duration-fast hover:bg-accent-subtle/40 focus-visible:outline-offset-[-2px]',
);

function DayRow({ day, onOpen }: { day: TimesheetDayView; onOpen: () => void }) {
  const first = day.entries.find((entry) => entry.activity) ?? day.entries[0];
  const summary = [first?.activity, first?.client?.name].filter(Boolean).join(' · ');
  const more = day.entries.length - 1;
  return (
    <button type="button" onClick={onOpen} className={ROW}>
      <DateTile day={day} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="sr-only">{longDayText(day.hours.date)}</span>
        {day.entries.length === 0 ? (
          <span className="text-subheadline text-text-secondary">No entries</span>
        ) : (
          <span className="flex flex-col gap-1 text-subheadline">
            {day.entries.map((entry) => (
              <EntryTimes key={entry.id} entry={entry} />
            ))}
          </span>
        )}
        {summary ? (
          <span className="truncate text-footnote text-text-secondary">
            {summary}
            {more > 0 ? ` · +${more} more` : ''}
          </span>
        ) : null}
        <DayLabels day={day} />
      </span>
      <DayHours day={day} />
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-text-tertiary" />
    </button>
  );
}

function RestRun({
  days,
  newest,
  oldest,
  onOpen,
}: {
  days: TimesheetDayView[];
  newest: TimesheetDayView;
  oldest: TimesheetDayView;
  onOpen: (day: TimesheetDayView) => void;
}) {
  const [open, setOpen] = useState(false);
  const listId = `rest-run-${oldest.hours.date}`;
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
        className={ROW}
      >
        <span
          aria-hidden="true"
          className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-bg-grouped text-caption font-medium text-text-secondary numeric"
        >
          {days.length} days
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-subheadline">
            {shortDayText(oldest.hours.date)} – {shortDayText(newest.hours.date)}
          </span>
          <span className="flex flex-wrap gap-1.5">
            <DayKindBadge>Rest days</DayKindBadge>
            <span className="text-footnote text-text-secondary">No entries</span>
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-4 shrink-0 text-text-tertiary transition-transform duration-fast motion-reduce:transition-none',
            open && 'rotate-180',
          )}
        />
      </button>
      {open ? (
        <ul id={listId} className="divide-y divide-separator border-t border-separator">
          {days.map((day) => (
            <li key={day.hours.date}>
              <DayRow day={day} onOpen={() => onOpen(day)} />
            </li>
          ))}
        </ul>
      ) : (
        <ul id={listId} hidden />
      )}
    </li>
  );
}

export function DayList({
  days,
  onOpenDay,
}: {
  days: readonly TimesheetDayView[];
  onOpenDay: (day: TimesheetDayView) => void;
}) {
  const rows = rowsOf(days);
  return (
    <ul
      aria-label="Days of the cut-off"
      className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card"
    >
      {rows.map((row) =>
        row.kind === 'day' ? (
          <li key={row.day.hours.date}>
            <DayRow day={row.day} onOpen={() => onOpenDay(row.day)} />
          </li>
        ) : (
          <RestRun
            key={`run-${row.newest.hours.date}`}
            days={row.days}
            newest={row.newest}
            oldest={row.oldest}
            onOpen={onOpenDay}
          />
        ),
      )}
    </ul>
  );
}
