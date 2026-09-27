'use client';

import type { ReactNode, Ref } from 'react';
import { Bell, ChevronRight, CircleHelp } from 'lucide-react';
import { cn } from '../lib/utils';
import { Button } from './button';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

export type ShellBreadcrumb = {
  /** The section the page belongs to, such as "Pulse Core" or "Modules". */
  parent?: string;
  /** The page title. */
  current: string;
};

/**
 * The top toolbar (DESIGN_SYSTEM.md › Pro-app layout): leading buttons, the breadcrumb, the command
 * bar trigger, and notification and help buttons. Wider screens always show the full breadcrumb.
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
  help,
  className,
}: {
  ref?: Ref<HTMLElement>;
  appName: string;
  breadcrumb: ShellBreadcrumb;
  titleInToolbar: boolean;
  leading?: ReactNode;
  commandBar: ReactNode;
  notifications: ReactNode;
  help: ReactNode;
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
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="plain" size="icon" aria-label="Notifications">
              <Bell aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent aria-label="Notifications">{notifications}</PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="plain" size="icon" aria-label="Help">
              <CircleHelp aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent aria-label="Help">{help}</PopoverContent>
        </Popover>
      </div>
    </header>
  );
}
