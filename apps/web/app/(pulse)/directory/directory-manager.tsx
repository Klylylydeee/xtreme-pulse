'use client';

import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Contact, Search } from 'lucide-react';
import type { DirectoryDepartmentOption, DirectoryPerson } from '@pulse/core';
import { Button } from '@pulse/ui/components/button';
import {
  createDataTableColumns,
  DataTable,
  type DataTableColumn,
} from '@pulse/ui/components/data-table';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { Input, Select, Switch } from '@pulse/ui/components/form';
import { InspectorLayout } from '@pulse/ui/components/inspector-panel';
import { PageHeader } from '@pulse/ui/components/page-header';
import { Badge, plural } from '@/components/org-structure';
import { PersonAvatar } from '@/components/person-avatar';
import {
  PersonInspector,
  type PersonInspectorViewer,
  usePersonInspector,
} from '@/components/person-inspector';

// Spec: docs/modules/core.md#company-directory — the directory list (build step 1.11): everyone
// whose account is active, by last name, then first name (the server's order, the table's default),
// with no paging. Each row has the avatar (initials until Phase 2) and the name, then the employee
// number, position, department and login email: a table on desktop, a list on a phone. Search by
// name, employee number or email (`?q=`, 250 ms after the last key), filter by department
// (`?department=`), and, for HR and System Administrators only, "Show separated" (`?separated=1`,
// shown with an "Inactive" badge). A row opens the person's card in the inspector
// (`?person=<employeeId>`).

const SEARCH_DELAY_MS = 250;

const column = createDataTableColumns<DirectoryPerson>();

const COLUMNS: DataTableColumn<DirectoryPerson>[] = column.columns([
  column.accessor('name', {
    header: 'Name',
    sortFn: 'text',
    cell: (info) => {
      const person = info.row.original;
      return (
        <span className="flex min-w-44 items-center gap-3 py-1">
          <PersonAvatar initials={person.initials} photoUrl={person.photoUrl} size="sm" />
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">{person.name}</span>
            {person.inactive ? <Badge>Inactive</Badge> : null}
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
  column.accessor((person) => person.positionName ?? '', {
    id: 'position',
    header: 'Position',
    sortFn: 'text',
    cell: (info) => info.getValue() || '—',
  }),
  column.accessor((person) => person.departmentName ?? '', {
    id: 'department',
    header: 'Department',
    sortFn: 'text',
    cell: (info) => info.getValue() || '—',
  }),
  column.accessor((person) => person.email ?? '', {
    id: 'email',
    header: 'Email',
    sortFn: 'text',
    cell: (info) => (
      <span title={info.getValue() || undefined} className="block max-w-60 truncate">
        {info.getValue() || '—'}
      </span>
    ),
  }),
]);

function PersonPhoneRow({ person }: { person: DirectoryPerson }) {
  const detail = [person.positionName, person.departmentName].filter(Boolean).join(' · ');
  return (
    <>
      <PersonAvatar initials={person.initials} photoUrl={person.photoUrl} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-subheadline font-semibold">{person.name}</span>
          {person.inactive ? <Badge>Inactive</Badge> : null}
        </span>
        <span className="truncate text-footnote text-text-secondary">
          <span className="numeric">{person.employeeNumber}</span>
          {detail ? ` · ${detail}` : null}
        </span>
        {person.email ? (
          <span className="truncate text-footnote text-text-secondary">{person.email}</span>
        ) : null}
      </span>
    </>
  );
}

export function DirectoryManager({
  people,
  departments,
  search,
  departmentId,
  showSeparated,
  boardDepartmentCode,
  viewer,
}: {
  people: DirectoryPerson[];
  departments: DirectoryDepartmentOption[];
  /** The filters, from the URL. */
  search: string;
  departmentId: string | null;
  showSeparated: boolean;
  boardDepartmentCode: string;
  viewer: PersonInspectorViewer;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const inspector = usePersonInspector();
  const [filtering, startFiltering] = useTransition();
  const [query, setQuery] = useState(search);
  const searchTimer = useRef<number | undefined>(undefined);
  const searchId = useId();
  const departmentFilterId = useId();
  const separatedId = useId();

  useEffect(() => () => window.clearTimeout(searchTimer.current), []);

  const filtered = search !== '' || departmentId !== null;
  const knownDepartment =
    departmentId === null || departments.some((department) => department.id === departmentId);

  function setParams(changes: Record<string, string | null>) {
    // Kept: `?person=` and the other filters.
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
    setParams({ q: null, department: null });
  }

  const preview = inspector.personId
    ? (people.find((person) => person.id === inspector.personId) ?? null)
    : null;

  return (
    <>
      <PageHeader
        title="Directory"
        description="Everyone at the company: their employee number, position, department, email and who they report to."
      />
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
                placeholder="Name, number or email"
                autoComplete="off"
                spellCheck={false}
                maxLength={100}
                className="pl-10"
              />
            </div>
          </div>
          <div className="flex w-full flex-col gap-1.5 sm:w-64">
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
          {viewer.canSeeSeparatedPeople ? (
            <div className="flex min-h-11 items-center gap-3 sm:ml-auto" aria-busy={filtering}>
              <label
                htmlFor={separatedId}
                className="text-subheadline font-medium text-text-primary"
              >
                Show separated
              </label>
              <Switch
                id={separatedId}
                checked={showSeparated}
                onCheckedChange={(next) => setParams({ separated: next ? '1' : null })}
                disabled={filtering}
              />
            </div>
          ) : null}
        </div>
        <p role="status" className="numeric text-footnote text-text-secondary">
          {plural(people.length, 'person', 'people')}
          {showSeparated ? ', separated included' : null}
        </p>
      </div>

      <InspectorLayout>
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {people.length > 0 ? (
            <DataTable
              caption="Directory"
              captionHidden
              columns={COLUMNS}
              data={people}
              getRowId={(person) => person.id}
              selectedRowId={inspector.open ? inspector.personId : null}
              rowActionLabel={(person) => `Open ${person.name}’s card`}
              onRowSelect={(person, element) => inspector.openPerson(person.id, element)}
              renderPhoneRow={(person) => <PersonPhoneRow person={person} />}
              loading={filtering}
            />
          ) : filtered ? (
            <EmptyState
              icon={<Search strokeWidth={1.75} />}
              title="No one matches"
              description={
                viewer.canSeeSeparatedPeople && !showSeparated
                  ? 'Try another name, number, email or department, or turn on “Show separated”.'
                  : 'Try another name, number, email or department.'
              }
              action={
                <Button variant="tinted" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<Contact strokeWidth={1.75} />}
              title="No one in the directory yet"
              description="People show up here once HR adds them with an active account."
            />
          )}
        </div>

        <PersonInspector
          open={inspector.open}
          onOpenChange={inspector.changeOpen}
          personId={inspector.personId}
          session={inspector.session}
          returnFocus={inspector.returnFocus}
          onOpenPerson={(id) => inspector.openPerson(id)}
          preview={preview}
          boardDepartmentCode={boardDepartmentCode}
          viewer={viewer}
        />
      </InspectorLayout>
    </>
  );
}
