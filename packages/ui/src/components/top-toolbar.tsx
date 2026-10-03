'use client';

import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { Bell, ChevronRight, CircleHelp, CircleUserRound } from 'lucide-react';
import { cn } from '../lib/utils';
import { Button } from './button';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

/** Counts above this show as "99+" on the badge. */
const BADGE_MAX = 99;

/** The unread count as the badge shows it. */
export function formatUnreadBadge(count: number): string {
  return count > BADGE_MAX ? `${BADGE_MAX}+` : String(count);
}

/** The bell's accessible name: "Notifications", or "Notifications, 3 unread". */
export function notificationsLabel(unread: number): string {
  return unread > 0 ? `Notifications, ${unread} unread` : 'Notifications';
}

/**
 * Announces changes to the unread count (never the first count) in a polite live region: a
 * button's changed name isn't announced on its own.
 */
function UnreadAnnouncer({ unread }: { unread: number }) {
  const previous = useRef(unread);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (previous.current === unread) return;
    previous.current = unread;
    setMessage(
      unread === 0
        ? 'No unread notifications'
        : `${unread} unread notification${unread === 1 ? '' : 's'}`,
    );
  }, [unread]);
  return (
    <span role="status" aria-live="polite" className="sr-only">
      {message}
    </span>
  );
}

/**
 * The notifications button: a bell with an unread badge (the accent colour, never a semantic one;
 * hidden at 0, "99+" above 99) and a popover holding the list, which sets its own padding.
 */
function NotificationsButton({
  unread,
  open,
  onOpenChange,
  children,
}: {
  unread: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const count = Number.isFinite(unread) ? Math.max(0, Math.trunc(unread)) : 0;
  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="plain"
            size="icon"
            aria-label={notificationsLabel(count)}
            className="relative"
          >
            <Bell aria-hidden="true" />
            {count > 0 ? (
              <span
                aria-hidden="true"
                data-slot="notifications-badge"
                className={cn(
                  'pointer-events-none absolute top-1 right-0.5 flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1',
                  'bg-accent text-caption font-semibold text-accent-text numeric ring-2 ring-bg',
                )}
              >
                {formatUnreadBadge(count)}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          aria-label="Notifications"
          className="flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-96 flex-col overflow-hidden p-0"
        >
          {children}
        </PopoverContent>
      </Popover>
      <UnreadAnnouncer unread={count} />
    </>
  );
}

export type ShellBreadcrumb = {
  /** The section the page belongs to, such as "Pulse Core" or "Modules". */
  parent?: string;
  /** The page title. */
  current: string;
};

/**
 * The top toolbar (DESIGN_SYSTEM.md › Pro-app layout): leading buttons, the breadcrumb, the command
 * bar trigger, and notification, help and account buttons. Wider screens always show the full breadcrumb.
 * Phones show the app name until the page's large title scrolls under the toolbar, then the title.
 */
export function TopToolbar({
  ref,
  appName,
  breadcrumb,
  titleInToolbar,
  leading,
  commandBar,
  notifications,
  notificationsUnread = 0,
  notificationsOpen,
  onNotificationsOpenChange,
  help,
  account,
  className,
}: {
  ref?: Ref<HTMLElement>;
  appName: string;
  breadcrumb: ShellBreadcrumb;
  titleInToolbar: boolean;
  leading?: ReactNode;
  commandBar: ReactNode;
  /** The notifications popover's content. It sets its own padding and scrolls its own list. */
  notifications: ReactNode;
  /** The unread count for the bell's badge. */
  notificationsUnread?: number;
  /** Controls the notifications popover; leave undefined to let it manage itself. */
  notificationsOpen?: boolean;
  onNotificationsOpenChange?: (open: boolean) => void;
  help: ReactNode;
  /** The signed-in account's popover content; no account button when omitted. */
  account?: ReactNode;
  className?: string;
}) {
  const fade = 'transition-opacity duration-base';
  return (
    <header
      ref={ref}
      className={cn(
        'sticky top-0 z-30 flex h-16 items-center gap-1 px-2 glass-bar md:gap-3 md:px-4 lg:px-6',
        className,
      )}
    >
      {leading}
      <nav aria-label="Breadcrumb" className="min-w-0 flex-1 px-1 md:px-2">
        <ol className="flex min-w-0 items-center gap-1.5 text-subheadline">
          {breadcrumb.parent ? (
            <li className="hidden min-w-0 items-center gap-1.5 md:flex">
              <span className="truncate text-text-secondary">{breadcrumb.parent}</span>
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-text-secondary" />
            </li>
          ) : null}
          <li aria-current="page" className="grid min-w-0 flex-1 md:flex-none">
            <span
              className={cn(
                'col-start-1 row-start-1 truncate font-semibold text-text-primary',
                fade,
                // Phones swap the app name for the page title once the large title scrolls away.
                !titleInToolbar && 'opacity-0 md:opacity-100',
              )}
            >
              {breadcrumb.current}
            </span>
            <span
              aria-hidden="true"
              className={cn(
                'col-start-1 row-start-1 truncate text-headline md:hidden',
                fade,
                titleInToolbar && 'opacity-0',
              )}
            >
              {appName}
            </span>
          </li>
        </ol>
      </nav>
      {commandBar}
      <div className="flex shrink-0 items-center md:gap-1">
        <NotificationsButton
          unread={notificationsUnread}
          open={notificationsOpen}
          onOpenChange={onNotificationsOpenChange}
        >
          {notifications}
        </NotificationsButton>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="plain" size="icon" aria-label="Help">
              <CircleHelp aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent aria-label="Help">{help}</PopoverContent>
        </Popover>
        {account ? (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="plain" size="icon" aria-label="Account">
                <CircleUserRound aria-hidden="true" />
              </Button>
            </PopoverTrigger>
            <PopoverContent aria-label="Account">{account}</PopoverContent>
          </Popover>
        ) : null}
      </div>
    </header>
  );
}
