'use client';

import { CalendarClock, Plus } from 'lucide-react';
import {
  EXTRA_HOURS_TREATMENT_LABELS,
  formatHours,
  NOT_CLAIMED_HINT,
  type TimeEntryView,
  type TimesheetDayView,
} from '@pulse/talent';
import { Button } from '@pulse/ui/components/button';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { SheetBody, SheetFooter, SheetHeader } from '@pulse/ui/components/sheet';
import { cn } from '@pulse/ui/lib/utils';
import { NotClaimedBadge } from './badges';
import { DayLabels, EntryTimes } from './day-list';
import { longDayText } from './format';

// Spec: docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24 ("Day sheet")
// — a day's entries, each with its times, activity, client, extra-hours mark and hours, and "Add
// entry". On the employee's own timesheet an entry opens its edit sheet; read-only views list the
// entries with no actions.

function EntryDetails({ entry, treatment }: { entry: TimeEntryView; treatment: string }) {
  const { hours } = entry;
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1 text-left">
      <span className="text-subheadline">
        <EntryTimes entry={entry} />
      </span>
      <span className="text-footnote break-words">
        {entry.activity ?? <span className="text-text-secondary">No activity yet</span>}
      </span>
      {entry.client ? (
        <span className="text-footnote text-text-secondary">{entry.client.name}</span>
      ) : null}
      {entry.extraHours ? (
        <span className="text-footnote text-text-secondary break-words">
          {treatment}: {entry.extraHours.reason}
        </span>
      ) : null}
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-footnote text-text-secondary numeric">
        {hours.open ? null : <span>Worked {formatHours(hours.workedMinutes)}</span>}
        {hours.claimedMinutes > 0 ? <span>Claimed {formatHours(hours.claimedMinutes)}</span> : null}
        {hours.notClaimedMinutes > 0 ? (
          <NotClaimedBadge hours={formatHours(hours.notClaimedMinutes)} />
        ) : null}
      </span>
    </span>
  );
}

export function DaySheetContent({
  day,
  editable,
  onAdd,
  onEdit,
}: {
  day: TimesheetDayView;
  /** The employee's own open timesheet: Add entry, and entries open their edit sheet. */
  editable: boolean;
  onAdd: () => void;
  onEdit: (entry: TimeEntryView) => void;
}) {
  const { hours } = day;
  const treatment = EXTRA_HOURS_TREATMENT_LABELS[hours.treatment];
  const extra =
    hours.treatment === 'overtime'
      ? hours.overtime.totalMinutes > 0
        ? `OT ${formatHours(hours.overtime.totalMinutes)} · ${day.kindLabel}`
        : null
      : hours.offsetMinutes > 0
        ? `Offset ${formatHours(hours.offsetMinutes)}`
        : null;

  return (
    <>
      <SheetHeader title={longDayText(hours.date)} description={day.kindLabel} />
      <SheetBody>
        <div className="flex flex-col gap-2">
          <DayLabels day={day} />
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-subheadline numeric">
            <span>Worked {formatHours(hours.workedMinutes)}</span>
            {extra ? <span className="font-semibold">{extra}</span> : null}
            {hours.treatment === 'overtime' && hours.nightDifferentialMinutes > 0 ? (
              <span>Night differential {formatHours(hours.nightDifferentialMinutes)}</span>
            ) : null}
          </p>
          {hours.notClaimedMinutes > 0 ? (
            <p className="text-footnote text-text-secondary">
              {formatHours(hours.notClaimedMinutes)} not claimed.{' '}
              {NOT_CLAIMED_HINT[hours.treatment]}.
            </p>
          ) : null}
        </div>
        {day.entries.length === 0 ? (
          <EmptyState
            variant="inline"
            headingLevel={3}
            icon={<CalendarClock strokeWidth={1.75} />}
            title="No entries"
            description={
              editable
                ? 'Add an entry for the hours worked on this day.'
                : 'No time was entered for this day.'
            }
          />
        ) : (
          <ul
            aria-label="Entries"
            className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card"
          >
            {day.entries.map((entry) => (
              <li key={entry.id}>
                {editable ? (
                  <button
                    type="button"
                    onClick={() => onEdit(entry)}
                    className={cn(
                      'flex min-h-11 w-full cursor-pointer items-start gap-3 px-4 py-3',
                      'transition-colors duration-fast hover:bg-accent-subtle/40 focus-visible:outline-offset-[-2px]',
                    )}
                  >
                    <EntryDetails entry={entry} treatment={treatment} />
                    <span className="text-footnote font-medium text-accent">Edit</span>
                  </button>
                ) : (
                  <div className="flex items-start gap-3 px-4 py-3">
                    <EntryDetails entry={entry} treatment={treatment} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </SheetBody>
      {editable ? (
        <SheetFooter>
          <Button onClick={onAdd} className="w-full sm:w-auto">
            <Plus aria-hidden="true" className="size-4" />
            Add entry
          </Button>
        </SheetFooter>
      ) : null}
    </>
  );
}
