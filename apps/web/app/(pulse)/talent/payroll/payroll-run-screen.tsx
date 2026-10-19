'use client';

import { useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Eye, RotateCw, ShieldCheck, Users, UserX } from 'lucide-react';
import { type Centavos, formatDate, TIMESHEET_TYPE_LABELS } from '@pulse/core';
import {
  formatPeriodRange,
  PAYROLL_DRAFT_NOTE,
  PAYROLL_LEFT_OUT_LABEL,
  PAYROLL_NEGATIVE_NET_LABEL,
  PAYROLL_REVEAL_NOTE,
  PAYROLL_TIMESHEET_NOT_APPROVED_LABEL,
  type PayrollTotals,
} from '@pulse/talent';
import type { PayrollRunPersonRow, PayrollRunView } from '@pulse/talent/server';
import { cn } from '@pulse/ui';
import { Button, buttonVariants } from '@pulse/ui/components/button';
import {
  createDataTableColumns,
  DataTable,
  type DataTableColumn,
} from '@pulse/ui/components/data-table';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { PageHeader } from '@pulse/ui/components/page-header';
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
} from '@pulse/ui/components/sheet';
import { useReturnFocus } from '@pulse/ui/hooks/use-return-focus';
import { FormAlert } from '@/components/form-alert';
import { Badge, plural, useActionSubmit } from '@/components/org-structure';
import {
  type PayrollAmounts,
  recomputePayrollRunAction,
  showPayrollAmountsAction,
} from '@/lib/actions/talent-payroll-runs';
import { PAYROLL_HREF } from '@/lib/navigation';
import { PersonMarks, personMarksText } from './payroll-badges';
import {
  loadPayrollBreakdown,
  type PayrollBreakdownLoad,
  PayrollBreakdownSheet,
} from './payroll-breakdown-sheet';
import { pesoText } from './payroll-format';
import { computedText } from './payroll-runs-list';

// Spec: docs/modules/talent.md#payroll-run-computation-build-step-29 ("Recomputing a draft", "Who
// may see and do what", "Screens": `/talent/payroll/<runId>`) and
// docs/DESIGN_SYSTEM.md#layout--components ("Payroll runs on a phone": the run page, People, the
// breakdown sheet) — one run, read-only.
//
// - The large title is the period; under it the pay date, number and status badge, "Computed <when>
//   by <name>" (or "by the nightly job") and, for a draft, the draft note in `text-secondary`.
// - Tiles count Employees, "Timesheet not approved", "Net pay below zero" and "Left out"; each is a
//   filter (a second press shows everyone). "Left out" shows the people left out of the run.
// - Amounts are hidden behind "Show amounts", with the reveal note. Pressing it calls the reveal
//   action (a `reveal` on the run is written first); afterwards the totals sit in an inset grouped
//   list and each person's net pay shows in tabular numerals. The amounts live in this component's
//   state only; the page is keyed by the run's version, so a recompute drops them.
// - People are a list on a phone and a data table on a desktop. A row opens the breakdown sheet,
//   fetched from that click (a `reveal` on the line first).
// - "Recompute" (the server's `canRecompute`) asks for confirmation in a sheet; the page then
//   reloads without amounts.

type Filter = 'all' | 'notApproved' | 'negativeNet' | 'leftOut';

const countFormat = new Intl.NumberFormat('en-PH');
const AMOUNTS_FAILED = 'Amounts couldn’t load. Check your connection and try again.';
const RECOMPUTE_FAILED = 'The run wasn’t recomputed. Check your connection and try again.';
const RUN_CHANGED =
  'This run was recomputed since the page loaded. Reload the page, then show amounts again.';

const TOTAL_ROWS: { key: keyof PayrollTotals; label: string; strong?: boolean }[] = [
  { key: 'grossCentavos', label: 'Gross pay' },
  { key: 'deductionsCentavos', label: 'Total deductions' },
  { key: 'netPayCentavos', label: 'Net pay', strong: true },
  { key: 'reimbursementsCentavos', label: 'Reimbursements (in net pay)' },
  { key: 'taxWithheldCentavos', label: 'Tax withheld' },
  { key: 'employeeContributionsCentavos', label: 'Employee contributions' },
  { key: 'employerContributionsCentavos', label: 'Employer contributions' },
];

function Totals({ totals }: { totals: PayrollTotals }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <h2 id={titleId} className="px-4 text-footnote font-semibold text-text-secondary">
        Totals
      </h2>
      <dl className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
        {TOTAL_ROWS.map((row) => (
          <div
            key={row.key}
            className="flex min-h-11 items-center justify-between gap-4 px-4 py-2.5"
          >
            <dt className={cn('text-subheadline', row.strong && 'font-semibold')}>{row.label}</dt>
            <dd
              className={cn(
                'shrink-0 text-right text-subheadline numeric',
                row.strong && 'font-semibold',
              )}
            >
              {pesoText(totals[row.key])}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function personDetails(person: PayrollRunPersonRow): string {
  return [
    person.employeeNumber,
    person.department,
    person.timesheetType ? TIMESHEET_TYPE_LABELS[person.timesheetType] : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function PhonePerson({ person, netPay }: { person: PayrollRunPersonRow; netPay: Centavos | null }) {
  return (
    <span className="flex min-w-0 flex-1 items-start justify-between gap-3">
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-subheadline font-semibold break-words">{person.name}</span>
        <span className="text-footnote break-words text-text-secondary numeric">
          {personDetails(person)}
        </span>
        <PersonMarks person={person} />
      </span>
      {netPay !== null ? (
        <span className="shrink-0 text-right text-subheadline font-semibold numeric">
          {pesoText(netPay)}
        </span>
      ) : null}
    </span>
  );
}

/** "Recompute": the confirmation sheet. */
function RecomputeSheet({ runId, onDone }: { runId: string; onDone: () => void }) {
  const [networkError, setNetworkError] = useState<string | null>(null);
  const save = useActionSubmit(recomputePayrollRunAction, onDone);

  async function submit() {
    setNetworkError(null);
    try {
      await save.run({ runId });
    } catch {
      setNetworkError(RECOMPUTE_FAILED);
    }
  }

  return (
    <>
      <SheetHeader
        title="Recompute this run?"
        description="Every employee’s line is computed again from the DTR, time off, reimbursements, pay and settings as they are now."
      />
      <SheetBody>
        <FormAlert message={save.fieldErrors.runId ?? save.formError ?? networkError} />
        <p className="text-subheadline text-text-secondary">
          The figures may change. Amounts shown on this page are hidden again afterwards; show them
          again to see the new ones. Nothing is paid until the run is finalized.
        </p>
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="secondary">Cancel</Button>
        </SheetClose>
        <Button onClick={() => void submit()} loading={save.pending}>
          <RotateCw aria-hidden="true" className="size-4.5" />
          Recompute
        </Button>
      </SheetFooter>
    </>
  );
}

export function PayrollRunScreen({ view }: { view: PayrollRunView }) {
  const router = useRouter();
  const tilesId = useId();
  const [filter, setFilter] = useState<Filter>('all');
  const [amounts, setAmounts] = useState<PayrollAmounts | null>(null);
  const [amountsPending, setAmountsPending] = useState(false);
  const [amountsError, setAmountsError] = useState<string | null>(null);
  const amountsBusy = useRef(false);

  const recomputeFocus = useReturnFocus();
  const [recomputeOpen, setRecomputeOpen] = useState(false);
  const [recomputeSession, setRecomputeSession] = useState(0);

  const breakdownFocus = useReturnFocus();
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [breakdownPerson, setBreakdownPerson] = useState<PayrollRunPersonRow | null>(null);
  const [breakdown, setBreakdown] = useState<PayrollBreakdownLoad>({ state: 'loading' });
  const breakdownRequest = useRef(0);

  const netPayOf = useMemo(
    () => new Map((amounts?.netPay ?? []).map((row) => [row.lineId, row.netPayCentavos])),
    [amounts],
  );

  async function showAmounts() {
    if (amountsBusy.current) return;
    amountsBusy.current = true;
    setAmountsPending(true);
    setAmountsError(null);
    try {
      const result = await showPayrollAmountsAction(null, { runId: view.id });
      if (!result.ok) setAmountsError(result.formError ?? AMOUNTS_FAILED);
      else if (!result.data) setAmountsError(RUN_CHANGED);
      else if (result.data.version !== view.version) setAmountsError(RUN_CHANGED);
      else setAmounts(result.data);
    } catch {
      setAmountsError(AMOUNTS_FAILED);
    } finally {
      amountsBusy.current = false;
      setAmountsPending(false);
    }
  }

  async function fetchBreakdown(person: PayrollRunPersonRow) {
    const request = (breakdownRequest.current += 1);
    setBreakdown({ state: 'loading' });
    const loaded = await loadPayrollBreakdown(view.id, person.lineId);
    // A later opening (another person) wins.
    if (breakdownRequest.current === request) setBreakdown(loaded);
  }

  function openPerson(person: PayrollRunPersonRow, trigger: HTMLElement) {
    breakdownFocus.remember(trigger);
    setBreakdownPerson(person);
    setBreakdownOpen(true);
    void fetchBreakdown(person);
  }

  function changeBreakdownOpen(next: boolean) {
    setBreakdownOpen(next);
    if (!next) {
      // Drop the breakdown as soon as the sheet closes.
      breakdownRequest.current += 1;
      setBreakdown({ state: 'loading' });
    }
  }

  const people = useMemo(() => {
    if (filter === 'notApproved') return view.people.filter((person) => person.provisional);
    if (filter === 'negativeNet') return view.people.filter((person) => person.negativeNet);
    return view.people;
  }, [filter, view.people]);

  const shown = amounts !== null;
  const columns = useMemo((): DataTableColumn<PayrollRunPersonRow>[] => {
    const column = createDataTableColumns<PayrollRunPersonRow>();
    return column.columns([
      column.accessor('name', {
        header: 'Name',
        sortFn: 'text',
        cell: (info) => (
          <span className="flex min-w-40 flex-col gap-0.5 py-1">
            <span className="font-medium">{info.row.original.name}</span>
            <span className="numeric text-footnote text-text-secondary">
              {info.row.original.employeeNumber}
            </span>
          </span>
        ),
      }),
      column.accessor((row) => row.department ?? '', {
        id: 'department',
        header: 'Department',
        sortFn: 'text',
        cell: (info) => info.getValue() || '—',
      }),
      column.accessor(
        (row) => (row.timesheetType ? TIMESHEET_TYPE_LABELS[row.timesheetType] : ''),
        {
          id: 'timesheetType',
          header: 'Timesheet',
          sortFn: 'text',
          cell: (info) => info.getValue() || '—',
          meta: { width: '8rem' },
        },
      ),
      column.display({
        id: 'marks',
        header: 'Notes',
        cell: (info) => <PersonMarks person={info.row.original} />,
      }),
      ...(shown
        ? [
            column.accessor((row) => netPayOf.get(row.lineId) ?? 0, {
              id: 'netPay',
              header: 'Net pay',
              sortFn: 'basic',
              cell: (info) => {
                const value = netPayOf.get(info.row.original.lineId);
                return value === undefined ? '—' : pesoText(value);
              },
              meta: { align: 'end' as const, width: '9rem' },
            }),
          ]
        : []),
    ]);
  }, [shown, netPayOf]);

  const tiles: { filter: Filter; label: string; count: number }[] = [
    { filter: 'all', label: 'Employees', count: view.tiles.employees },
    {
      filter: 'notApproved',
      label: PAYROLL_TIMESHEET_NOT_APPROVED_LABEL,
      count: view.tiles.timesheetNotApproved,
    },
    { filter: 'negativeNet', label: PAYROLL_NEGATIVE_NET_LABEL, count: view.tiles.negativeNet },
    { filter: 'leftOut', label: PAYROLL_LEFT_OUT_LABEL, count: view.tiles.leftOut },
  ];
  const filterLabel = tiles.find((tile) => tile.filter === filter)?.label ?? '';
  const draft = view.status === 'draft';

  return (
    <>
      <div className="flex flex-col gap-3">
        <Link
          href={PAYROLL_HREF}
          className={buttonVariants({ variant: 'plain', className: '-ml-3 w-fit text-accent' })}
        >
          <ArrowLeft aria-hidden="true" className="size-4.5" />
          Payroll
        </Link>
        <PageHeader
          title={formatPeriodRange(view.periodStart, view.periodEnd)}
          description={
            <span className="flex flex-col gap-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1 numeric">
                <span>Paid {formatDate(view.payDate)}</span>
                <span aria-hidden="true">·</span>
                <span>{view.number}</span>
                <Badge tone={draft ? 'neutral' : 'accent'}>{view.statusLabel}</Badge>
              </span>
              <span className="text-footnote numeric">{computedText(view)}</span>
              {draft ? <span className="text-footnote">{PAYROLL_DRAFT_NOTE}</span> : null}
            </span>
          }
          actions={
            view.canRecompute ? (
              <Button
                variant="secondary"
                onClick={(event) => {
                  recomputeFocus.remember(event.currentTarget);
                  setRecomputeSession((count) => count + 1);
                  setRecomputeOpen(true);
                }}
              >
                <RotateCw aria-hidden="true" className="size-4.5" />
                Recompute
              </Button>
            ) : null
          }
        />
      </div>

      <section aria-labelledby={tilesId} className="flex flex-col gap-2">
        <h2 id={tilesId} className="sr-only">
          The run at a glance
        </h2>
        <ul className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {tiles.map((tile) => {
            const pressed = filter === tile.filter && tile.filter !== 'all';
            return (
              <li key={tile.filter} className="flex min-w-0">
                <button
                  type="button"
                  onClick={() =>
                    setFilter(filter === tile.filter || tile.filter === 'all' ? 'all' : tile.filter)
                  }
                  aria-pressed={tile.filter === 'all' ? filter === 'all' : pressed}
                  aria-label={`${tile.label}: ${countFormat.format(tile.count)}. ${
                    tile.filter === 'all' || pressed ? 'Show everyone' : 'Show only these'
                  }`}
                  className={cn(
                    'flex min-w-0 flex-1 flex-col gap-1 rounded-card bg-surface p-4 text-left shadow-card md:p-5',
                    'hover:bg-accent-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                    pressed && 'ring-2 ring-accent',
                  )}
                >
                  <span className="text-subheadline font-semibold break-words text-text-secondary">
                    {tile.label}
                  </span>
                  <span className="numeric text-display">{countFormat.format(tile.count)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {amounts ? (
        <Totals totals={amounts.totals} />
      ) : (
        <div className="flex flex-col gap-2 rounded-card bg-surface px-4 py-3 shadow-card sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-start gap-2 text-footnote text-text-secondary">
            <ShieldCheck aria-hidden="true" className="mt-px size-4 shrink-0" />
            <span>Amounts are hidden. {PAYROLL_REVEAL_NOTE}</span>
          </p>
          <Button
            variant="secondary"
            onClick={() => void showAmounts()}
            loading={amountsPending}
            className="w-full sm:w-auto"
          >
            <Eye aria-hidden="true" className="size-4.5" />
            Show amounts
          </Button>
        </div>
      )}
      <FormAlert message={amountsError} />
      {amountsError === RUN_CHANGED ? (
        <Button variant="tinted" onClick={() => router.refresh()} className="w-fit">
          Reload the page
        </Button>
      ) : null}

      {filter === 'leftOut' ? (
        <section aria-label={PAYROLL_LEFT_OUT_LABEL} className="flex flex-col gap-2">
          <p role="status" className="text-footnote text-text-secondary numeric">
            {plural(view.leftOut.length, 'person', 'people')} left out
          </p>
          {view.leftOut.length > 0 ? (
            <ul className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
              {view.leftOut.map((person) => (
                <li
                  key={person.employeeId}
                  className="flex min-h-16 items-center gap-3 px-4 py-3 md:px-5"
                >
                  <UserX aria-hidden="true" className="size-5 shrink-0 text-text-secondary" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-subheadline font-semibold break-words">
                      {person.name}
                    </span>
                    <span className="text-footnote break-words text-text-secondary">
                      <span className="numeric">{person.employeeNumber}</span>
                      {` · ${person.reasonLabel}`}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={<Users strokeWidth={1.75} />}
              title="No one left out"
              description="Everyone employed during the cut-off has a salary on file and is in the run."
            />
          )}
        </section>
      ) : (
        <section aria-label="People" className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p role="status" className="text-footnote text-text-secondary numeric">
              {filter === 'all'
                ? plural(people.length, 'employee', 'employees')
                : `${plural(people.length, 'employee', 'employees')} · ${filterLabel}`}
            </p>
            {filter !== 'all' ? (
              <Button variant="plain" onClick={() => setFilter('all')} className="min-h-11">
                Show everyone
              </Button>
            ) : null}
          </div>
          {people.length > 0 ? (
            <DataTable
              caption="People in the run"
              captionHidden
              columns={columns}
              data={people}
              getRowId={(row) => row.lineId}
              selectedRowId={breakdownOpen ? (breakdownPerson?.lineId ?? null) : null}
              rowActionLabel={(row) =>
                [`Breakdown for ${row.name}`, ...personMarksText(row)].join(', ')
              }
              onRowSelect={openPerson}
              renderPhoneRow={(row) => (
                <PhonePerson person={row} netPay={netPayOf.get(row.lineId) ?? null} />
              )}
            />
          ) : (
            <EmptyState
              icon={<Users strokeWidth={1.75} />}
              title={filter === 'all' ? 'No one in this run' : `None: ${filterLabel.toLowerCase()}`}
              description={
                filter === 'all'
                  ? 'No employee with a salary on file was employed during the cut-off.'
                  : 'No one in this run is marked this way.'
              }
              action={
                filter !== 'all' ? (
                  <Button variant="tinted" onClick={() => setFilter('all')}>
                    Show everyone
                  </Button>
                ) : undefined
              }
            />
          )}
        </section>
      )}

      {view.canRecompute ? (
        <Sheet open={recomputeOpen} onOpenChange={setRecomputeOpen}>
          <SheetContent onCloseAutoFocus={recomputeFocus.onCloseAutoFocus}>
            <RecomputeSheet
              key={recomputeSession}
              runId={view.id}
              onDone={() => {
                setRecomputeOpen(false);
                router.refresh();
              }}
            />
          </SheetContent>
        </Sheet>
      ) : null}

      <Sheet open={breakdownOpen && breakdownPerson !== null} onOpenChange={changeBreakdownOpen}>
        <SheetContent
          onCloseAutoFocus={breakdownFocus.onCloseAutoFocus}
          className="sm:w-[min(40rem,calc(100vw-2rem))]"
        >
          {breakdownPerson ? (
            <PayrollBreakdownSheet
              name={breakdownPerson.name}
              loaded={breakdown}
              onRetry={() => void fetchBreakdown(breakdownPerson)}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
