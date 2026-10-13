'use client';

import { useState } from 'react';
import { CircleAlert, LogIn, LogOut } from 'lucide-react';
import { formatDateTime, formatTime } from '@pulse/core';
import { formatHours, manilaDateOf, type TimesheetTodayView } from '@pulse/talent';
import { Button } from '@pulse/ui/components/button';
import { useActionSubmit } from '@/components/org-structure';
import { timeInAction, timeOutAction } from '@/lib/actions/talent-timesheets';

// Spec: docs/DESIGN_SYSTEM.md#layout--components ("Timesheets on a phone": Today card) and
// docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24 ("Time in", "Time
// out") — a ring of worked against scheduled hours, "Timed in 7:58 AM", and one full-width primary
// button at least 52px tall. Both buttons use the server's time: the browser sends no time. When
// the open entry has no activity, Time out answers `activityRequired` and the page opens the entry
// sheet to ask for it. Read-only views show the card without the button.

const CLOCK_FAILED = 'That didn’t go through. Check your connection and try again.';

const RING_RADIUS = 26;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** The worked-against-scheduled ring; its value is also given as text for assistive technology. */
function WorkedRing({
  worked,
  scheduled,
  workDay,
}: {
  worked: number;
  scheduled: number;
  workDay: boolean;
}) {
  const share = scheduled > 0 ? Math.min(worked / scheduled, 1) : worked > 0 ? 1 : 0;
  return (
    <svg
      role="img"
      aria-label={
        workDay
          ? `Worked ${formatHours(worked)} of ${formatHours(scheduled)} scheduled`
          : `Worked ${formatHours(worked)}, not a work day`
      }
      viewBox="0 0 64 64"
      className="size-16 shrink-0 -rotate-90"
    >
      <circle
        cx="32"
        cy="32"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="7"
        className="stroke-bg-grouped"
      />
      <circle
        cx="32"
        cy="32"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray={RING_LENGTH}
        strokeDashoffset={RING_LENGTH * (1 - share)}
        className="stroke-accent transition-[stroke-dashoffset] duration-slow ease-out"
      />
    </svg>
  );
}

export function TodayCard({
  today,
  own,
  onActivityRequired,
}: {
  today: TimesheetTodayView;
  /** The employee's own timesheet: the clock button shows. */
  own: boolean;
  /** Time out found no activity: open the entry sheet to ask for it. */
  onActivityRequired: () => void;
}) {
  const [networkError, setNetworkError] = useState<string | null>(null);
  const clockIn = useActionSubmit(timeInAction, () => undefined);
  const clockOut = useActionSubmit(timeOutAction, (result) => {
    if (result.status === 'activityRequired') onActivityRequired();
  });
  const open = today.openEntry;
  const pending = clockIn.pending || clockOut.pending;
  const error = clockIn.formError ?? clockOut.formError ?? networkError;

  async function clock() {
    setNetworkError(null);
    clockIn.reset();
    clockOut.reset();
    try {
      if (open) await clockOut.run({});
      else await clockIn.run({});
    } catch {
      setNetworkError(CLOCK_FAILED);
    }
  }

  const timedIn = open
    ? manilaDateOf(open.timeIn) === today.date
      ? formatTime(open.timeIn)
      : formatDateTime(open.timeIn)
    : null;

  return (
    <section
      aria-labelledby="timesheet-today"
      className="flex flex-col gap-4 rounded-card bg-surface p-4 shadow-card"
    >
      <div className="flex items-center gap-4">
        <WorkedRing
          worked={today.workedMinutes}
          scheduled={today.scheduledMinutes}
          workDay={today.workDay}
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id="timesheet-today" className="text-headline">
            Today
          </h2>
          <p className="text-subheadline numeric">
            {formatHours(today.workedMinutes)}{' '}
            <span className="text-text-secondary">
              {today.workDay
                ? `of ${formatHours(today.scheduledMinutes)} scheduled`
                : 'worked · not a work day'}
            </span>
          </p>
          <p className="text-footnote text-text-secondary numeric">
            {timedIn ? `Timed in ${timedIn}` : 'Not timed in'}
          </p>
        </div>
      </div>
      {own ? (
        <div className="flex flex-col gap-2">
          <Button
            variant="primary"
            loading={pending}
            onClick={clock}
            className="h-13 w-full text-body"
          >
            {open ? (
              <LogOut aria-hidden="true" className="size-5" />
            ) : (
              <LogIn aria-hidden="true" className="size-5" />
            )}
            {open ? 'Time out' : 'Time in'}
          </Button>
          <div role="alert" className="empty:hidden">
            {error ? (
              <p className="flex items-start gap-1.5 text-footnote font-medium text-destructive-text">
                <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
                <span>{error}</span>
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
