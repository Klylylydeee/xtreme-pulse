'use client';

import { useCallback, type MouseEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell } from 'lucide-react';
import { type AuditModule, formatDateTime, formatRelativeTime, isInternalHref } from '@pulse/core';
import { cn } from '@pulse/ui';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { Skeleton } from '@pulse/ui/components/skeleton';
import { markNotificationsReadAction } from '@/lib/actions/notifications';
import { moduleDisplay } from '@/lib/module-labels';

// Spec: docs/modules/core.md#notifications — the rows of the notification list, shared by the
// toolbar bell's popover and the /notifications page.

/** One notification as the list shows it (the fields of `NotificationView`). */
export interface NotificationItem {
  id: string;
  module: AuditModule;
  title: string;
  body: string | null;
  href: string;
  readAt: Date | null;
  createdAt: Date;
}

/** Fired on `window` when notifications were marked read, so the bell refreshes its badge. */
export const NOTIFICATIONS_CHANGED_EVENT = 'pulse:notifications-changed';

/** Tells the bell that the unread count may have changed. */
export function announceNotificationsChanged(): void {
  window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
}

/**
 * Opens a notification: marks it read, then goes to its link. A link that isn't a path inside the
 * app is never followed. With a modifier key (a new tab or window), the browser opens the link and
 * the notification is still marked read.
 */
export function useOpenNotification({
  onMarked,
  onNavigate,
}: {
  /** After the notification was marked read (or marking failed). */
  onMarked?: (item: NotificationItem) => void;
  /** Just before navigating, e.g. to close the popover. */
  onNavigate?: () => void;
} = {}) {
  const router = useRouter();
  return useCallback(
    async (item: NotificationItem, event: MouseEvent<HTMLElement>) => {
      const newTab =
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
      if (!newTab) event.preventDefault();
      if (!item.readAt) {
        try {
          await markNotificationsReadAction(null, { ids: [item.id] });
        } catch {
          // Marking read is a convenience; the link still opens.
        }
        onMarked?.(item);
        announceNotificationsChanged();
      }
      if (newTab || !isInternalHref(item.href)) return;
      onNavigate?.();
      router.push(item.href);
    },
    [onMarked, onNavigate, router],
  );
}

/**
 * One notification: the module's icon tile, the title, up to two lines of the body, how long ago,
 * and an unread dot (with "Unread" for screen readers). The whole row is the link, at least 44px
 * tall.
 */
export function NotificationRow({
  item,
  reference,
  onOpen,
  className,
}: {
  item: NotificationItem;
  /** "Now", the same for every row of a list. */
  reference: Date;
  onOpen: (item: NotificationItem, event: MouseEvent<HTMLElement>) => void;
  className?: string;
}) {
  const { title: moduleTitle, Icon } = moduleDisplay(item.module);
  const unread = !item.readAt;
  const rowClass = cn(
    'flex min-h-11 w-full items-start gap-3 px-4 py-3 text-left',
    'transition-colors duration-fast hover:bg-accent-subtle/50 focus-visible:-outline-offset-2',
    className,
  );
  const content = (
    <>
      <IconTile className="mt-0.5 size-9 rounded-lg [&_svg]:size-4.5">
        <Icon strokeWidth={1.75} />
      </IconTile>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-start gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 text-subheadline break-words text-text-primary',
              unread ? 'font-semibold' : 'font-medium',
            )}
          >
            {item.title}
          </span>
          {unread ? (
            <span className="mt-1.5 flex shrink-0 items-center">
              <span aria-hidden="true" className="size-2 rounded-full bg-accent" />
              <span className="sr-only">Unread</span>
            </span>
          ) : null}
        </span>
        {item.body ? (
          <span className="line-clamp-2 text-footnote break-words text-text-secondary">
            {item.body}
          </span>
        ) : null}
        <span className="text-caption text-text-secondary">
          <span className="sr-only">{moduleTitle}, </span>
          <time
            dateTime={item.createdAt.toISOString()}
            title={formatDateTime(item.createdAt)}
            className="numeric"
            suppressHydrationWarning
          >
            {formatRelativeTime(item.createdAt, reference)}
          </time>
        </span>
      </span>
    </>
  );

  if (!isInternalHref(item.href)) {
    // Never follow a link that leaves the app; the row still marks the notification read.
    return (
      <button type="button" onClick={(event) => onOpen(item, event)} className={rowClass}>
        {content}
      </button>
    );
  }
  return (
    <Link href={item.href} onClick={(event) => onOpen(item, event)} className={rowClass}>
      {content}
    </Link>
  );
}

/** The designed empty state for notifications (no action: there is nothing to do). */
export function NotificationsEmpty({
  variant = 'card',
  headingLevel = 2,
  unreadOnly = false,
}: {
  variant?: 'card' | 'inline';
  headingLevel?: 2 | 3;
  /** The list is filtered to unread ones. */
  unreadOnly?: boolean;
}) {
  return (
    <EmptyState
      variant={variant}
      headingLevel={headingLevel}
      icon={<Bell strokeWidth={1.75} />}
      title={unreadOnly ? 'No unread notifications' : 'No notifications yet'}
      description={
        unreadOnly ? 'You’re all caught up.' : 'Approvals, reminders and updates will show up here.'
      }
    />
  );
}

/** Skeleton rows in the shape of the list. */
export function NotificationRowsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="flex flex-col">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-start gap-3 px-4 py-3">
          <Skeleton className="size-9 rounded-lg" />
          <div className="flex flex-1 flex-col gap-2 pt-0.5">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
      ))}
    </div>
  );
}
