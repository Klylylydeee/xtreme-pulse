import { CircleCheck, Hourglass, Timer } from 'lucide-react';
import {
  beyondHoursText,
  formatHours,
  formatSignedHours,
  offsetCreditedText,
  type TimesheetView,
} from '@pulse/talent';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { cn } from '@pulse/ui/lib/utils';

// Spec: docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24 ("Overtime
// timesheet", "Standard timesheet") and docs/DESIGN_SYSTEM.md#layout--components ("Timesheets on
// a phone") — the only part that differs between the two types. "Overtime by kind": the total in
// Display size and one bar per kind with its hours as text (rest day and holiday with the split
// beyond `hoursPerDay`), and a line saying night differential overlaps the rest. "Offset": the
// cut-off's offset and the balance. From step 2.7 the balance is the sum of the offset entries
// ("Balance 12.5 h", below zero after an adjustment), with "+X h this cut-off, credited when HR
// approves your timesheet" until HR approves it and "Credited +X h on Sep 28" after. Hours are
// added in minutes first, then formatted.

interface KindBar {
  label: string;
  minutes: number;
  sub?: string;
  /** Night differential overlaps the other kinds: a context bar, not added to the total. */
  overlaps?: boolean;
}

function OvertimeByKind({ view }: { view: TimesheetView }) {
  const { totals, hoursPerDay } = view;
  const bars: KindBar[] = [
    { label: 'Ordinary day', minutes: totals.ordinaryMinutes },
    {
      label: 'Rest day',
      minutes: totals.restDay.minutes,
      sub: totals.restDay.minutes > 0 ? beyondHoursText(totals.restDay, hoursPerDay) : undefined,
    },
    {
      label: 'Holiday',
      minutes: totals.holiday.minutes,
      sub: totals.holiday.minutes > 0 ? beyondHoursText(totals.holiday, hoursPerDay) : undefined,
    },
    { label: 'Night differential', minutes: totals.nightDifferentialMinutes, overlaps: true },
  ];
  const longest = Math.max(1, ...bars.map((bar) => bar.minutes));

  return (
    <section
      aria-labelledby="timesheet-extra-hours"
      className="flex flex-col gap-4 rounded-card bg-surface p-4 shadow-card"
    >
      <div className="flex items-center gap-3">
        <IconTile className="size-10 [&_svg]:size-5">
          <Timer strokeWidth={1.75} />
        </IconTile>
        <div className="flex min-w-0 flex-col">
          <h2 id="timesheet-extra-hours" className="text-headline">
            Overtime by kind
          </h2>
          <p className="text-footnote text-text-secondary">Claimed hours this cut-off</p>
        </div>
      </div>
      <p className="flex items-baseline gap-2">
        <span className="text-display numeric">{formatHours(totals.totalOvertimeMinutes)}</span>
        <span className="text-subheadline text-text-secondary">total overtime</span>
      </p>
      <dl className="flex flex-col gap-3">
        {bars.map((bar) => (
          <div key={bar.label} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-subheadline">{bar.label}</dt>
              <dd className="text-subheadline font-semibold numeric">{formatHours(bar.minutes)}</dd>
            </div>
            <div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-bg-grouped">
              <div
                className={cn(
                  'h-full rounded-full',
                  bar.overlaps ? 'bg-chart-context' : 'bg-accent',
                )}
                style={{ width: `${(bar.minutes / longest) * 100}%` }}
              />
            </div>
            {bar.sub ? (
              <dd className="text-footnote text-text-secondary numeric">{bar.sub}</dd>
            ) : null}
          </div>
        ))}
      </dl>
      <p className="text-footnote text-text-secondary">
        Night differential overlaps the other hours, so it isn’t added to the total.
      </p>
    </section>
  );
}

function Offset({ view }: { view: TimesheetView }) {
  const offset = view.offset ?? { balanceMinutes: 0, thisCutOffMinutes: 0, credited: null };
  const credited = offset.credited ?? null;
  const thisCutOff = formatHours(offset.thisCutOffMinutes);
  return (
    <section
      aria-labelledby="timesheet-extra-hours"
      className="flex flex-col gap-4 rounded-card bg-surface p-4 shadow-card"
    >
      <div className="flex items-center gap-3">
        <IconTile className="size-10 [&_svg]:size-5">
          <Hourglass strokeWidth={1.75} />
        </IconTile>
        <div className="flex min-w-0 flex-col">
          <h2 id="timesheet-extra-hours" className="text-headline">
            Offset this cut-off
          </h2>
          <p className="text-footnote text-text-secondary">Claimed extra hours, as offset hours</p>
        </div>
      </div>
      <p className="text-display numeric">{thisCutOff}</p>
      <dl className="flex flex-col gap-1 rounded-lg bg-bg-grouped px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-subheadline">Current balance</dt>
          <dd
            className={cn(
              'text-subheadline font-semibold numeric',
              offset.balanceMinutes < 0 && 'text-destructive-text',
            )}
          >
            {offset.balanceMinutes < 0
              ? formatSignedHours(offset.balanceMinutes)
              : formatHours(offset.balanceMinutes)}
          </dd>
        </div>
        {credited ? (
          <dd className="flex items-center gap-1.5 text-footnote font-medium text-success-text numeric">
            <CircleCheck aria-hidden="true" className="size-3.5 shrink-0" />
            {offsetCreditedText(credited)}
          </dd>
        ) : (
          <dd className="text-footnote text-text-secondary numeric">
            +{thisCutOff} this cut-off, credited when HR approves {view.own ? 'your' : 'the'}{' '}
            timesheet
          </dd>
        )}
      </dl>
    </section>
  );
}

/** "Overtime by kind" on the Overtime treatment, "Offset this cut-off" on the Offset treatment. */
export function ExtraHoursCard({ view }: { view: TimesheetView }) {
  return view.treatment === 'overtime' ? <OvertimeByKind view={view} /> : <Offset view={view} />;
}
