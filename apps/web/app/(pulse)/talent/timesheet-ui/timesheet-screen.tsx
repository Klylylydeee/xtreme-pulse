'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { CalendarDays, ChevronLeft, ChevronRight, Receipt, UsersRound } from 'lucide-react';
import type { BusinessDate } from '@pulse/core';
import {
  formatHours,
  TIMESHEET_TYPE_TITLES,
  type TimeEntryView,
  type TimesheetView,
} from '@pulse/talent';
import { Button } from '@pulse/ui/components/button';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { PageHeader } from '@pulse/ui/components/page-header';
import { SegmentedControl } from '@pulse/ui/components/segmented-control';
import { Sheet, SheetContent } from '@pulse/ui/components/sheet';
import { cn } from '@pulse/ui/lib/utils';
import { DayList } from './day-list';
import { DaySheetContent } from './day-sheet';
import { EntryForm, type EntryFormMode } from './entry-form';
import { ExtraHoursCard } from './extra-hours-card';
import { cutOffRangeText } from './format';
import { TodayCard } from './today-card';

// Spec: docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24 ("Screens")
// and docs/DESIGN_SYSTEM.md#layout--components ("Timesheets on a phone") — one view for both
// timesheet types and both pages, built from shared parts. Top to bottom: the title with "Cut-off
// Sep 11 – 25, 2026 · Overtime timesheet" and the previous and next cut-offs, the Today card (only
// on today's cut-off), the extra-hours card, "Daily entries | Reimbursements", the day list, My
// team, and a sticky glass footer with the cut-off's total. No Submit button until step 2.7;
// Reimbursements is an empty state until step 2.5.
//
// `view.own` is the employee's own timesheet (clock, add, edit, delete). Anyone else's is
// read-only: no clock, no Add entry, no edit sheet; the server refuses every change anyway.
// Changing the cut-off loads the page again in a transition, so the view dims while it loads.

type Segment = 'entries' | 'reimbursements';

type SheetState =
  | { view: 'day'; date: BusinessDate }
  | { view: 'entry'; mode: EntryFormMode; fromDay: BusinessDate | null };

function CutOffNav({
  previous,
  next,
  onGo,
  pending,
}: {
  previous: BusinessDate | null;
  next: BusinessDate | null;
  onGo: (cutOff: BusinessDate) => void;
  pending: boolean;
}) {
  return (
    <div className="flex items-center gap-1" aria-busy={pending || undefined}>
      <Button
        variant="secondary"
        size="icon"
        aria-label="Previous cut-off"
        disabled={!previous}
        onClick={() => previous && onGo(previous)}
      >
        <ChevronLeft aria-hidden="true" />
      </Button>
      <Button
        variant="secondary"
        size="icon"
        aria-label="Next cut-off"
        disabled={!next}
        onClick={() => next && onGo(next)}
      >
        <ChevronRight aria-hidden="true" />
      </Button>
    </div>
  );
}

function MyTeam({ team }: { team: NonNullable<TimesheetView['myTeam']> }) {
  return (
    <section aria-labelledby="timesheet-my-team" className="flex flex-col gap-2">
      <h2 id="timesheet-my-team" className="flex items-center gap-2 px-1 text-headline">
        <UsersRound aria-hidden="true" className="size-5 text-accent" strokeWidth={1.75} />
        My team
      </h2>
      <ul className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
        {team.map((member) => (
          <li key={member.employeeId}>
            <Link
              href={member.href}
              className="flex min-h-11 items-center gap-3 px-4 py-2.5 transition-colors duration-fast hover:bg-accent-subtle/40 focus-visible:outline-offset-[-2px]"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-subheadline">{member.name}</span>
                <span className="text-footnote text-text-secondary numeric">
                  {member.employeeNumber}
                </span>
              </span>
              <span className="sr-only">, open their timesheet</span>
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-text-tertiary" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TotalFooter({ view }: { view: TimesheetView }) {
  const { totals } = view;
  const overtime = view.treatment === 'overtime';
  return (
    <div
      role="region"
      aria-label="Cut-off total"
      className="sticky bottom-[max(1rem,env(safe-area-inset-bottom))] z-10 flex items-center justify-between gap-3 rounded-card glass px-4 py-3 shadow-float"
    >
      <span className="flex min-w-0 flex-col">
        <span className="text-footnote text-text-secondary">
          {overtime ? 'Total overtime this cut-off' : 'Offset this cut-off'}
        </span>
        {totals.openEntries > 0 ? (
          <span className="text-footnote text-text-secondary">
            {totals.openEntries === 1
              ? '1 entry has no time out'
              : `${totals.openEntries} entries have no time out`}
          </span>
        ) : null}
      </span>
      <span className="text-title-2 numeric">
        {formatHours(overtime ? totals.totalOvertimeMinutes : totals.offsetMinutes)}
      </span>
    </div>
  );
}

export function TimesheetScreen({ view }: { view: TimesheetView }) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [segment, setSegment] = useState<Segment>('entries');
  const [sheet, setSheet] = useState<SheetState | null>(null);

  const { timesheet } = view;
  const editable = view.own && timesheet.status === 'open';
  const subtitle = `Cut-off ${cutOffRangeText(timesheet.periodStart, timesheet.periodEnd)} · ${TIMESHEET_TYPE_TITLES[timesheet.timesheetType]}`;

  function goTo(cutOff: BusinessDate) {
    setSheet(null);
    startTransition(() => router.push(`${pathname}?cutOff=${cutOff}`));
  }

  const sheetDay =
    sheet?.view === 'day' ? sheet.date : sheet?.view === 'entry' ? sheet.fromDay : null;
  const day = sheetDay ? view.days.find((candidate) => candidate.hours.date === sheetDay) : null;
  const treatment = day?.hours.treatment ?? view.treatment;

  function openEntry(mode: EntryFormMode, fromDay: BusinessDate | null) {
    setSheet({ view: 'entry', mode, fromDay });
  }

  function entryDone() {
    setSheet((current) =>
      current?.view === 'entry' && current.fromDay ? { view: 'day', date: current.fromDay } : null,
    );
  }

  return (
    <div
      className={cn(
        'flex w-full max-w-2xl flex-col gap-5 transition-opacity duration-base',
        pending && 'opacity-60',
      )}
      aria-busy={pending || undefined}
    >
      <PageHeader
        title={view.own ? 'Timesheet' : view.employee.name}
        description={
          <>
            {view.own ? null : <span className="numeric">{view.employee.employeeNumber} · </span>}
            {subtitle}
          </>
        }
        actions={
          <CutOffNav
            previous={view.previousCutOff}
            next={view.nextCutOff}
            onGo={goTo}
            pending={pending}
          />
        }
      />

      {view.todayCard ? (
        <TodayCard
          today={view.todayCard}
          own={view.own}
          onActivityRequired={() => openEntry({ kind: 'timeOut' }, null)}
        />
      ) : null}

      <ExtraHoursCard view={view} />

      <SegmentedControl
        label="Timesheet view"
        track="page"
        fullWidth
        value={segment}
        onValueChange={setSegment}
        options={[
          { value: 'entries', label: 'Daily entries' },
          { value: 'reimbursements', label: 'Reimbursements' },
        ]}
      />

      {segment === 'entries' ? (
        view.days.length === 0 ? (
          <EmptyState
            icon={<CalendarDays strokeWidth={1.75} />}
            title="No days yet"
            description="This cut-off has no days to show yet."
          />
        ) : (
          <DayList
            days={view.days}
            onOpenDay={(picked) => setSheet({ view: 'day', date: picked.hours.date })}
          />
        )
      ) : (
        <EmptyState
          icon={<Receipt strokeWidth={1.75} />}
          title="No reimbursements"
          description="Reimbursements aren’t on the timesheet yet. They’re coming in a later update."
        />
      )}

      {view.myTeam && view.myTeam.length > 0 ? <MyTeam team={view.myTeam} /> : null}

      <TotalFooter view={view} />

      <Sheet
        open={sheet !== null && (sheet.view === 'entry' || Boolean(day))}
        onOpenChange={(open) => (open ? undefined : setSheet(null))}
      >
        <SheetContent aria-describedby={undefined}>
          {sheet?.view === 'day' && day ? (
            <DaySheetContent
              day={day}
              editable={editable}
              onAdd={() => openEntry({ kind: 'add', date: day.hours.date }, day.hours.date)}
              onEdit={(entry: TimeEntryView) => openEntry({ kind: 'edit', entry }, day.hours.date)}
            />
          ) : null}
          {sheet?.view === 'entry' && view.own ? (
            <EntryForm
              key={sheet.mode.kind === 'edit' ? sheet.mode.entry.id : sheet.mode.kind}
              mode={sheet.mode}
              treatment={treatment}
              clients={view.clients ?? []}
              onBack={
                sheet.fromDay
                  ? () => setSheet({ view: 'day', date: sheet.fromDay as BusinessDate })
                  : undefined
              }
              onDone={entryDone}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
