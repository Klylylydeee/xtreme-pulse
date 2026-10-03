import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionError, now } from '@pulse/core';
import { countUnread, listNotifications, type NotificationPage } from '@pulse/core/server';
import { Button } from '@pulse/ui/components/button';
import { ErrorState } from '@pulse/ui/components/error-state';
import { PageHeader } from '@pulse/ui/components/page-header';
import { KeysetPager } from '@/components/keyset-pager';
import { NotificationsEmpty } from '@/components/notification-list';
import { requireCurrentUser } from '@/lib/auth';
import {
  firstPageHref,
  firstParam,
  pagingLinks,
  readPaging,
  type SearchParams,
} from '@/lib/keyset-paging';
import {
  MarkAllReadButton,
  NotificationsFilter,
  NotificationsPageList,
} from './notifications-client';

export const metadata: Metadata = { title: 'Notifications' };

/** Notifications per page. */
const PAGE_SIZE = 30;

// Spec: docs/modules/core.md#notifications — the signed-in user's own notifications, newest first.
// Pulse Core: every active user, no module access needed. The service filters on the user, so no
// one sees anyone else's. Opening the list is not audit-logged.
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireCurrentUser();
  const params = await searchParams;
  const unreadOnly = firstParam(params, 'show') === 'unread';
  const paging = readPaging(params);

  let page: NotificationPage | null = null;
  if (!paging.invalid) {
    try {
      page = await listNotifications(user.id, {
        cursor: paging.cursor,
        limit: PAGE_SIZE,
        unreadOnly,
      });
    } catch (error) {
      // A cursor this app didn't make (an edited or very old link).
      if (!(error instanceof ActionError)) throw error;
    }
  }
  const unread = await countUnread(user.id);
  const links = page ? pagingLinks('/notifications', params, paging, page.nextCursor) : null;

  return (
    <>
      <PageHeader
        title="Notifications"
        description={
          unread > 0 ? <span className="numeric">{unread} unread</span> : 'You’re all caught up.'
        }
        actions={<MarkAllReadButton disabled={unread === 0} />}
      />
      <NotificationsFilter value={unreadOnly ? 'unread' : 'all'} />
      {!page ? (
        <ErrorState
          title="This page link is out of date"
          description="Go back to the newest notifications."
          action={
            <Button asChild variant="tinted">
              <Link href={firstPageHref('/notifications', params)}>Go to the newest</Link>
            </Button>
          }
        />
      ) : page.notifications.length === 0 ? (
        <NotificationsEmpty unreadOnly={unreadOnly} />
      ) : (
        <>
          <NotificationsPageList items={page.notifications} reference={now()} />
          {links ? (
            <KeysetPager newer={links.newer} older={links.older} label="Notification pages" />
          ) : null}
        </>
      )}
    </>
  );
}
