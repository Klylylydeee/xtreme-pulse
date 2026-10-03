'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { now } from '@pulse/core';
import { Button, buttonVariants } from '@pulse/ui/components/button';
import { ErrorState } from '@pulse/ui/components/error-state';
import {
  countUnreadNotificationsAction,
  listNotificationsAction,
  markAllNotificationsReadAction,
} from '@/lib/actions/notifications';
import {
  NOTIFICATIONS_CHANGED_EVENT,
  type NotificationItem,
  NotificationRow,
  NotificationRowsSkeleton,
  NotificationsEmpty,
  useOpenNotification,
} from './notification-list';

// Spec: docs/modules/core.md#notifications — the toolbar bell. The first unread count comes from
// the (pulse) layout; the badge refreshes on navigation, when the window regains focus and when the
// list opens. There is no polling.

/** How many notifications the popover shows; the /notifications page has the rest. */
const POPOVER_LIMIT = 20;

type ListState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; items: NotificationItem[]; reference: Date };

/**
 * Calls `onChange` after each client navigation (a new path or search), not on the first render.
 * Render it inside a Suspense boundary, since it reads the search params.
 */
export function NotificationRouteWatcher({ onChange }: { onChange: () => void }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const route = `${pathname}?${search}`;
  const previous = useRef(route);
  useEffect(() => {
    if (previous.current === route) return;
    previous.current = route;
    onChange();
  }, [route, onChange]);
  return null;
}

/**
 * The bell's state for the app shell: the unread count, whether the popover is open, and its
 * content. Pass `refreshCount` to a NotificationRouteWatcher.
 */
export function useNotificationBell(initialUnread: number) {
  const [unread, setUnread] = useState(initialUnread);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [markingAll, setMarkingAll] = useState(false);
  // Only the latest request's answer is kept, so a slow older one can't overwrite a newer one.
  const countRequest = useRef(0);
  const listRequest = useRef(0);

  const refreshCount = useCallback(async () => {
    const request = ++countRequest.current;
    try {
      const result = await countUnreadNotificationsAction(null, {});
      if (result.ok && request === countRequest.current) setUnread(result.data);
    } catch {
      // The badge keeps its last count; the next navigation or focus tries again.
    }
  }, []);

  const loadList = useCallback(async () => {
    const request = ++listRequest.current;
    setList({ status: 'loading' });
    try {
      const result = await listNotificationsAction(null, { limit: POPOVER_LIMIT });
      if (request !== listRequest.current) return;
      setList(
        result.ok
          ? { status: 'ready', items: result.data.notifications, reference: now() }
          : { status: 'error' },
      );
    } catch {
      if (request === listRequest.current) setList({ status: 'error' });
    }
  }, []);

  // The window regains focus, or another screen marked notifications read.
  useEffect(() => {
    const refresh = () => void refreshCount();
    window.addEventListener('focus', refresh);
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, refresh);
    };
  }, [refreshCount]);

  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) {
        void refreshCount();
        void loadList();
      }
    },
    [refreshCount, loadList],
  );

  const openNotification = useOpenNotification({
    onMarked: (item) =>
      setList((current) =>
        current.status === 'ready'
          ? {
              ...current,
              items: current.items.map((candidate) =>
                candidate.id === item.id ? { ...candidate, readAt: now() } : candidate,
              ),
            }
          : current,
      ),
    onNavigate: () => setOpen(false),
  });

  async function markAllRead() {
    setMarkingAll(true);
    try {
      const result = await markAllNotificationsReadAction(null, {});
      if (result.ok) {
        const readAt = now();
        setUnread(0);
        setList((current) =>
          current.status === 'ready'
            ? {
                ...current,
                items: current.items.map((item) => ({ ...item, readAt: item.readAt ?? readAt })),
              }
            : current,
        );
      }
    } catch {
      // Nothing changed; the button can be pressed again.
    } finally {
      setMarkingAll(false);
      void refreshCount();
    }
  }

  const panel = (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center px-4 pt-4 pb-2">
        <h2 className="text-headline">Notifications</h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {list.status === 'loading' ? (
          <div role="status">
            <span className="sr-only">Loading notifications…</span>
            <NotificationRowsSkeleton />
          </div>
        ) : list.status === 'error' ? (
          <ErrorState
            variant="inline"
            headingLevel={3}
            title="Notifications couldn’t load"
            description="Check your connection, then try again."
            action={
              <Button variant="tinted" onClick={() => void loadList()}>
                Try again
              </Button>
            }
          />
        ) : list.items.length === 0 ? (
          <NotificationsEmpty variant="inline" headingLevel={3} />
        ) : (
          <ul className="flex flex-col divide-y divide-separator">
            {list.items.map((item) => (
              <li key={item.id}>
                <NotificationRow
                  item={item}
                  reference={list.reference}
                  onOpen={(target, event) => void openNotification(target, event)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-separator px-2 py-1">
        <Button
          variant="plain"
          disabled={unread === 0}
          loading={markingAll}
          onClick={() => void markAllRead()}
        >
          Mark all as read
        </Button>
        <Link
          href="/notifications"
          onClick={() => setOpen(false)}
          className={buttonVariants({ variant: 'plain', className: 'text-accent' })}
        >
          See all
        </Link>
      </footer>
    </div>
  );

  return { unread, open, onOpenChange, refreshCount, panel };
}
