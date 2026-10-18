'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, CalendarClock, Search, Users } from 'lucide-react';
import { formatDate } from '@pulse/core';
import { formatLeaveDays, formatOffsetHours, GO_LIVE_DATE_MISSING_MESSAGE } from '@pulse/talent';
import type { OpeningBalanceRow, OpeningBalancesView } from '@pulse/talent/server';
import { cn } from '@pulse/ui';
import { Button, buttonVariants } from '@pulse/ui/components/button';
import {
  createDataTableColumns,
  DataTable,
  type DataTableColumn,
} from '@pulse/ui/components/data-table';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { Input } from '@pulse/ui/components/form';
import { PageHeader } from '@pulse/ui/components/page-header';
import { Sheet, SheetContent } from '@pulse/ui/components/sheet';
import { useReturnFocus } from '@pulse/ui/hooks/use-return-focus';
import { Badge, plural } from '@/components/org-structure';
import { EmployeeOpeningSheet } from './opening-balance-sheets';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Opening
// balances") and docs/DESIGN_SYSTEM.md#layout--components ("Opening balances is a list of people
// on a phone and a data table on a desktop, with each person's VL, SL and offset in tabular
// numerals, and 'Year-to-date pay: Entered' or 'Not entered' as a text badge, never an amount.
// 'Enter' opens a sheet.").
//
// - While the go-live date isn't set: "Set the go-live date first.", linking to Payroll settings.
// - Every employee hired before the go-live date (and not separated before it), sorted by name
//   (the server's order), filtered here by name or employee number. Each credited type's and
//   offset's opening, or "Not entered".
// - A row (or `?employee=<employeeId>`) opens `EmployeeOpeningSheet`; after a save the page data
//   refreshes, and the open sheet shows the new row.

const SEARCH_MAX_LENGTH = 100;

function YearToDateBadge({ row }: { row: OpeningBalanceRow }) {
  const entered = row.payrollOpening === 'entered';
  return (
    <Badge tone={entered ? 'accent' : 'neutral'}>
      {entered ? 'Year-to-date pay: Entered' : 'Year-to-date pay: Not entered'}
    </Badge>
  );
}

function OpeningText({ value }: { value: string | null }) {
  return value === null ? (
    <span className="text-text-secondary">Not entered</span>
  ) : (
    <span className="numeric">{value}</span>
  );
}

const leaveOpening = (row: OpeningBalanceRow, typeKey: string) => {
  const cell = row.leave.find((item) => item.typeKey === typeKey);
  return cell && cell.openingHalfDays !== null ? formatLeaveDays(cell.openingHalfDays) : null;
};
const offsetOpening = (row: OpeningBalanceRow) =>
  row.offset.openingMinutes === null ? null : formatOffsetHours(row.offset.openingMinutes);

/** A row has every opening (leave and offset) entered. */
const openingsComplete = (row: OpeningBalanceRow) =>
  row.leave.every((cell) => cell.openingHalfDays !== null) && row.offset.openingMinutes !== null;

function PhoneRow({ row }: { row: OpeningBalanceRow }) {
  const openings = [
    ...row.leave.map((cell) => {
      const value = cell.openingHalfDays === null ? null : formatLeaveDays(cell.openingHalfDays);
      return `${cell.shortName} ${value ?? 'not entered'}`;
    }),
    `Offset ${offsetOpening(row) ?? 'not entered'}`,
  ].join(' · ');
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="truncate text-subheadline font-semibold">{row.name}</span>
        {row.separated ? <Badge>Separated</Badge> : null}
      </span>
      <span className="truncate text-footnote text-text-secondary">
        <span className="numeric">{row.employeeNumber}</span>
        {row.department ? ` · ${row.department}` : null}
      </span>
      <span className="numeric text-footnote break-words text-text-primary">{openings}</span>
      <span>
        <YearToDateBadge row={row} />
      </span>
    </span>
  );
}

function replaceEmployeeParam(employeeId: string | null) {
  const params = new URLSearchParams(window.location.search);
  if (employeeId) params.set('employee', employeeId);
  else params.delete('employee');
  const query = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
}

export function OpeningBalancesManager({ view }: { view: OpeningBalancesView }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState('');
  const focus = useReturnFocus();
  const [openId, setOpenId] = useState<string | null>(() => searchParams.get('employee'));
  const [open, setOpen] = useState(() => searchParams.get('employee') !== null);
  const [session, setSession] = useState(0);

  const columns = useMemo((): DataTableColumn<OpeningBalanceRow>[] => {
    const column = createDataTableColumns<OpeningBalanceRow>();
    return column.columns([
      column.accessor('name', {
        header: 'Name',
        sortFn: 'text',
        cell: (info) => {
          const row = info.row.original;
          return (
            <span className="flex min-w-40 flex-col gap-0.5 py-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium">{row.name}</span>
                {row.separated ? <Badge>Separated</Badge> : null}
              </span>
              <span className="numeric text-footnote text-text-secondary">
                {row.employeeNumber}
              </span>
            </span>
          );
        },
      }),
      column.accessor((row) => row.department ?? '', {
        id: 'department',
        header: 'Department',
        sortFn: 'text',
        cell: (info) => info.getValue() || '—',
      }),
      ...view.leaveTypes.map((type) =>
        column.accessor((row) => leaveOpening(row, type.key) ?? '', {
          id: `leave-${type.key}`,
          header: type.shortName,
          sortFn: 'text',
          cell: (info) => <OpeningText value={leaveOpening(info.row.original, type.key)} />,
          meta: { numeric: true, width: '7.5rem' },
        }),
      ),
      column.accessor((row) => offsetOpening(row) ?? '', {
        id: 'offset',
        header: 'Offset',
        sortFn: 'text',
        cell: (info) => <OpeningText value={offsetOpening(info.row.original)} />,
        meta: { numeric: true, width: '7.5rem' },
      }),
      column.accessor('payrollOpening', {
        header: 'Year-to-date pay',
        sortFn: 'text',
        cell: (info) => (
          <Badge tone={info.getValue() === 'entered' ? 'accent' : 'neutral'}>
            {info.getValue() === 'entered' ? 'Entered' : 'Not entered'}
          </Badge>
        ),
        meta: { width: '10rem' },
      }),
    ]);
  }, [view.leaveTypes]);

  const search = query.trim().toLowerCase();
  const rows = useMemo(
    () =>
      search
        ? view.rows.filter(
            (row) =>
              row.name.toLowerCase().includes(search) ||
              row.employeeNumber.toLowerCase().includes(search),
          )
        : view.rows,
    [view.rows, search],
  );

  const openRow = openId ? (view.rows.find((row) => row.employeeId === openId) ?? null) : null;
  const complete = view.rows.filter(openingsComplete).length;
  const payEntered = view.rows.filter((row) => row.payrollOpening === 'entered').length;

  function openEmployee(row: OpeningBalanceRow, trigger: HTMLElement) {
    focus.remember(trigger);
    replaceEmployeeParam(row.employeeId);
    setOpenId(row.employeeId);
    setSession((count) => count + 1);
    setOpen(true);
  }

  function changeOpen(next: boolean) {
    setOpen(next);
    if (!next) replaceEmployeeParam(null);
  }

  return (
    <>
      <div className="flex flex-col gap-3">
        <Link
          href="/talent"
          className={buttonVariants({ variant: 'plain', className: '-ml-3 w-fit text-accent' })}
        >
          <ArrowLeft aria-hidden="true" className="size-4.5" />
          Employees
        </Link>
        <PageHeader
          title="Opening balances"
          description="Each existing employee’s VL, SL and offset balances and year-to-date pay as of the go-live date, entered once as dated, audit-logged entries."
        />
      </div>

      {view.goLiveDate === null ? (
        <EmptyState
          icon={<CalendarClock strokeWidth={1.75} />}
          title={GO_LIVE_DATE_MISSING_MESSAGE}
          description="Opening balances are entered as of the day Pulse Talent goes live. A Talent Owner in HR sets it in Payroll settings › Leave."
          action={
            <Link href="/talent/payroll-settings" className={buttonVariants({ variant: 'tinted' })}>
              Payroll settings
            </Link>
          }
        />
      ) : (
        <>
          <p className="flex flex-col gap-1 rounded-card bg-surface px-4 py-3 text-footnote text-text-secondary shadow-card sm:flex-row sm:flex-wrap sm:gap-x-3">
            <span>
              As of{' '}
              <span className="numeric font-semibold text-text-primary">
                {formatDate(view.goLiveDate)}
              </span>
              , the go-live date. Year-to-date pay is for{' '}
              <span className="numeric">{view.year}</span>.
            </span>
            <span className="numeric">
              {plural(view.rows.length, 'employee', 'employees')} · {complete} with every opening
              balance · {payEntered} with year-to-date pay
            </span>
          </p>

          {view.rows.length > 0 ? (
            <div className="flex flex-col gap-3">
              <div className="relative w-full sm:max-w-80">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-3 size-4.5 -translate-y-1/2 text-text-secondary"
                />
                <Input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  maxLength={SEARCH_MAX_LENGTH}
                  placeholder="Search by name or number"
                  aria-label="Search by name or employee number"
                  className="pl-9"
                />
              </div>
              {rows.length > 0 ? (
                <DataTable
                  caption="Opening balances"
                  captionHidden
                  columns={columns}
                  data={rows}
                  getRowId={(row) => row.employeeId}
                  selectedRowId={open ? openId : null}
                  rowActionLabel={(row) => `Opening balances for ${row.name}`}
                  onRowSelect={openEmployee}
                  renderPhoneRow={(row) => <PhoneRow row={row} />}
                />
              ) : (
                <EmptyState
                  icon={<Search strokeWidth={1.75} />}
                  title="No one matches"
                  description="Try another name or employee number."
                  action={
                    <Button variant="tinted" onClick={() => setQuery('')}>
                      Clear search
                    </Button>
                  }
                />
              )}
            </div>
          ) : (
            <EmptyState
              icon={<Users strokeWidth={1.75} />}
              title="No one to enter"
              description="No employee was hired before the go-live date. People hired from it on start with no opening balance."
            />
          )}
        </>
      )}

      <Sheet open={open && openRow !== null} onOpenChange={changeOpen}>
        <SheetContent
          aria-describedby={undefined}
          onCloseAutoFocus={focus.onCloseAutoFocus}
          className={cn('sm:w-[min(36rem,calc(100vw-2rem))]')}
        >
          {openRow ? (
            <EmployeeOpeningSheet
              key={`${openRow.employeeId}:${session}`}
              row={openRow}
              view={view}
              onChanged={() => router.refresh()}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
