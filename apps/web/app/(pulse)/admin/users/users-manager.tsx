'use client';

import { useEffect, useId, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CircleCheck, Plus, Search, ShieldCheck, UserRound, Users } from 'lucide-react';
import type { BusinessDate } from '@pulse/core';
import type { UserListRow } from '@pulse/core/server';
import { Button } from '@pulse/ui/components/button';
import {
  createDataTableColumns,
  DataTable,
  type DataTableColumn,
  type DataTableRow,
} from '@pulse/ui/components/data-table';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { Input, Select, Switch } from '@pulse/ui/components/form';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { PageHeader } from '@pulse/ui/components/page-header';
import { Sheet, SheetContent } from '@pulse/ui/components/sheet';
import { useReturnFocus } from '@pulse/ui/hooks/use-return-focus';
import { Badge, plural } from '@/components/org-structure';
import { TemporaryPasswordDialog, type TemporaryPasswordNotice } from './temporary-password-dialog';
import {
  displayName,
  type UserDepartmentOption,
  type UserPositionOption,
  UserSheetContent,
} from './user-sheet';

// Spec: docs/modules/core.md#managing-user-accounts — the users list for HR and the System
// Administrator: employee number, name, email, department, position and employment status, with
// a "Temporary password" badge until the user changes it. Search by name, number or email, filter
// by department, and "Show separated" (`?separated=1`); sorted by last name (the Name column's
// first sort, so the phone control reads "Sort by Name"), with no paging. The system account
// shows (first) only to a System Administrator. A row opens its sheet; "Add user" opens a blank
// one. After a create or reset, the temporary password is shown once. From build step 1.7: once the
// password dialog after a create closes, the screen goes to the new user's access sheet
// (`/admin/access?user=<id>`); a saved position change offers "Review access"; and a System
// Administrator can Disable or Enable the system account from its sheet.

const SEARCH_DELAY_MS = 300;

/** The name in the list: the system account is named as such (its email has its own column). */
function listName(user: UserListRow): string {
  return user.isSystemAccount ? 'System account' : displayName(user);
}

/** Badges after a name: a System Administrator, one's own row. */
function NameBadges({ user }: { user: UserListRow }) {
  return (
    <>
      {user.isSystemAdministrator ? <Badge tone="accent">System Administrator</Badge> : null}
      {user.isSelf ? <Badge>You</Badge> : null}
    </>
  );
}

/** The access sheet for a user on `/admin/access` (docs/modules/core.md#user-access-page). */
function accessSheetHref(userId: string): string {
  return `/admin/access?user=${encodeURIComponent(userId)}`;
}

/** The line under the filters after a change, with "Review access" after a position change. */
interface Notice {
  message: string;
  reviewAccessUserId: string | null;
}

/** The employment status (the system account's own status when it has none). */
function statusLabel(user: UserListRow): string {
  return user.employmentStatus ?? (user.accountStatus === 'active' ? 'Active' : 'Disabled');
}

/** The status with the "Temporary password" badge, on phones. */
function StatusCell({ user }: { user: UserListRow }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="whitespace-nowrap">{statusLabel(user)}</span>
      {user.mustChangePassword ? <Badge tone="accent">Temporary password</Badge> : null}
    </span>
  );
}

/**
 * The service's order: the system account first, then last name, first name and email. Reversed
 * (a descending sort), the system account comes last.
 */
function byLastName(a: DataTableRow<UserListRow>, b: DataTableRow<UserListRow>): number {
  const [x, y] = [a.original, b.original];
  return (
    Number(y.isSystemAccount) - Number(x.isSystemAccount) ||
    (x.lastName ?? '').localeCompare(y.lastName ?? '') ||
    (x.firstName ?? '').localeCompare(y.firstName ?? '') ||
    x.email.localeCompare(y.email)
  );
}

const column = createDataTableColumns<UserListRow>();

// Sized to fit 1280px with the sidebar open without scrolling sideways: the badges sit under the
// name (the "Temporary password" one too, which keeps the status column narrow), the email is
// cut short (in full on hover and in the sheet), and department and position wrap.
const COLUMNS: DataTableColumn<UserListRow>[] = column.columns([
  column.accessor((user) => user.employeeNumber ?? '', {
    id: 'employeeNumber',
    header: 'Number',
    sortFn: 'text',
    cell: (info) => <span className="numeric whitespace-nowrap">{info.getValue() || '—'}</span>,
    meta: { width: '6.5rem' },
  }),
  column.accessor((user) => listName(user), {
    id: 'name',
    header: 'Name',
    // By last name, like the service, so the first sort is the order the list came in.
    sortFn: byLastName,
    cell: (info) => {
      const user = info.row.original;
      const badges = user.isSystemAdministrator || user.isSelf || user.mustChangePassword;
      return (
        <span className="flex min-w-36 flex-col items-start gap-1 py-1">
          <span className="font-medium">{info.getValue()}</span>
          {badges ? (
            <span className="flex flex-wrap gap-1.5">
              <NameBadges user={user} />
              {user.mustChangePassword ? <Badge tone="accent">Temporary password</Badge> : null}
            </span>
          ) : null}
        </span>
      );
    },
  }),
  column.accessor('email', {
    header: 'Email',
    sortFn: 'text',
    cell: (info) => (
      <span title={info.getValue()} className="block max-w-52 truncate">
        {info.getValue()}
      </span>
    ),
  }),
  column.accessor((user) => user.departmentName ?? '', {
    id: 'department',
    header: 'Department',
    sortFn: 'text',
    cell: (info) => info.getValue() || '—',
  }),
  column.accessor((user) => user.positionName ?? '', {
    id: 'position',
    header: 'Position',
    sortFn: 'text',
    cell: (info) => info.getValue() || '—',
  }),
  column.accessor((user) => user.employmentStatus ?? '', {
    id: 'status',
    header: 'Status',
    sortFn: 'text',
    cell: (info) => <span className="whitespace-nowrap">{statusLabel(info.row.original)}</span>,
  }),
]);

function UserPhoneRow({ user }: { user: UserListRow }) {
  return (
    <>
      <IconTile className="size-11 rounded-xl [&_svg]:size-5">
        {user.isSystemAccount ? (
          <ShieldCheck strokeWidth={1.75} />
        ) : (
          <UserRound strokeWidth={1.75} />
        )}
      </IconTile>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-subheadline font-semibold">{listName(user)}</span>
          <NameBadges user={user} />
        </span>
        <span className="truncate text-footnote text-text-secondary">
          {user.employeeNumber ? <span className="numeric">{user.employeeNumber} · </span> : null}
          {user.email}
        </span>
        {user.departmentName || user.positionName ? (
          <span className="truncate text-footnote text-text-secondary">
            {[user.positionName, user.departmentName].filter(Boolean).join(' · ')}
          </span>
        ) : null}
        <span className="text-footnote text-text-secondary">
          <StatusCell user={user} />
        </span>
      </span>
    </>
  );
}

export function UsersManager({
  users,
  departments,
  positions,
  search,
  departmentId,
  showSeparated,
  today,
  dateHiredRange,
  canManageSystemAccount,
}: {
  users: UserListRow[];
  /** Every department, retired ones included (the pickers offer live ones). */
  departments: UserDepartmentOption[];
  positions: UserPositionOption[];
  /** The filters, from the URL. */
  search: string;
  departmentId: string | null;
  showSeparated: boolean;
  today: BusinessDate;
  dateHiredRange: { earliest: BusinessDate; latest: BusinessDate };
  /** The viewer is a System Administrator: Disable or Enable on the system account's sheet. */
  canManageSystemAccount: boolean;
}) {
  const router = useRouter();
  const returnFocus = useReturnFocus();
  const [open, setOpen] = useState(false);
  // Kept while the sheet closes, so its content doesn't change during the animation.
  const [target, setTarget] = useState<UserListRow | null>(null);
  // A new form (fresh fields and errors) every time the sheet opens.
  const [session, setSession] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [password, setPassword] = useState<TemporaryPasswordNotice | null>(null);
  // After a create, where to go once the password dialog has closed: the new user's access sheet.
  const afterPassword = useRef<string | null>(null);
  const [filtering, startFiltering] = useTransition();
  const [query, setQuery] = useState(search);
  const searchTimer = useRef<number | undefined>(undefined);
  const searchId = useId();
  const departmentFilterId = useId();
  const separatedId = useId();

  useEffect(() => () => window.clearTimeout(searchTimer.current), []);

  const canAdd = positions.some(
    (position) =>
      !position.retired &&
      departments.some(
        (department) => department.id === position.departmentId && !department.retired,
      ),
  );
  const filterDepartment = departmentId
    ? (departments.find((department) => department.id === departmentId) ?? null)
    : null;
  const filtered = search !== '' || departmentId !== null;

  function setParams(changes: Record<string, string | null>) {
    const params = new URLSearchParams(window.location.search);
    for (const [name, value] of Object.entries(changes)) {
      if (value) params.set(name, value);
      else params.delete(name);
    }
    const next = params.toString();
    startFiltering(() => {
      router.replace(`/admin/users${next ? `?${next}` : ''}`, { scroll: false });
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

  function openSheet(user: UserListRow | null, trigger?: HTMLElement | null) {
    returnFocus.remember(trigger);
    setTarget(user);
    setSession((count) => count + 1);
    setNotice(null);
    setOpen(true);
  }

  function say(message: string, reviewAccessUserId: string | null = null) {
    setNotice({ message, reviewAccessUserId });
  }

  /**
   * Closes the sheet and shows the temporary password; focus returns to the row afterwards, or,
   * after a create, the screen goes on to the new user's access sheet.
   */
  function showPassword(next: TemporaryPasswordNotice) {
    setOpen(false);
    say(next.kind === 'created' ? `${next.name} added.` : `Password reset for ${next.name}.`);
    afterPassword.current =
      next.kind === 'created' && next.userId ? accessSheetHref(next.userId) : null;
    setPassword(next);
  }

  const sheetProps = {
    departments,
    positions,
    today,
    dateHiredRange,
    onCreated: showPassword,
    onReset: showPassword,
    onSaved: (message: string, reviewAccessUserId: string | null) => {
      setOpen(false);
      say(message, reviewAccessUserId);
    },
    onStatusChanged: (message: string) => say(message),
    canManageSystemAccount,
    onSystemAccountChanged: (disabled: boolean) => {
      setOpen(false);
      // A disabled system account is listed only with "Show separated", like a deactivated user.
      say(
        disabled
          ? `System account disabled.${showSeparated ? '' : ' It’s listed under Show separated.'}`
          : 'System account enabled.',
      );
    },
  };

  const addButton = (variant: 'primary' | 'tinted') => (
    <Button
      variant={variant}
      disabled={!canAdd}
      onClick={(event) => openSheet(null, event.currentTarget)}
    >
      <Plus aria-hidden="true" className="size-5" />
      Add user
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Users"
        description="Everyone who can sign in: their login, employee number, department, position and employment status."
        actions={canAdd ? addButton('primary') : undefined}
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
              {filterDepartment === null && departmentId ? (
                <option value={departmentId}>Unknown department</option>
              ) : null}
              {departments
                .filter((department) => !department.retired || department.id === departmentId)
                .map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name} ({department.code}){department.retired ? ', retired' : ''}
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
        <p role="status" className="text-footnote text-text-secondary">
          {notice ? (
            <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-1.5 font-medium text-success-text">
                <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
                {notice.message}
              </span>
              {notice.reviewAccessUserId ? (
                <Link
                  href={accessSheetHref(notice.reviewAccessUserId)}
                  className="inline-flex min-h-11 items-center font-medium text-accent underline"
                >
                  Review access
                </Link>
              ) : null}
            </span>
          ) : (
            <span className="numeric">
              {plural(users.length, 'user', 'users')}
              {showSeparated ? ', separated included' : null}
            </span>
          )}
        </p>
      </div>
      {users.length > 0 ? (
        <DataTable
          caption="Users"
          captionHidden
          columns={COLUMNS}
          data={users}
          getRowId={(user) => user.id}
          initialSorting={[{ id: 'name', desc: false }]}
          selectedRowId={open ? target?.id : null}
          rowActionLabel={(user) =>
            user.actions.edit ? `Edit ${displayName(user)}` : `Details for ${displayName(user)}`
          }
          onRowSelect={(user, element) => openSheet(user, element)}
          renderPhoneRow={(user) => <UserPhoneRow user={user} />}
          loading={filtering}
        />
      ) : filtered ? (
        <EmptyState
          icon={<Search strokeWidth={1.75} />}
          title="No users match"
          description={
            showSeparated
              ? 'Try another search or department.'
              : 'Try another search or department, or turn on “Show separated”.'
          }
          action={
            <Button variant="tinted" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      ) : !canAdd ? (
        <EmptyState
          icon={<Users strokeWidth={1.75} />}
          title="Add departments and positions first"
          description="Every user is an employee with a department and a position. Add those, then come back to add users."
          action={
            <Button asChild variant="tinted">
              <Link href="/admin/positions">Go to positions</Link>
            </Button>
          }
        />
      ) : (
        <EmptyState
          icon={<Users strokeWidth={1.75} />}
          title={showSeparated ? 'No users yet' : 'No active users yet'}
          description="Add each employee with their login email. They get a temporary password to change when they first sign in."
          action={addButton('tinted')}
        />
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            // With the password dialog opening, focus goes there; it returns to the row after.
            if (password) {
              event.preventDefault();
              return;
            }
            returnFocus.onCloseAutoFocus(event);
          }}
        >
          <UserSheetContent key={session} target={target} {...sheetProps} />
        </SheetContent>
      </Sheet>
      <TemporaryPasswordDialog
        notice={password}
        onClose={() => setPassword(null)}
        onCloseAutoFocus={(event) => {
          const next = afterPassword.current;
          afterPassword.current = null;
          if (next) {
            // After a create: on to the new user's access sheet, where Cancel is "Set access later".
            event.preventDefault();
            router.push(next);
            return;
          }
          returnFocus.onCloseAutoFocus(event);
        }}
      />
    </>
  );
}
