'use client';

import { useEffect, useId, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Banknote, CircleCheck, Search, Settings, Users } from 'lucide-react';
import {
  type DirectoryDepartmentOption,
  EMPLOYMENT_STATUS,
  EMPLOYMENT_STATUSES,
  type EmploymentStatus,
  formatDate,
} from '@pulse/core';
import type { EmployeeListRow, ExpiryAlertSettingsView } from '@pulse/talent';
import { Button, buttonVariants } from '@pulse/ui/components/button';
import {
  createDataTableColumns,
  DataTable,
  type DataTableColumn,
} from '@pulse/ui/components/data-table';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { Input, Select, Switch } from '@pulse/ui/components/form';
import { InspectorLayout } from '@pulse/ui/components/inspector-panel';
import { PageHeader } from '@pulse/ui/components/page-header';
import { Sheet, SheetContent } from '@pulse/ui/components/sheet';
import { useReturnFocus } from '@pulse/ui/hooks/use-return-focus';
import { Badge, plural } from '@/components/org-structure';
import { PersonAvatar } from '@/components/person-avatar';
import { ExpiryAlertsSheet } from './employee-documents-sheets';
import { EmployeeInspector, type InspectorTools, useEmployeeInspector } from './employee-inspector';

// Spec: docs/modules/talent.md#the-employee-record-build-step-21 (decision 168) — the employee
// list: stat tiles counting active employees by employment status, then a data table on a desktop
// and cards on a phone (avatar, name, employee number, department, position, status and date
// hired), sorted by last name, then first name (the server's order), with no paging. Search by
// name or employee number (`?q=`, 250 ms after the last key), filter by department
// (`?department=`) and status (`?status=`), and "Show separated" (`?separated=1`). A row opens the
// record in the inspector (`?employee=<employeeId>`). No sensitive field, date of birth or civil
// status is ever in the list.

const SEARCH_DELAY_MS = 250;
const countFormat = new Intl.NumberFormat('en-PH');

const ACTIVE_STATUSES = EMPLOYMENT_STATUSES.filter((s) => EMPLOYMENT_STATUS[s] === 'active');

function Badges({ row }: { row: EmployeeListRow }) {
  return (
    <>
      {row.separated ? <Badge>Separated</Badge> : null}
      {row.filledIn ? null : <Badge>Not filled in</Badge>}
    </>
  );
}

const column = createDataTableColumns<EmployeeListRow>();

const COLUMNS: DataTableColumn<EmployeeListRow>[] = column.columns([
  column.accessor('name', {
    header: 'Name',
    sortFn: 'text',
    cell: (info) => {
      const row = info.row.original;
      return (
        <span className="flex min-w-44 items-center gap-3 py-1">
          <PersonAvatar initials={row.initials} photoUrl={row.photoUrl} size="sm" />
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">{row.name}</span>
            <Badges row={row} />
          </span>
        </span>
      );
    },
  }),
  column.accessor('employeeNumber', {
    header: 'Number',
    sortFn: 'text',
    cell: (info) => <span className="numeric whitespace-nowrap">{info.getValue()}</span>,
    meta: { width: '6.5rem' },
  }),
  column.accessor((row) => row.department?.name ?? '', {
    id: 'department',
    header: 'Department',
    sortFn: 'text',
    cell: (info) => info.getValue() || '—',
  }),
  column.accessor((row) => row.position?.name ?? '', {
    id: 'position',
    header: 'Position',
    sortFn: 'text',
    cell: (info) => info.getValue() || '—',
  }),
  column.accessor('employmentStatus', {
    header: 'Status',
    sortFn: 'text',
    cell: (info) => info.getValue(),
  }),
  column.accessor('dateHired', {
    header: 'Date hired',
    sortFn: 'text',
    cell: (info) => (
      <span className="numeric whitespace-nowrap">{formatDate(info.getValue())}</span>
    ),
  }),
]);

function EmployeePhoneRow({ row }: { row: EmployeeListRow }) {
  const detail = [row.position?.name, row.department?.name].filter(Boolean).join(' · ');
  return (
    <>
      <PersonAvatar initials={row.initials} photoUrl={row.photoUrl} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-subheadline font-semibold">{row.name}</span>
          <Badges row={row} />
        </span>
        <span className="truncate text-footnote text-text-secondary">
          <span className="numeric">{row.employeeNumber}</span>
          {detail ? ` · ${detail}` : null}
        </span>
        <span className="truncate text-footnote text-text-secondary">
          {row.employmentStatus} · Hired{' '}
          <span className="numeric">{formatDate(row.dateHired)}</span>
        </span>
      </span>
    </>
  );
}

export function EmployeesManager({
  rows,
  stats,
  departments,
  search,
  departmentId,
  status,
  showSeparated,
  tools,
  expirySettings,
}: {
  rows: EmployeeListRow[];
  stats: { status: EmploymentStatus; count: number }[];
  departments: DirectoryDepartmentOption[];
  search: string;
  departmentId: string | null;
  status: EmploymentStatus | null;
  showSeparated: boolean;
  /** The inspector's product picker and upload limits. */
  tools: InspectorTools;
  /** The expiry alert lead days; the Settings button shows when `canChange` (Talent Owner). */
  expirySettings: ExpiryAlertSettingsView;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const inspector = useEmployeeInspector();
  const [filtering, startFiltering] = useTransition();
  const [query, setQuery] = useState(search);
  const searchTimer = useRef<number | undefined>(undefined);
  const searchId = useId();
  const departmentFilterId = useId();
  const statusFilterId = useId();
  const separatedId = useId();
  const statsId = useId();
  const settingsFocus = useReturnFocus();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSession, setSettingsSession] = useState(0);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);

  useEffect(() => () => window.clearTimeout(searchTimer.current), []);

  const filtered = search !== '' || departmentId !== null || status !== null;
  const knownDepartment =
    departmentId === null || departments.some((department) => department.id === departmentId);
  const statusOptions = showSeparated ? EMPLOYMENT_STATUSES : ACTIVE_STATUSES;
  const totalActive = stats.reduce((sum, stat) => sum + stat.count, 0);

  function setParams(changes: Record<string, string | null>) {
    // Kept: `?employee=` and the other filters.
    const params = new URLSearchParams(window.location.search);
    for (const [name, value] of Object.entries(changes)) {
      if (value) params.set(name, value);
      else params.delete(name);
    }
    const next = params.toString();
    startFiltering(() => {
      router.replace(`${pathname}${next ? `?${next}` : ''}`, { scroll: false });
    });
  }

  function searchFor(next: string) {
    setQuery(next);
    window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(
      () => setParams({ q: next.trim() || null }),
      SEARCH_DELAY_MS,
    );
  }

  function clearFilters() {
    window.clearTimeout(searchTimer.current);
    setQuery('');
    setParams({ q: null, department: null, status: null });
  }

  const previewRow = inspector.employeeId
    ? (rows.find((row) => row.employeeId === inspector.employeeId) ?? null)
    : null;

  return (
    <>
      <PageHeader
        title="Employees"
        description="Everyone’s employee record: personal and employment details, and for HR and Accounting, pay, government IDs and bank details."
        actions={
          <>
            {/* Step 2.3: Talent Read, which this page already needs. */}
            <Link
              href="/talent/payroll-settings"
              className={buttonVariants({ variant: 'secondary' })}
            >
              <Banknote aria-hidden="true" className="size-4.5" />
              Payroll settings
            </Link>
            {expirySettings.canChange ? (
              <Button
                variant="secondary"
                onClick={(event) => {
                  settingsFocus.remember(event.currentTarget);
                  setSettingsNotice(null);
                  setSettingsSession((count) => count + 1);
                  setSettingsOpen(true);
                }}
              >
                <Settings aria-hidden="true" className="size-4.5" />
                Settings
              </Button>
            ) : null}
          </>
        }
      />
      {expirySettings.canChange ? (
        <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
          <SheetContent
            aria-describedby={undefined}
            onCloseAutoFocus={settingsFocus.onCloseAutoFocus}
          >
            <ExpiryAlertsSheet
              key={settingsSession}
              settings={expirySettings}
              onSaved={(message) => {
                setSettingsOpen(false);
                setSettingsNotice(message);
                router.refresh();
              }}
            />
          </SheetContent>
        </Sheet>
      ) : null}
      <div role="status" className="empty:hidden">
        {settingsNotice ? (
          <p className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-footnote font-medium text-success-text shadow-card">
            <CircleCheck aria-hidden="true" className="mt-px size-4 shrink-0" />
            <span>{settingsNotice}</span>
          </p>
        ) : null}
      </div>

      <section aria-labelledby={statsId} className="flex flex-col gap-2">
        <h2 id={statsId} className="sr-only">
          Active employees by status, {countFormat.format(totalActive)} in all
        </h2>
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {stats.map((stat) => (
            <li
              key={stat.status}
              className="flex min-w-0 flex-col gap-1 rounded-card bg-surface p-4 shadow-card md:p-5"
            >
              <span className="text-subheadline font-semibold text-text-secondary">
                {stat.status}
              </span>
              <span className="numeric text-display">{countFormat.format(stat.count)}</span>
            </li>
          ))}
        </ul>
      </section>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <div className="flex w-full flex-col gap-1.5 sm:w-72">
            <label htmlFor={searchId} className="text-footnote font-semibold text-text-secondary">
              Search
            </label>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 size-4.5 -translate-y-1/2 text-text-secondary"
              />
              <Input
                id={searchId}
                type="search"
                value={query}
                onChange={(event) => searchFor(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    window.clearTimeout(searchTimer.current);
                    setParams({ q: query.trim() || null });
                  }
                }}
                placeholder="Name or employee number"
                autoComplete="off"
                spellCheck={false}
                maxLength={100}
                className="pl-10"
              />
            </div>
          </div>
          <div className="flex w-full flex-col gap-1.5 sm:w-56">
            <label
              htmlFor={departmentFilterId}
              className="text-footnote font-semibold text-text-secondary"
            >
              Department
            </label>
            <Select
              id={departmentFilterId}
              value={departmentId ?? ''}
              onChange={(event) => setParams({ department: event.target.value || null })}
              disabled={filtering}
              aria-busy={filtering || undefined}
            >
              <option value="">All departments</option>
              {!knownDepartment && departmentId ? (
                <option value={departmentId}>Unknown department</option>
              ) : null}
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex w-full flex-col gap-1.5 sm:w-48">
            <label
              htmlFor={statusFilterId}
              className="text-footnote font-semibold text-text-secondary"
            >
              Status
            </label>
            <Select
              id={statusFilterId}
              value={status ?? ''}
              onChange={(event) => setParams({ status: event.target.value || null })}
              disabled={filtering}
              aria-busy={filtering || undefined}
            >
              <option value="">All statuses</option>
              {status && !statusOptions.includes(status) ? (
                <option value={status}>{status}</option>
              ) : null}
              {statusOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex min-h-11 items-center gap-3 sm:ml-auto" aria-busy={filtering}>
            <label htmlFor={separatedId} className="text-subheadline font-medium text-text-primary">
              Show separated
            </label>
            <Switch
              id={separatedId}
              checked={showSeparated}
              onCheckedChange={(next) => setParams({ separated: next ? '1' : null })}
              disabled={filtering}
            />
          </div>
        </div>
        <p role="status" className="numeric text-footnote text-text-secondary">
          {plural(rows.length, 'employee', 'employees')}
          {showSeparated ? ', separated included' : null}
        </p>
      </div>

      <InspectorLayout>
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {rows.length > 0 ? (
            <DataTable
              caption="Employees"
              captionHidden
              columns={COLUMNS}
              data={rows}
              getRowId={(row) => row.employeeId}
              selectedRowId={inspector.open ? inspector.employeeId : null}
              rowActionLabel={(row) => `Open ${row.name}’s record`}
              onRowSelect={(row, element) => inspector.openEmployee(row.employeeId, element)}
              renderPhoneRow={(row) => <EmployeePhoneRow row={row} />}
              loading={filtering}
            />
          ) : filtered ? (
            <EmptyState
              icon={<Search strokeWidth={1.75} />}
              title="No one matches"
              description={
                showSeparated
                  ? 'Try another name, number, department or status.'
                  : 'Try another name, number, department or status, or turn on “Show separated”.'
              }
              action={
                <Button variant="tinted" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<Users strokeWidth={1.75} />}
              title="No employees yet"
              description="Employees show up here once HR adds them in Users."
            />
          )}
        </div>

        <EmployeeInspector
          open={inspector.open}
          onOpenChange={inspector.changeOpen}
          employeeId={inspector.employeeId}
          session={inspector.session}
          returnFocus={inspector.returnFocus}
          preview={
            previewRow
              ? { name: previewRow.name, positionName: previewRow.position?.name ?? null }
              : null
          }
          separated={showSeparated}
          tools={tools}
        />
      </InspectorLayout>
    </>
  );
}
