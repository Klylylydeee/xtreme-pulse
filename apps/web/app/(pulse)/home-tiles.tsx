import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  Bell,
  CalendarDays,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import {
  businessToday,
  type DirectoryPersonLink,
  type OwnTeam,
  directoryPersonHref,
  DISPLAY_LOCALE,
  HOLIDAY_TYPE_LABELS,
  now,
} from '@pulse/core';
import {
  type ConfirmedHoliday,
  countApprovalsWaiting,
  countUnread,
  type CurrentUser,
  getOwnTeam,
  listConfirmedHolidays,
  oldestApprovalWaitingSubmittedAt,
} from '@pulse/core/server';
import { Avatar } from '@pulse/ui/components/avatar';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { Skeleton } from '@pulse/ui/components/skeleton';
import {
  formatHolidayDate,
  oldestSubmittedLabel,
  UPCOMING_HOLIDAY_DAYS,
  UPCOMING_HOLIDAY_LIMIT,
  upcomingHolidayWindow,
} from '@/lib/home';

// Spec: docs/modules/core.md#home and docs/DESIGN_SYSTEM.md (Home tiles), decisions 149 and 150
// in docs/BUILD_PLAN.md — the Home tiles. Each is its own server component in its own Suspense
// (see page.tsx), with its own skeleton, zero state and error state, so one failing tile never
// blanks Home. Each reads only the signed-in user's own data: their waiting approvals, their
// unread notifications, the confirmed holidays (open to everyone) and their own team, with
// directory fields only. Numbers only: no trend charts until Phase 2.

const countFormat = new Intl.NumberFormat(DISPLAY_LOCALE);

/** What each tile shows in its header and links to. */
export interface HomeTileInfo {
  key: string;
  title: string;
  Icon: LucideIcon;
  /** The tile's one link, or none (Your team links each person instead). */
  link: { href: string; label: string } | null;
}

export const APPROVALS_TILE: HomeTileInfo = {
  key: 'approvals',
  title: 'Approvals waiting',
  Icon: ClipboardCheck,
  link: { href: '/approvals', label: 'Open approvals' },
};

export const NOTIFICATIONS_TILE: HomeTileInfo = {
  key: 'notifications',
  title: 'Unread notifications',
  Icon: Bell,
  link: { href: '/notifications', label: 'Open notifications' },
};

export const HOLIDAYS_TILE: HomeTileInfo = {
  key: 'holidays',
  title: 'Upcoming holidays',
  Icon: CalendarDays,
  link: { href: '/holidays', label: 'Open holidays' },
};

export const TEAM_TILE: HomeTileInfo = {
  key: 'team',
  title: 'Your team',
  Icon: UsersRound,
  link: null,
};

/** The tile card: a `surface` card with a tinted icon tile, a Headline title and one link. */
function HomeTile({
  info,
  busy = false,
  children,
}: {
  info: HomeTileInfo;
  busy?: boolean;
  children: ReactNode;
}) {
  const titleId = `home-tile-${info.key}`;
  return (
    <section
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
      className="flex min-w-0 flex-col gap-4 rounded-card bg-surface p-4 shadow-card md:p-5"
    >
      <div className="flex items-center gap-3">
        <IconTile className="size-9 rounded-lg [&_svg]:size-4.5">
          <info.Icon strokeWidth={1.75} />
        </IconTile>
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-headline">
          {info.title}
        </h2>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">{children}</div>
      {info.link ? (
        <Link
          href={info.link.href}
          className="-mx-2 -mb-1 flex min-h-11 items-center justify-between gap-2 rounded-control px-2 text-subheadline font-semibold text-accent transition-colors duration-fast hover:bg-accent-subtle/50"
        >
          {info.link.label}
          <ChevronRight aria-hidden="true" strokeWidth={1.75} className="size-4.5 shrink-0" />
        </Link>
      ) : null}
    </section>
  );
}

/** The tile's zero state: one line in `text-secondary`. */
function TileMessage({ children }: { children: ReactNode }) {
  return <p className="text-subheadline text-text-secondary">{children}</p>;
}

/** The tile's own error state; the rest of Home still shows. */
function TileError() {
  return (
    <p role="alert" className="flex items-start gap-2 text-subheadline text-text-secondary">
      <CircleAlert
        aria-hidden="true"
        strokeWidth={1.75}
        className="mt-0.5 size-4.5 shrink-0 text-destructive-text"
      />
      <span>This couldn’t be loaded. Reload the page to try again.</span>
    </p>
  );
}

/** A Display-size count in tabular numerals. */
function TileCount({ value, label }: { value: number; label: string }) {
  return (
    <p className="flex items-baseline gap-2">
      <span className="numeric text-display">{countFormat.format(value)}</span>
      <span className="sr-only">{label}</span>
    </p>
  );
}

/** A tile's skeleton, shown while its data loads. */
export function HomeTileSkeleton({ info }: { info: HomeTileInfo }) {
  return (
    <HomeTile info={info} busy>
      <Skeleton className="h-12 w-20" />
      <Skeleton className="h-4 w-40 max-w-full" />
    </HomeTile>
  );
}

/** Reads the tile's data, or null when it fails (the tile shows its error state). */
async function load<T>(read: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false }> {
  try {
    return { ok: true, data: await read() };
  } catch {
    // The tile's own error state, without the error: it never reaches the page or the logs here.
    return { ok: false };
  }
}

// --- Approvals waiting ---------------------------------------------------------------------------

export async function ApprovalsWaitingTile({ user }: { user: CurrentUser }) {
  const result = await load(async () => {
    const [count, oldest] = await Promise.all([
      countApprovalsWaiting(user.id),
      oldestApprovalWaitingSubmittedAt(user.id),
    ]);
    return { count, oldest };
  });
  return (
    <HomeTile info={APPROVALS_TILE}>
      {!result.ok ? (
        <TileError />
      ) : result.data.count === 0 ? (
        <TileMessage>Nothing is waiting for you.</TileMessage>
      ) : (
        <>
          <TileCount
            value={result.data.count}
            label={result.data.count === 1 ? 'request waiting' : 'requests waiting'}
          />
          {result.data.oldest ? (
            <TileMessage>{oldestSubmittedLabel(result.data.oldest, now())}</TileMessage>
          ) : null}
        </>
      )}
    </HomeTile>
  );
}

// --- Unread notifications ------------------------------------------------------------------------

export async function UnreadNotificationsTile({ user }: { user: CurrentUser }) {
  const result = await load(() => countUnread(user.id));
  return (
    <HomeTile info={NOTIFICATIONS_TILE}>
      {!result.ok ? (
        <TileError />
      ) : result.data === 0 ? (
        <TileMessage>You’re all caught up.</TileMessage>
      ) : (
        <TileCount value={result.data} label="unread" />
      )}
    </HomeTile>
  );
}

// --- Upcoming holidays ---------------------------------------------------------------------------

function holidayDetail(holiday: ConfirmedHoliday): string {
  const parts = [formatHolidayDate(holiday.date), HOLIDAY_TYPE_LABELS[holiday.type]];
  if (holiday.scope === 'local' && holiday.location) parts.push(holiday.location);
  return parts.join(' · ');
}

export async function UpcomingHolidaysTile() {
  const result = await load(async () =>
    (await listConfirmedHolidays(upcomingHolidayWindow(businessToday()))).slice(
      0,
      UPCOMING_HOLIDAY_LIMIT,
    ),
  );
  return (
    <HomeTile info={HOLIDAYS_TILE}>
      {!result.ok ? (
        <TileError />
      ) : result.data.length === 0 ? (
        <TileMessage>No holidays in the next {UPCOMING_HOLIDAY_DAYS} days.</TileMessage>
      ) : (
        <ul className="flex flex-col divide-y divide-separator">
          {result.data.map((holiday) => (
            <li
              key={holiday.id}
              className="flex min-w-0 flex-col gap-0.5 py-2 first:pt-0 last:pb-0"
            >
              <span className="truncate text-callout font-semibold">{holiday.name}</span>
              <span className="text-footnote text-text-secondary">{holidayDetail(holiday)}</span>
            </li>
          ))}
        </ul>
      )}
    </HomeTile>
  );
}

// --- Your team -----------------------------------------------------------------------------------

function TeamList({ label, people }: { label: string; people: readonly DirectoryPersonLink[] }) {
  const headingId = `home-team-${label.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h3 id={headingId} className="text-footnote font-semibold text-text-secondary">
        {label}
      </h3>
      <ul aria-labelledby={headingId} className="-mx-2 flex flex-col">
        {people.map((person) => (
          <li key={person.id}>
            <Link
              href={directoryPersonHref(person.id)}
              className="flex min-h-11 items-center gap-3 rounded-control px-2 py-1.5 transition-colors duration-fast hover:bg-accent-subtle/50"
            >
              <Avatar size="sm" fallback={person.initials} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-subheadline font-semibold">{person.name}</span>
                {person.positionName ? (
                  <span className="truncate text-footnote text-text-secondary">
                    {person.positionName}
                  </span>
                ) : null}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Hidden for the bootstrap system account, which has no employee record (page.tsx checks too). */
export async function YourTeamTile({ user }: { user: CurrentUser }) {
  if (user.isSystemAccount || !user.employee) return null;
  const result = await load<OwnTeam>(() => getOwnTeam(user));
  return (
    <HomeTile info={TEAM_TILE}>
      {!result.ok ? (
        <TileError />
      ) : (
        <>
          {result.data.supervisors.length > 0 ? (
            <TeamList label="Reports to" people={result.data.supervisors} />
          ) : null}
          {result.data.directReports.length > 0 ? (
            <TeamList label="Direct reports" people={result.data.directReports} />
          ) : (
            <TileMessage>No one reports to you yet.</TileMessage>
          )}
        </>
      )}
    </HomeTile>
  );
}
