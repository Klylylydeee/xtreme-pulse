'use client';

import { type ReactNode, useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { CalendarDays, ChevronLeft, ChevronRight, Lock, Send, UsersRound } from 'lucide-react';
import { type BusinessDate, formatPeso } from '@pulse/core';
import {
  formatHours,
  formatPeriodRange,
  isTimesheetEditable,
  type ReimbursementLineView,
  TIMESHEET_TYPE_TITLES,
  type TimeEntryView,
  type TimesheetSubmitProblemView,
  type TimesheetView,
} from '@pulse/talent';
import { Button } from '@pulse/ui/components/button';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { PageHeader } from '@pulse/ui/components/page-header';
import { SegmentedControl } from '@pulse/ui/components/segmented-control';
import { Sheet, SheetContent } from '@pulse/ui/components/sheet';
import { cn } from '@pulse/ui/lib/utils';
import type { UploadHint } from '@/lib/upload-hints';
import { TimesheetStatusBadge } from './badges';
import { DayList } from './day-list';
import { DaySheetContent } from './day-sheet';
import { DtrFooter, DtrList } from './dtr-list';
import { EntryForm, type EntryFormMode } from './entry-form';
import { ExtraHoursCard } from './extra-hours-card';
import { cutOffRangeText } from './format';
import { ReimbursementList } from './reimbursement-list';
import {
  ReimbursementDetail,
  ReimbursementForm,
  type ReimbursementFormMode,
} from './reimbursement-sheet';
import { StatusBanner } from './status-banner';
import { SubmitSheetContent } from './submit-sheet';
import { TodayCard } from './today-card';

// Spec: docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24 ("Screens")
// and docs/DESIGN_SYSTEM.md#layout--components ("Timesheets on a phone") — one view for both
// timesheet types and both pages, built from shared parts. Top to bottom: the title with "Cut-off
// Sep 11 – 25, 2026 · Overtime timesheet" and the previous and next cut-offs, the status banner
// (step 2.7), the Today card (only on today's cut-off), the extra-hours card, "Daily entries |
// Reimbursements | DTR", the segment's list, My team, and a sticky glass footer with the
// segment's total.
//
// The Reimbursements segment (build step 2.5, docs/modules/talent.md#reimbursements-build-step-25)
// lists the lines by receipt date; while it is shown, the footer reads "Reimbursements ₱1,234.50 ·
// 3 receipts". "Add reimbursement" and the edit sheet follow the server's `canAdd` and `canEdit`;
// otherwise a line opens read-only with "Open receipt".
//
// Step 2.7 (docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27,
// "Screens"; decision 295): the status banner, the DTR segment with its totals in the footer, and
// on the employee's own `open` or `returned` timesheet after the cut-off ends, the footer's
// full-width "Submit timesheet" ("Resubmit" when returned), which opens the confirmation sheet.
// Entries and lines change only while `open` or `returned`: on a pending or approved timesheet
// every add, edit and delete control is hidden (not disabled) and the lock message says why. A
// submit-sheet problem on this timesheet opens that day's or line's sheet; `#day-<date>` and
// `#reimbursement-<id>` in the address do the same on load. My team shows each person's status
// for the latest ended cut-off. An approver gets "Open in Approvals" in the banner; nothing is
// decided here.
//
// `view.own` is the employee's own timesheet (clock, add, edit, delete). Anyone else's is
// read-only: no clock, no Add entry, no edit sheet; the server refuses every change anyway.
// Changing the cut-off loads the page again in a transition, so the view dims while it loads.

type Segment = 'entries' | 'reimbursements' | 'dtr';

type SheetState =
  | { view: 'day'; date: BusinessDate }
  | { view: 'entry'; mode: EntryFormMode; fromDay: BusinessDate | null }
  | { view: 'reimbursement'; mode: ReimbursementFormMode }
  | { view: 'reimbursementDetail'; line: ReimbursementLineView }
  | { view: 'submit' };

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
              href={
                member.status ? `${member.href}?cutOff=${member.status.periodStart}` : member.href
              }
              className="flex min-h-11 items-center gap-3 px-4 py-2.5 transition-colors duration-fast hover:bg-accent-subtle/40 focus-visible:outline-offset-[-2px]"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="truncate text-subheadline">{member.name}</span>
                <span className="text-footnote text-text-secondary numeric">
                  {member.employeeNumber}
                </span>
                {member.status ? (
                  <span className="flex flex-wrap items-center gap-1.5">
                    <TimesheetStatusBadge
                      status={member.status.status}
                      label={member.status.label}
                      overdue={member.status.overdue}
                    />
                    <span className="text-footnote text-text-secondary numeric">
                      {formatPeriodRange(member.status.periodStart, member.status.periodEnd, {
                        year: false,
                      })}
                    </span>
                    {member.status.submittedLate ? (
                      <span className="text-footnote text-warning-text">Submitted late</span>
                    ) : null}
                  </span>
                ) : null}
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

/** The sticky glass footer: the segment's total, and the own timesheet's Submit button. */
function StickyFooter({
  label,
  children,
  action,
}: {
  label: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      className="sticky bottom-[max(1rem,env(safe-area-inset-bottom))] z-10 flex flex-col gap-3 rounded-card glass px-4 py-3 shadow-float sm:flex-row sm:items-center"
    >
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}

function ReimbursementsTotal({ view }: { view: TimesheetView }) {
  const { totalCentavos, count } = view.reimbursements;
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex min-w-0 flex-col">
        <span className="text-footnote text-text-secondary">Reimbursements</span>
        <span className="text-footnote text-text-secondary numeric">
          {count === 1 ? '1 receipt' : `${count} receipts`}
        </span>
      </span>
      <span className="text-title-2 numeric">{formatPeso(totalCentavos)}</span>
    </div>
  );
}

function CutOffTotal({ view }: { view: TimesheetView }) {
  const { totals } = view;
  const overtime = view.treatment === 'overtime';
  return (
    <div className="flex items-center justify-between gap-3">
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

/** Finds a reimbursement line on the timesheet by id. */
function lineById(view: TimesheetView, id: string): ReimbursementLineView | null {
  for (const group of view.reimbursements.groups) {
    const line = group.lines.find((candidate) => candidate.id === id);
    if (line) return line;
  }
  return null;
}

export function TimesheetScreen({
  view,
  receiptUpload,
}: {
  view: TimesheetView;
  /** Own timesheet: the receipt field's accepted types and size limit. */
  receiptUpload?: UploadHint;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [segment, setSegment] = useState<Segment>('entries');
  const [sheet, setSheet] = useState<SheetState | null>(null);

  const { timesheet, approval } = view;
  const editable = view.own && isTimesheetEditable(timesheet.status);
  const lockedMessage = view.own ? (approval?.lockedMessage ?? null) : null;
  const submit = view.own && timesheet.id ? (approval?.submit ?? null) : null;
  const subtitle = `Cut-off ${cutOffRangeText(timesheet.periodStart, timesheet.periodEnd)} · ${TIMESHEET_TYPE_TITLES[timesheet.timesheetType]}`;

  function goTo(cutOff: BusinessDate) {
    setSheet(null);
    startTransition(() => router.push(`${pathname}?cutOff=${cutOff}`));
  }

  /** Opens a day's sheet, or a reimbursement line's; false when it isn't on this timesheet. */
  function openTarget(target: { day: BusinessDate } | { lineId: string }): boolean {
    if ('day' in target) {
      if (!view.days.some((candidate) => candidate.hours.date === target.day)) return false;
      setSegment('entries');
      setSheet({ view: 'day', date: target.day });
      return true;
    }
    const line = lineById(view, target.lineId);
    if (!line) return false;
    setSegment('reimbursements');
    setSheet(
      view.reimbursements.canEdit
        ? { view: 'reimbursement', mode: { kind: 'edit', line } }
        : { view: 'reimbursementDetail', line },
    );
    return true;
  }

  function fixProblem(problem: TimesheetSubmitProblemView): boolean {
    const { problem: kind } = problem;
    if (kind.kind === 'openEntry' || kind.kind === 'missingActivity') {
      return openTarget({ day: kind.date });
    }
    if (kind.kind === 'unclaimedLine') return openTarget({ lineId: kind.lineId });
    return false;
  }

  // `#day-<date>` or `#reimbursement-<id>` (the submit sheet's links, opened from elsewhere): open
  // that day's or line's sheet on load (after the first frame) and whenever the hash changes.
  const openTargetRef = useRef(openTarget);
  useEffect(() => {
    openTargetRef.current = openTarget;
  });
  useEffect(() => {
    function openFromHash() {
      const hash = window.location.hash;
      const day = /^#day-(\d{4}-\d{2}-\d{2})$/.exec(hash)?.[1];
      const lineId = /^#reimbursement-([a-f\d]{24})$/i.exec(hash)?.[1];
      if (day) openTargetRef.current({ day: day as BusinessDate });
      else if (lineId) openTargetRef.current({ lineId });
    }
    const frame = requestAnimationFrame(openFromHash);
    window.addEventListener('hashchange', openFromHash);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('hashchange', openFromHash);
    };
  }, []);

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

  const submitButton = submit ? (
    <Button
      onClick={() => setSheet({ view: 'submit' })}
      className="h-13 w-full text-body sm:w-auto"
    >
      <Send aria-hidden="true" className="size-5" />
      {submit.buttonLabel}
    </Button>
  ) : null;

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

      {approval ? <StatusBanner approval={approval} own={view.own} /> : null}

      {view.todayCard ? (
        <TodayCard
          today={view.todayCard}
          own={view.own && editable}
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
          ...(view.dtr ? [{ value: 'dtr' as const, label: 'DTR' }] : []),
        ]}
      />

      {lockedMessage && segment !== 'dtr' ? (
        <p className="flex items-start gap-2 px-1 text-footnote text-text-secondary">
          <Lock aria-hidden="true" className="mt-px size-4 shrink-0" />
          <span>{lockedMessage}</span>
        </p>
      ) : null}

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
      ) : segment === 'reimbursements' ? (
        <ReimbursementList
          section={view.reimbursements}
          onAdd={() => setSheet({ view: 'reimbursement', mode: { kind: 'add' } })}
          onOpen={(line) =>
            setSheet(
              view.reimbursements.canEdit
                ? { view: 'reimbursement', mode: { kind: 'edit', line } }
                : { view: 'reimbursementDetail', line },
            )
          }
        />
      ) : view.dtr ? (
        <DtrList dtr={view.dtr} />
      ) : null}

      {view.myTeam && view.myTeam.length > 0 ? <MyTeam team={view.myTeam} /> : null}

      {segment === 'reimbursements' ? (
        <StickyFooter label="Reimbursements total" action={submitButton}>
          <ReimbursementsTotal view={view} />
        </StickyFooter>
      ) : segment === 'dtr' && view.dtr ? (
        <StickyFooter label="DTR totals" action={submitButton}>
          <DtrFooter dtr={view.dtr} />
        </StickyFooter>
      ) : (
        <StickyFooter label="Cut-off total" action={submitButton}>
          <CutOffTotal view={view} />
        </StickyFooter>
      )}

      <Sheet
        open={sheet !== null && (sheet.view !== 'day' || Boolean(day))}
        onOpenChange={(open) => (open ? undefined : setSheet(null))}
      >
        <SheetContent aria-describedby={undefined}>
          {sheet?.view === 'day' && day ? (
            <DaySheetContent
              day={day}
              editable={editable}
              lockedMessage={lockedMessage}
              onAdd={() => openEntry({ kind: 'add', date: day.hours.date }, day.hours.date)}
              onEdit={(entry: TimeEntryView) => openEntry({ kind: 'edit', entry }, day.hours.date)}
            />
          ) : null}
          {sheet?.view === 'entry' && editable ? (
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
          {sheet?.view === 'reimbursement' && view.own && timesheet.id ? (
            <ReimbursementForm
              key={sheet.mode.kind === 'edit' ? sheet.mode.line.id : 'add'}
              mode={sheet.mode}
              timesheetId={timesheet.id}
              section={view.reimbursements}
              clients={view.clients ?? []}
              receiptUpload={receiptUpload ?? { accept: '', hint: '' }}
              onDone={() => setSheet(null)}
            />
          ) : null}
          {sheet?.view === 'reimbursementDetail' ? <ReimbursementDetail line={sheet.line} /> : null}
          {sheet?.view === 'submit' && submit && timesheet.id ? (
            <SubmitSheetContent
              submit={submit}
              timesheetId={timesheet.id}
              periodText={cutOffRangeText(timesheet.periodStart, timesheet.periodEnd)}
              onFix={fixProblem}
              onDone={() => setSheet(null)}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
