'use client';

import { useId, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  CalendarCheck,
  CalendarDays,
  CircleCheck,
  FileClock,
  Megaphone,
  Plus,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import {
  BUSINESS_TIME_ZONE,
  DISPLAY_LOCALE,
  formatDate,
  HOLIDAY_TYPE_LABELS,
  startOfBusinessDate,
} from '@pulse/core';
import type { HolidayAutoDraftResult, HolidayView } from '@pulse/core/server';
import { Button } from '@pulse/ui/components/button';
import {
  createDataTableColumns,
  DataTable,
  type DataTableColumn,
} from '@pulse/ui/components/data-table';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { Select } from '@pulse/ui/components/form';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { PageHeader } from '@pulse/ui/components/page-header';
import { SegmentedControl } from '@pulse/ui/components/segmented-control';
import { Sheet, SheetContent } from '@pulse/ui/components/sheet';
import { useReturnFocus } from '@pulse/ui/hooks/use-return-focus';
import { FormAlert } from '@/components/form-alert';
import { Badge, plural, useActionSubmit } from '@/components/org-structure';
import {
  type ConfirmHolidayYearResult,
  confirmHolidayYearAction,
  runHolidayAutoDraftAction,
} from '@/lib/actions/holidays';
import { ConfirmDialog } from './confirm-dialog';
import { HolidaySheet, type HolidaySheetMode } from './holiday-sheet';

// Spec: docs/modules/core.md#holiday-calendar — the holiday calendar (build step 1.10): one year's
// holidays, grouped by month (a data table on desktop, stacked rows on phones), each with its date
// and weekday, name, type, scope or location, and legal basis. Everyone sees confirmed holidays;
// the server sends drafts only to HR and System Administrators, who also get the controls: the
// Draft / Confirmed badges and filter, the drafts banner with Confirm all, Add holiday, Declare
// holiday, Run auto-draft (this year or next), and a sheet per row to edit, confirm or delete.
// Every control's action checks the role again on the server.

type StatusFilter = 'all' | 'draft' | 'confirmed';

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Drafts' },
  { value: 'confirmed', label: 'Confirmed' },
];

// Display in Manila, like every business date (formatDate).
const dayFormat = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  timeZone: BUSINESS_TIME_ZONE,
  month: 'short',
  day: 'numeric',
});
const weekdayFormat = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  timeZone: BUSINESS_TIME_ZONE,
  weekday: 'long',
});
const shortWeekdayFormat = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  timeZone: BUSINESS_TIME_ZONE,
  weekday: 'short',
});
const monthFormat = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  timeZone: BUSINESS_TIME_ZONE,
  month: 'long',
});

function dayOf(holiday: HolidayView) {
  const instant = startOfBusinessDate(holiday.date);
  return {
    day: dayFormat.format(instant),
    weekday: weekdayFormat.format(instant),
    shortWeekday: shortWeekdayFormat.format(instant),
    dayNumber: Number(holiday.date.slice(8, 10)),
  };
}

/** "Nationwide", or the local holiday's location. */
function whereOf(holiday: HolidayView): string {
  return holiday.scope === 'local' ? (holiday.location ?? 'Local') : 'Nationwide';
}

function StatusBadges({ holiday }: { holiday: HolidayView }) {
  return (
    <>
      <Badge tone={holiday.status === 'draft' ? 'accent' : 'neutral'}>
        {holiday.status === 'draft' ? 'Draft' : 'Confirmed'}
      </Badge>
      {holiday.declared ? <Badge>Declared</Badge> : null}
    </>
  );
}

function LegalBasis({ holiday }: { holiday: HolidayView }) {
  return holiday.legalBasis ? (
    <span>{holiday.legalBasis}</span>
  ) : (
    <span className="text-text-secondary">Not entered yet</span>
  );
}

const column = createDataTableColumns<HolidayView>();

function columnsFor(canManage: boolean): DataTableColumn<HolidayView>[] {
  return column.columns([
    column.accessor('date', {
      header: 'Date',
      enableSorting: false,
      cell: (info) => {
        const { day, weekday } = dayOf(info.row.original);
        return (
          <span className="flex flex-col whitespace-nowrap">
            <span className="numeric font-medium">{day}</span>
            <span className="text-footnote text-text-secondary">{weekday}</span>
          </span>
        );
      },
      meta: { width: '9rem' },
    }),
    column.accessor('name', {
      header: 'Name',
      enableSorting: false,
      cell: (info) => (
        <span className="flex min-w-40 flex-wrap items-center gap-2">
          <span className="font-medium">{info.getValue()}</span>
          {canManage ? <StatusBadges holiday={info.row.original} /> : null}
        </span>
      ),
    }),
    column.accessor('type', {
      header: 'Type',
      enableSorting: false,
      cell: (info) => (
        <span className="whitespace-nowrap">{HOLIDAY_TYPE_LABELS[info.row.original.type]}</span>
      ),
    }),
    column.accessor((holiday) => whereOf(holiday), {
      id: 'scope',
      header: 'Scope',
      enableSorting: false,
      cell: (info) => (
        <span className="flex flex-col">
          <span>{info.getValue()}</span>
          {info.row.original.scope === 'local' ? (
            <span className="text-footnote text-text-secondary">Local holiday</span>
          ) : null}
        </span>
      ),
    }),
    column.accessor('legalBasis', {
      header: 'Legal basis',
      enableSorting: false,
      cell: (info) => <LegalBasis holiday={info.row.original} />,
    }),
  ]);
}

function HolidayPhoneRow({ holiday, canManage }: { holiday: HolidayView; canManage: boolean }) {
  const { day, weekday, shortWeekday, dayNumber } = dayOf(holiday);
  return (
    <>
      <IconTile className="size-11 flex-col gap-0 rounded-xl leading-none">
        <span className="numeric text-subheadline font-semibold">{dayNumber}</span>
        <span className="text-caption font-medium uppercase">{shortWeekday}</span>
      </IconTile>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-subheadline font-semibold">{holiday.name}</span>
          {canManage ? <StatusBadges holiday={holiday} /> : null}
        </span>
        <span className="text-footnote text-text-secondary">
          <span className="numeric">{day}</span>, {weekday} · {HOLIDAY_TYPE_LABELS[holiday.type]}
        </span>
        <span className="text-footnote text-text-secondary">
          {whereOf(holiday)}
          {holiday.scope === 'local' ? ' (local)' : null} ·{' '}
          {holiday.legalBasis ?? 'No legal basis yet'}
        </span>
      </span>
    </>
  );
}

/** The holidays by month, in date order (the server sends them sorted). */
function byMonth(holidays: HolidayView[]): { key: string; label: string; rows: HolidayView[] }[] {
  const months = new Map<string, HolidayView[]>();
  for (const holiday of holidays) {
    const key = holiday.date.slice(0, 7);
    const rows = months.get(key);
    if (rows) rows.push(holiday);
    else months.set(key, [holiday]);
  }
  return [...months].map(([key, rows]) => ({
    key,
    label: monthFormat.format(startOfBusinessDate(`${key}-01` as HolidayView['date'])),
    rows,
  }));
}

type Notice = { message: string; warning?: string | null };

function autoDraftNotice(result: HolidayAutoDraftResult): Notice {
  const parts = [
    `Auto-draft for ${result.year}: ${plural(result.added, 'draft', 'drafts')} added, ${result.skipped} skipped.`,
  ];
  if (result.skipped > 0) {
    parts.push('Skipped holidays were drafted before, or their date already has a holiday.');
  }
  if (result.online.status === 'ok') {
    parts.push(
      `The online source added ${plural(result.online.added, 'draft', 'drafts')} and skipped ${result.online.skipped}.`,
    );
  }
  return {
    message: parts.join(' '),
    warning:
      result.online.status === 'failed'
        ? `The online source couldn’t be used (${result.online.reason}), so only the rule drafts were added. Run the auto-draft again once it’s reachable.`
        : null,
  };
}

export function HolidaysManager({
  year,
  currentYear,
  yearOptions,
  holidays,
  canManage,
}: {
  year: number;
  /** This year in Manila. */
  currentYear: number;
  yearOptions: number[];
  /** The year's holidays the viewer can see: confirmed only, unless they manage holidays. */
  holidays: HolidayView[];
  /** HR or a System Administrator: drafts and every control. */
  canManage: boolean;
}) {
  const router = useRouter();
  const returnFocus = useReturnFocus();
  const yearId = useId();
  const [changingYear, startChangingYear] = useTransition();
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  // Kept while the sheet closes, so its content doesn't change during the animation.
  const [sheet, setSheet] = useState<{ mode: HolidaySheetMode; holiday: HolidayView | null }>({
    mode: 'add',
    holiday: null,
  });
  // A new form (fresh fields and errors) every time the sheet opens.
  const [session, setSession] = useState(0);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [missingLegalBasis, setMissingLegalBasis] = useState<
    Extract<ConfirmHolidayYearResult, { status: 'legalBasisMissing' }>['drafts'] | null
  >(null);

  const draftCount = holidays.filter((holiday) => holiday.status === 'draft').length;
  const confirmedCount = holidays.length - draftCount;
  const canAutoDraft = canManage && (year === currentYear || year === currentYear + 1);

  const shown = useMemo(
    () => (filter === 'all' ? holidays : holidays.filter((holiday) => holiday.status === filter)),
    [holidays, filter],
  );
  const months = useMemo(() => byMonth(shown), [shown]);
  const columns = useMemo(() => columnsFor(canManage), [canManage]);

  const autoDraft = useActionSubmit(runHolidayAutoDraftAction, (result) => {
    setNotice(autoDraftNotice(result));
    router.refresh();
  });
  const confirmAll = useActionSubmit(confirmHolidayYearAction, (result) => {
    if (result.status === 'legalBasisMissing') {
      setMissingLegalBasis(result.drafts);
      return;
    }
    setConfirmingAll(false);
    setFilter('all');
    setNotice({
      message: `${plural(result.confirmed, 'holiday', 'holidays')} confirmed for ${year}.`,
    });
    router.refresh();
  });

  function openSheet(
    mode: HolidaySheetMode,
    holiday: HolidayView | null,
    trigger?: HTMLElement | null,
  ) {
    returnFocus.remember(trigger);
    setSheet({ mode, holiday });
    setSession((count) => count + 1);
    setNotice(null);
    setSheetOpen(true);
  }

  function finished(message: string) {
    setSheetOpen(false);
    setNotice({ message });
    router.refresh();
  }

  function showYear(next: number) {
    startChangingYear(() => {
      router.replace(next === currentYear ? '/holidays' : `/holidays?year=${next}`, {
        scroll: false,
      });
    });
  }

  function runAutoDraft() {
    setNotice(null);
    void autoDraft.run({ year });
  }

  const addButton = (variant: 'primary' | 'tinted') => (
    <Button variant={variant} onClick={(event) => openSheet('add', null, event.currentTarget)}>
      <Plus aria-hidden="true" className="size-5" />
      Add holiday
    </Button>
  );
  const autoDraftButton = (variant: 'secondary' | 'tinted') => (
    <Button variant={variant} loading={autoDraft.pending} onClick={runAutoDraft}>
      <Sparkles aria-hidden="true" className="size-5" />
      Run auto-draft
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Holidays"
        description={
          canManage
            ? `The holidays in ${year}. Only confirmed ones count for attendance, leave and payroll.`
            : `The regular holidays and special days in ${year}.`
        }
        actions={canManage ? addButton('primary') : undefined}
      />
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <div className="flex w-full flex-col gap-1.5 sm:w-40">
            <label htmlFor={yearId} className="text-footnote font-semibold text-text-secondary">
              Year
            </label>
            <Select
              id={yearId}
              value={String(year)}
              onChange={(event) => showYear(Number(event.target.value))}
              disabled={changingYear}
              aria-busy={changingYear || undefined}
              className="numeric"
            >
              {yearOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </div>
          {canManage ? (
            <SegmentedControl<StatusFilter>
              label="Show"
              track="page"
              options={FILTERS}
              value={filter}
              onValueChange={setFilter}
              className="w-full sm:w-auto"
            />
          ) : null}
          {canManage ? (
            <div className="flex w-full flex-wrap gap-2 sm:ml-auto sm:w-auto">
              <Button
                variant="secondary"
                onClick={(event) => openSheet('declare', null, event.currentTarget)}
              >
                <Megaphone aria-hidden="true" className="size-5" />
                Declare holiday
              </Button>
              {canAutoDraft ? autoDraftButton('secondary') : null}
            </div>
          ) : null}
        </div>
        <FormAlert message={autoDraft.formError} />
        <div role="status" className="flex flex-col gap-1 text-footnote text-text-secondary">
          {notice ? (
            <>
              <span className="inline-flex items-start gap-1.5 font-medium text-success-text">
                <CircleCheck aria-hidden="true" className="mt-px size-4 shrink-0" />
                <span>{notice.message}</span>
              </span>
              {notice.warning ? (
                <span className="inline-flex items-start gap-1.5 font-medium text-warning-text">
                  <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
                  <span>{notice.warning}</span>
                </span>
              ) : null}
            </>
          ) : (
            <span className="numeric">
              {plural(holidays.length, 'holiday', 'holidays')}
              {canManage && holidays.length > 0
                ? `: ${confirmedCount} confirmed, ${plural(draftCount, 'draft', 'drafts')}`
                : null}
            </span>
          )}
        </div>
      </div>

      {canManage && draftCount > 0 ? (
        <section
          aria-labelledby={`${yearId}-drafts`}
          className="flex flex-col gap-4 rounded-card bg-surface px-4 py-4 shadow-card sm:flex-row sm:items-center sm:px-5"
        >
          <IconTile className="size-11 rounded-xl [&_svg]:size-5">
            <FileClock strokeWidth={1.75} />
          </IconTile>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 id={`${yearId}-drafts`} className="text-headline">
              {draftCount === 1
                ? `1 draft for ${year} isn’t confirmed yet`
                : `${draftCount} drafts for ${year} aren’t confirmed yet`}
            </h2>
            <p className="text-subheadline text-text-secondary">
              Check each one against the year’s proclamation and enter its legal basis, then
              confirm.
            </p>
          </div>
          <Button
            variant="tinted"
            onClick={() => {
              confirmAll.reset();
              setMissingLegalBasis(null);
              setConfirmingAll(true);
            }}
          >
            <CalendarCheck aria-hidden="true" className="size-5" />
            Confirm all
          </Button>
        </section>
      ) : null}

      {holidays.length === 0 ? (
        canManage ? (
          <EmptyState
            icon={<CalendarDays strokeWidth={1.75} />}
            title={`No holidays for ${year} yet`}
            description={
              canAutoDraft
                ? 'Run the auto-draft to add the usual holidays as drafts, then check them against the year’s proclamation.'
                : 'Add the year’s holidays from its proclamation.'
            }
            action={canAutoDraft ? autoDraftButton('tinted') : addButton('tinted')}
          />
        ) : (
          <EmptyState
            icon={<CalendarDays strokeWidth={1.75} />}
            title={`No holidays for ${year} yet`}
            description="HR adds them once the year’s proclamation is out. Check again later."
            action={
              year !== currentYear ? (
                <Button variant="tinted" onClick={() => showYear(currentYear)}>
                  Show {currentYear}
                </Button>
              ) : undefined
            }
          />
        )
      ) : shown.length === 0 ? (
        <EmptyState
          icon={<CalendarDays strokeWidth={1.75} />}
          title={filter === 'draft' ? `No drafts in ${year}` : `No confirmed holidays in ${year}`}
          description={
            filter === 'draft'
              ? 'Every holiday this year is confirmed.'
              : 'Confirm the drafts once you’ve checked them against the year’s proclamation.'
          }
          action={
            <Button variant="tinted" onClick={() => setFilter('all')}>
              Show all
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-6">
          {months.map((month) => (
            <section
              key={month.key}
              aria-labelledby={`${yearId}-${month.key}`}
              className="flex flex-col gap-2"
            >
              <h2
                id={`${yearId}-${month.key}`}
                className="flex items-baseline gap-2 px-1 text-headline"
              >
                {month.label}
                <span className="numeric text-footnote font-medium text-text-secondary">
                  {month.rows.length}
                </span>
              </h2>
              <DataTable
                caption={`Holidays in ${month.label} ${year}`}
                captionHidden
                columns={columns}
                data={month.rows}
                getRowId={(holiday) => holiday.id}
                selectedRowId={canManage && sheetOpen ? sheet.holiday?.id : null}
                rowActionLabel={
                  canManage
                    ? (holiday) => `Edit ${holiday.name}, ${formatDate(holiday.date)}`
                    : undefined
                }
                onRowSelect={
                  canManage ? (holiday, element) => openSheet('edit', holiday, element) : undefined
                }
                renderPhoneRow={(holiday) => (
                  <HolidayPhoneRow holiday={holiday} canManage={canManage} />
                )}
              />
            </section>
          ))}
        </div>
      )}

      {canManage ? (
        <>
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetContent
              aria-describedby={undefined}
              onCloseAutoFocus={returnFocus.onCloseAutoFocus}
            >
              <HolidaySheet
                key={session}
                mode={sheet.mode}
                holiday={sheet.holiday}
                onDone={finished}
              />
            </SheetContent>
          </Sheet>
          <ConfirmDialog
            open={confirmingAll}
            onOpenChange={setConfirmingAll}
            icon={<CalendarCheck strokeWidth={1.75} />}
            title={
              draftCount === 1
                ? `Confirm the draft for ${year}?`
                : `Confirm all ${draftCount} drafts for ${year}?`
            }
            description="Confirmed holidays count for attendance, leave and payroll. There’s no unconfirm, but you can still edit or delete a confirmed holiday."
            confirmLabel="Confirm all"
            pending={confirmAll.pending}
            error={confirmAll.formError}
            onConfirm={() => {
              setMissingLegalBasis(null);
              void confirmAll.run({ year });
            }}
          >
            {missingLegalBasis ? (
              <div role="alert" className="flex flex-col gap-2">
                <p className="text-footnote font-medium text-destructive-text">
                  {missingLegalBasis.length === 1
                    ? 'This draft has no legal basis yet, so nothing was confirmed. Enter it first:'
                    : `${missingLegalBasis.length} drafts have no legal basis yet, so nothing was confirmed. Enter each one first:`}
                </p>
                <ul className="flex flex-col divide-y divide-separator overflow-hidden rounded-lg bg-bg-grouped">
                  {missingLegalBasis.map((draft) => {
                    const holiday = holidays.find((candidate) => candidate.id === draft.id);
                    return (
                      <li key={draft.id}>
                        {holiday ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              setConfirmingAll(false);
                              openSheet('edit', holiday, event.currentTarget);
                            }}
                            className="flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-left text-subheadline text-accent hover:bg-accent-subtle focus-visible:outline-offset-[-2px]"
                          >
                            <span className="font-medium">{draft.name}</span>
                            <span className="numeric text-footnote text-text-secondary">
                              {formatDate(draft.date)}
                            </span>
                          </button>
                        ) : (
                          <span className="flex min-h-11 items-center justify-between gap-3 px-3 py-2 text-subheadline">
                            <span className="font-medium">{draft.name}</span>
                            <span className="numeric text-footnote text-text-secondary">
                              {formatDate(draft.date)}
                            </span>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </ConfirmDialog>
        </>
      ) : null}
    </>
  );
}
