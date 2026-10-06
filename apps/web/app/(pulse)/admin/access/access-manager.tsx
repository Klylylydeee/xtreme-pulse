'use client';

import { type ReactNode, useEffect, useId, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CircleCheck, Search, UserRoundCheck } from 'lucide-react';
import { formatDate, MODULE_LABELS, MODULES } from '@pulse/core';
import type { UserAccessList, UserAccessRow } from '@pulse/core/server';
import { cn } from '@pulse/ui';
import { Button } from '@pulse/ui/components/button';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { Input, Select } from '@pulse/ui/components/form';
import { PageHeader } from '@pulse/ui/components/page-header';
import { Sheet, SheetContent } from '@pulse/ui/components/sheet';
import { useReturnFocus } from '@pulse/ui/hooks/use-return-focus';
import { Badge, plural } from '@/components/org-structure';
import { AccessSheetContent, UserAvatar } from './access-sheet';

// Spec: docs/modules/core.md#user-access-page — the User access list for HR and the System
// Administrator (decisions 65–80 in docs/BUILD_PLAN.md). Stat tiles over every active user, then
// search (name and employee number) and the department and position filters, all in the URL. The
// "Needs access" group is pinned first, newest first; everyone else follows by last name, the
// system account first (System Administrators only). Each row shows the access summary chips and
// "Added <date>"; on a phone the rows become cards. A row opens the access sheet, and so does
// `?user=<id>` (after creating a user, or from a notification).

const SEARCH_DELAY_MS = 300;

/** A department or position in the filters. */
export interface AccessFilterOption {
  id: string;
  name: string;
  retired: boolean;
  /** A position's department; null for a department. */
  departmentId: string | null;
}

/** The name in the list: the system account is named as such. */
function listName(row: Pick<UserAccessRow, 'name' | 'email' | 'isSystemAccount'>): string {
  return row.isSystemAccount ? 'System account' : (row.name ?? row.email);
}

// --- Stat tiles --------------------------------------------------------------------------------

function Tile({
  id,
  title,
  children,
  className,
}: {
  id: string;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={id}
      className={cn(
        'flex flex-col gap-3 rounded-card bg-surface p-4 shadow-card md:p-5',
        className,
      )}
    >
      <h2 id={id} className="text-footnote font-semibold text-text-secondary">
        {title}
      </h2>
      {children}
    </section>
  );
}

const RING_RADIUS = 22;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** "With access 18 of 21", with a ring of the share. */
function WithAccessTile({ withAccess, activeUsers }: { withAccess: number; activeUsers: number }) {
  const id = useId();
  const share = activeUsers === 0 ? 0 : withAccess / activeUsers;
  const percent = Math.round(share * 100);
  return (
    <Tile id={id} title="With access">
      <div className="flex items-center justify-between gap-4">
        <p className="flex flex-col">
          <span className="numeric text-large-title font-bold">{withAccess}</span>
          <span className="text-footnote text-text-secondary">
            of <span className="numeric">{activeUsers}</span> active{' '}
            {activeUsers === 1 ? 'user' : 'users'}
          </span>
        </p>
        <svg
          role="img"
          aria-label={`${percent} percent of active users have access to at least one module`}
          width="56"
          height="56"
          viewBox="0 0 56 56"
          className="shrink-0"
        >
          <circle
            cx="28"
            cy="28"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="7"
            className="stroke-bg-grouped"
          />
          {share > 0 ? (
            <circle
              cx="28"
              cy="28"
              r={RING_RADIUS}
              fill="none"
              strokeWidth="7"
              strokeLinecap="round"
              strokeDasharray={`${share * RING_LENGTH} ${RING_LENGTH}`}
              transform="rotate(-90 28 28)"
              className="stroke-accent"
            />
          ) : null}
          <text
            x="28"
            y="32"
            textAnchor="middle"
            className="numeric fill-text-primary text-caption font-bold"
          >
            {percent}%
          </text>
        </svg>
      </div>
    </Tile>
  );
}

/** How many users still have no access: the same count as the sidebar badge. */
function NeedsAccessTile({ count }: { count: number }) {
  const id = useId();
  return (
    <Tile id={id} title="Needs access">
      <p className="flex flex-col">
        <span className="numeric text-large-title font-bold">{count}</span>
        <span className="text-footnote text-text-secondary">
          {count === 0
            ? 'Everyone active has access set.'
            : `${count === 1 ? 'user has' : 'users have'} no module access yet.`}
        </span>
      </p>
      {count === 0 ? (
        <span className="inline-flex items-center gap-1.5 text-footnote font-medium text-success-text">
          <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
          Nobody is waiting
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-footnote text-text-secondary">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-warning" />
          Listed first below
        </span>
      )}
    </Tile>
  );
}

/** How many active users can at least read each module, as labelled bars. */
function PerModuleTile({ perModule, total }: { perModule: Record<string, number>; total: number }) {
  const id = useId();
  return (
    <Tile id={id} title="Users per module" className="sm:col-span-2 lg:col-span-1">
      <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1">
        {MODULES.map((module) => {
          const count = perModule[module] ?? 0;
          const width = total === 0 ? 0 : (count / total) * 100;
          return (
            <div key={module} className="contents">
              <dt className="text-caption text-text-secondary">{MODULE_LABELS[module]}</dt>
              <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-bg-grouped">
                {count > 0 ? (
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${Math.max(width, 4)}%` }}
                  />
                ) : null}
              </div>
              <dd className="numeric text-right text-caption font-semibold">{count}</dd>
            </div>
          );
        })}
      </dl>
    </Tile>
  );
}

// --- Rows --------------------------------------------------------------------------------------

function RowBadges({ row }: { row: UserAccessRow }) {
  return (
    <>
      {row.isSystemAdministrator ? <Badge tone="accent">System Administrator</Badge> : null}
      {row.isSelf ? <Badge>You</Badge> : null}
    </>
  );
}

/** The access summary chips, "No access" for the Needs access group, nothing for the system account. */
function RowSummary({ row }: { row: UserAccessRow }) {
  if (row.isSystemAccount) return null;
  if (row.summary.length === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-bg-grouped px-2 py-0.5 text-footnote font-medium whitespace-nowrap text-text-secondary">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-warning" />
        No access
      </span>
    );
  }
  return (
    <>
      {row.summary.map((chip) => (
        <Badge key={chip} tone="accent" className="numeric">
          {chip}
        </Badge>
      ))}
    </>
  );
}

function AccessRow({
  row,
  selected,
  onOpen,
}: {
  row: UserAccessRow;
  selected: boolean;
  onOpen: (row: UserAccessRow, trigger: HTMLElement) => void;
}) {
  const meta = [row.positionName, row.departmentName].filter(Boolean).join(' · ');
  const summary = row.isSystemAccount
    ? ''
    : row.summary.length === 0
      ? 'no access'
      : row.summary.join(', ');
  return (
    <li className="rounded-card bg-surface shadow-card md:rounded-none md:bg-transparent md:shadow-none">
      <button
        type="button"
        aria-current={selected || undefined}
        aria-label={`${listName(row)}${row.employeeNumber ? `, ${row.employeeNumber}` : ''}${summary ? `, ${summary}` : ''}. ${row.readOnlyReason ? 'View access' : 'Edit access'}`}
        onClick={(event) => onOpen(row, event.currentTarget)}
        className={cn(
          'flex min-h-18 w-full cursor-pointer flex-col gap-3 rounded-card px-4 py-3 text-left transition-colors duration-fast',
          'hover:bg-bg-grouped/60 aria-[current=true]:bg-accent-subtle/60',
          'focus-visible:outline-offset-[-2px] md:flex-row md:items-center md:gap-4 md:rounded-none md:px-5',
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-3">
          <UserAvatar row={row} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate text-subheadline font-semibold">{listName(row)}</span>
              <RowBadges row={row} />
            </span>
            <span className="truncate text-footnote text-text-secondary">
              {row.isSystemAccount ? row.email : meta || '—'}
              {row.employeeNumber ? <span className="numeric"> · {row.employeeNumber}</span> : null}
            </span>
            <span className="text-footnote text-text-secondary">
              Added {formatDate(new Date(row.createdAt))}
            </span>
          </span>
        </span>
        {row.isSystemAccount ? null : (
          <span className="flex flex-wrap gap-1.5 pl-14 md:max-w-[45%] md:justify-end md:pl-0">
            <RowSummary row={row} />
          </span>
        )}
      </button>
    </li>
  );
}

function RowGroup({
  title,
  rows,
  selectedId,
  onOpen,
}: {
  title: string;
  rows: UserAccessRow[];
  selectedId: string | null;
  onOpen: (row: UserAccessRow, trigger: HTMLElement) => void;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="px-1 text-footnote font-semibold text-text-secondary md:px-4">
        {title} · <span className="numeric">{rows.length}</span>
      </h2>
      <ul className="flex flex-col gap-2 md:gap-0 md:divide-y md:divide-separator md:overflow-hidden md:rounded-card md:bg-surface md:shadow-card">
        {rows.map((row) => (
          <AccessRow key={row.id} row={row} selected={row.id === selectedId} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}

// --- The page ----------------------------------------------------------------------------------

export function AccessManager({
  list,
  departments,
  positions,
  search,
  departmentId,
  positionId,
  actorIsSystemAdministrator,
}: {
  list: UserAccessList;
  /** Every department and position, retired ones included (the filters offer live ones). */
  departments: AccessFilterOption[];
  positions: AccessFilterOption[];
  /** The filters, from the URL. */
  search: string;
  departmentId: string | null;
  positionId: string | null;
  /** The switch shows to System Administrators only. */
  actorIsSystemAdministrator: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const returnFocus = useReturnFocus();
  const [open, setOpen] = useState(false);
  // Kept while the sheet closes, so its content doesn't change during the animation.
  const [targetId, setTargetId] = useState<string | null>(null);
  const [session, setSession] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [filtering, startFiltering] = useTransition();
  const [query, setQuery] = useState(search);
  const searchTimer = useRef<number | undefined>(undefined);
  const searchId = useId();
  const departmentFilterId = useId();
  const positionFilterId = useId();

  // `?user=<id>` opens that user's sheet: on first load, and whenever a link sets it again.
  const userParam = searchParams.get('user');
  const [seenUserParam, setSeenUserParam] = useState<string | null>(null);
  if (userParam !== seenUserParam) {
    setSeenUserParam(userParam);
    if (userParam) {
      setTargetId(userParam);
      setSession((count) => count + 1);
      setNotice(null);
      setOpen(true);
    }
  }

  useEffect(() => () => window.clearTimeout(searchTimer.current), []);

  const rows = [...list.needsAccess, ...list.others];
  const target = targetId ? (rows.find((row) => row.id === targetId) ?? null) : null;
  const filtered = search !== '' || departmentId !== null || positionId !== null;
  const total = rows.length;

  const departmentChoices = departments.filter(
    (option) => !option.retired || option.id === departmentId,
  );
  const positionChoices = positions.filter(
    (option) =>
      (!option.retired || option.id === positionId) &&
      (!departmentId || option.departmentId === departmentId || option.id === positionId),
  );

  function setParams(changes: Record<string, string | null>) {
    const params = new URLSearchParams(window.location.search);
    params.delete('user');
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

  function changeDepartment(next: string) {
    // A position from another department no longer fits; clear it.
    const position = positions.find((option) => option.id === positionId);
    const keepPosition = !next || !position || position.departmentId === next;
    setParams({ department: next || null, ...(keepPosition ? {} : { position: null }) });
  }

  function clearFilters() {
    window.clearTimeout(searchTimer.current);
    setQuery('');
    setParams({ q: null, department: null, position: null });
  }

  function openSheet(row: UserAccessRow, trigger: HTMLElement) {
    returnFocus.remember(trigger);
    setTargetId(row.id);
    setSession((count) => count + 1);
    setNotice(null);
    setOpen(true);
  }

  /** Closing drops `?user=` from the address without reloading, so a reload doesn't reopen it. */
  function changeOpen(next: boolean) {
    setOpen(next);
    if (!next && new URLSearchParams(window.location.search).has('user')) {
      const params = new URLSearchParams(window.location.search);
      params.delete('user');
      const query = params.toString();
      window.history.replaceState(null, '', `${pathname}${query ? `?${query}` : ''}`);
    }
  }

  return (
    <>
      <PageHeader
        title="User access"
        description="Set which modules each person can use. New users start with no access."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <WithAccessTile withAccess={list.stats.withAccess} activeUsers={list.stats.activeUsers} />
        <NeedsAccessTile count={list.needsAccessCount} />
        <PerModuleTile perModule={list.stats.perModule} total={list.stats.activeUsers} />
      </div>

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
          <div className="flex w-full flex-col gap-1.5 sm:w-60">
            <label
              htmlFor={departmentFilterId}
              className="text-footnote font-semibold text-text-secondary"
            >
              Department
            </label>
            <Select
              id={departmentFilterId}
              value={departmentId ?? ''}
              onChange={(event) => changeDepartment(event.target.value)}
              disabled={filtering}
              aria-busy={filtering || undefined}
            >
              <option value="">All departments</option>
              {departmentId && !departments.some((option) => option.id === departmentId) ? (
                <option value={departmentId}>Unknown department</option>
              ) : null}
              {departmentChoices.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                  {option.retired ? ', retired' : ''}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex w-full flex-col gap-1.5 sm:w-60">
            <label
              htmlFor={positionFilterId}
              className="text-footnote font-semibold text-text-secondary"
            >
              Position
            </label>
            <Select
              id={positionFilterId}
              value={positionId ?? ''}
              onChange={(event) => setParams({ position: event.target.value || null })}
              disabled={filtering}
              aria-busy={filtering || undefined}
            >
              <option value="">All positions</option>
              {positionId && !positions.some((option) => option.id === positionId) ? (
                <option value={positionId}>Unknown position</option>
              ) : null}
              {positionChoices.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                  {option.retired ? ' (retired)' : ''}
                </option>
              ))}
            </Select>
          </div>
          {filtered ? (
            <Button variant="plain" onClick={clearFilters} className="sm:ml-auto">
              Clear filters
            </Button>
          ) : null}
        </div>
        <p role="status" className="text-footnote text-text-secondary">
          {notice ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-success-text">
              <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
              {notice}
            </span>
          ) : (
            <span className="numeric">
              {plural(total, 'active user', 'active users')}
              {filtered ? ' match' : null}
            </span>
          )}
        </p>
      </div>

      <div className={cn('flex flex-col gap-6', filtering && 'opacity-60')} aria-busy={filtering}>
        {list.needsAccess.length > 0 ? (
          <RowGroup
            title="Needs access"
            rows={list.needsAccess}
            selectedId={open ? targetId : null}
            onOpen={openSheet}
          />
        ) : null}
        {list.others.length > 0 ? (
          <RowGroup
            title={list.needsAccess.length > 0 ? 'Everyone else' : 'All users'}
            rows={list.others}
            selectedId={open ? targetId : null}
            onOpen={openSheet}
          />
        ) : null}
        {total === 0 ? (
          filtered ? (
            <EmptyState
              icon={<Search strokeWidth={1.75} />}
              title="No users match"
              description="Try another name, number, department or position."
              action={
                <Button variant="tinted" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<UserRoundCheck strokeWidth={1.75} />}
              title="No active users yet"
              description="Add people on Users. They show here with no access, ready for you to set it."
            />
          )
        ) : null}
      </div>

      <Sheet open={open} onOpenChange={changeOpen}>
        <SheetContent aria-describedby={undefined} onCloseAutoFocus={returnFocus.onCloseAutoFocus}>
          {targetId ? (
            <AccessSheetContent
              key={session}
              userId={targetId}
              row={target}
              actorIsSystemAdministrator={actorIsSystemAdministrator}
              onSaved={(message) => {
                changeOpen(false);
                setNotice(message);
              }}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
